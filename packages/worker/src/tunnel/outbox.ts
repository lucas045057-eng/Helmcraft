import { downgradeEvent } from '../harness/downgrade.js'
import { MIN_WORKER_WINDOW_BYTES } from '@agent-hub/protocol'
import type { RunEvent, RunResumeState, WorkerToHubFrame } from '@agent-hub/protocol'
import type { Clock } from '@agent-hub/common'
type Distribute<T> = T extends RunEvent ? Omit<T, 'seq' | 'ts'> : never
export type NewRunEvent = Distribute<RunEvent>
// Keep the original harness payload for replay after a differently negotiated reconnect.
type Stored = { event: RunEvent; original?: RunEvent; bytes: number }
type Drop = { lines: number; bytes: number; fromTs: number; toTs: number }
interface RunBuffer {
  taskId: string; lastSeq: number; sentSeq: number; acked: number; entries: Stored[]; buffered: number
  unsentBytes: number; unsentEvents: number
  drop?: Drop; finished?: number
}
export type OutboxFrame = Extract<WorkerToHubFrame, { type: 'run.events' | 'run.gap' }>
type Payload<T> = T extends OutboxFrame ? Pick<T, 'type' | 'payload'> : never
export type SendRunFrame = (frame: Payload<OutboxFrame>) => boolean
const highPriority = new Set(['started', 'session', 'input_request', 'finished', 'harness', 'workspace', 'verify', 'visual'])
const wireBytes = (event: RunEvent) => Buffer.byteLength(JSON.stringify(event)) + 192
function fitEvent(event: RunEvent, budget: number): RunEvent {
  if (wireBytes(event) <= budget) return event
  switch (event.kind) {
    case 'harness':
    case 'workspace': {
      const copy = structuredClone(event)
      const files = [...(copy.board?.files ?? [])].sort((a, b) => Buffer.byteLength(b.content ?? '') - Buffer.byteLength(a.content ?? ''))
      for (const file of files) {
        delete file.content
        if (wireBytes(copy) <= budget) return copy
      }
      if (copy.kind === 'workspace') {
        while (copy.changes?.sample.length && wireBytes(copy) > budget) {
          copy.changes.sample.length = Math.floor(copy.changes.sample.length / 2)
        }
        if (copy.tamper && wireBytes(copy) > budget) copy.tamper.paths = copy.tamper.paths.slice(0, 10)
      }
      return copy
    }
    case 'verify': {
      const copy = structuredClone(event)
      for (const result of copy.results ?? []) {
        delete result.tail
        if (wireBytes(copy) <= budget) break
      }
      // A legacy peer may advertise less than the current 64 KiB minimum.
      while (copy.results?.length && wireBytes(copy) > budget) copy.results.pop()
      return copy
    }
    case 'finished': {
      const result = { ...event }
      delete result.filesChanged
      delete result.usage
      delete result.errorMessage
      while (result.summary.length && wireBytes(result) > budget) {
        result.summary = result.summary.slice(0, Math.floor(result.summary.length / 2))
      }
      if (wireBytes(result) > budget) delete result.cliSessionId
      if (result.verification?.autoFix && wireBytes(result) > budget) {
        result.verification = { ...result.verification }
        delete result.verification.autoFix
      }
      return result
    }
    case 'started': return { ...event, commandSummary: event.commandSummary.slice(0, 96) }
    case 'input_request': {
      const result = { ...event }
      delete result.options
      while (result.question.length && wireBytes(result) > budget) {
        result.question = result.question.slice(0, Math.floor(result.question.length / 2))
      }
      return result
    }
    case 'log': {
      let text = event.text
      while (text.length && wireBytes({ ...event, text }) > budget) text = text.slice(0, Math.floor(text.length / 2))
      const truncatedBytes = (event.truncatedBytes ?? 0) + Buffer.byteLength(event.text) - Buffer.byteLength(text)
      return { ...event, text, truncatedBytes }
    }
    case 'visual': {
      const copy = structuredClone(event)
      for (const shot of copy.shots) {
        delete shot.imageBase64
        delete shot.mimeType
      }
      if (wireBytes(copy) <= budget) return copy
      for (const shot of copy.shots) {
        shot.consoleErrors = shot.consoleErrors.map(line => line.slice(0, 120))
        shot.pageErrors = shot.pageErrors.map(line => line.slice(0, 120))
      }
      while (wireBytes(copy) > budget && copy.shots.some(s => s.consoleErrors.length || s.pageErrors.length)) {
        for (const shot of copy.shots) {
          if (shot.consoleErrors.length) shot.consoleErrors.pop()
          else if (shot.pageErrors.length) shot.pageErrors.pop()
        }
      }
      return copy
    }
    default: return event
  }
}
function lossy(event: NewRunEvent) {
  return event.kind === 'log' || (event.kind === 'agent' && (event.event.type === 'thinking' ||
    (event.event.type === 'message' && !event.event.final)))
}

export class RunOutbox {
  private readonly runs = new Map<string, RunBuffer>()
  private capabilities: readonly string[] = []
  private send: SendRunFrame | undefined
  private maxFrameBytes = 1 << 20
  private maxInFlightBytes = 4 << 20
  private inFlightBytes = 0
  bufferedBytes = 0
  droppedLogBytesTotal = 0
  constructor(private readonly clock: Clock, private config: { runBufferBytes: number; totalBufferBytes: number },
    private readonly onFinishedAck: (runId: string) => void) {}
  updateLimits(config: { runBufferBytes: number; totalBufferBytes: number }) { this.config = config }
  register(id: string, taskId: string) {
    this.runs.set(id, { taskId, lastSeq: 0, sentSeq: 0, acked: 0, entries: [], buffered: 0, unsentBytes: 0, unsentEvents: 0 })
  }
  recover(id: string, taskId: string, event: Extract<RunEvent, {kind: 'finished'}>) {
    this.register(id, taskId)
    const run = this.runs.get(id)!
    run.lastSeq = event.seq - 1
    this.append(run, event)
  }
  push(id: string, input: NewRunEvent, beforeSend?: (event: RunEvent) => void) {
    const run = this.runs.get(id)
    if (!run || run.finished) return
    const now = this.clock.now()
    if (lossy(input)) {
      const droppedBytes = input.kind === 'log' ? Buffer.byteLength(input.text) : Buffer.byteLength(JSON.stringify(input))
      const estBytes = droppedBytes + 256
      if (run.buffered + estBytes > this.config.runBufferBytes || this.bufferedBytes + estBytes > this.config.totalBufferBytes) {
        run.drop ??= { lines: 0, bytes: 0, fromTs: now, toTs: now }
        run.drop.lines++
        run.drop.bytes += droppedBytes
        run.drop.toTs = now
        this.droppedLogBytesTotal += droppedBytes
        return
      }
    }
    if (input.kind === 'finished' || run.buffered < this.config.runBufferBytes / 2) this.recordDrop(run)
    const original: RunEvent = { ...input, seq: run.lastSeq + 1, ts: now }
    const event = fitEvent(original, this.frameBudget())
    const bytes = wireBytes(event)
    beforeSend?.(event)
    const replayable = original.kind === 'harness' || original.kind === 'workspace' || original.kind === 'verify' || original.kind === 'visual'
    this.append(run, event, bytes, replayable ? original : undefined)
    if (highPriority.has(event.kind) || run.unsentEvents === 200 ||
        (run.unsentBytes >= 64 * 1024 && run.unsentBytes - bytes < 64 * 1024)) this.flush()
    return event
  }
  private frameBudget() { return Math.min(this.maxFrameBytes - 64, this.maxInFlightBytes) }
  private recordDrop(run: RunBuffer) {
    if (!run.drop || run.finished) return
    this.append(run, { kind: 'dropped', seq: run.lastSeq + 1, ts: this.clock.now(), reason: 'backpressure', ...run.drop })
    delete run.drop
  }
  private append(run: RunBuffer, event: RunEvent, bytes = wireBytes(event), original?: RunEvent) {
    // A conservative share of the envelope keeps the byte window valid even for singleton frames.
    run.entries.push({ event, bytes, ...(original && { original }) })
    run.lastSeq = event.seq
    run.buffered += bytes
    run.unsentBytes += bytes
    run.unsentEvents++
    this.bufferedBytes += bytes
    if (event.kind === 'finished') run.finished = event.seq
  }
  describe(id: string, state: RunResumeState['state']): RunResumeState | undefined {
    const run = this.runs.get(id)
    return run && { runId: id, taskId: run.taskId, state, lastSeq: run.lastSeq, oldestBufferedSeq: run.entries[0]?.event.seq ?? 0 }
  }
  attach(send: SendRunFrame, maxFrameBytes: number, maxInFlightBytes: number, capabilities: readonly string[] = []) {
    this.capabilities = [...capabilities]
    this.send = send
    this.maxFrameBytes = maxFrameBytes
    this.maxInFlightBytes = maxInFlightBytes
    this.inFlightBytes = 0
    for (const run of this.runs.values()) {
      run.sentSeq = run.acked
      for (const entry of run.entries) {
        const event = fitEvent(entry.original ?? entry.event, this.frameBudget())
        if (event === entry.event) continue
        const bytes = wireBytes(event)
        run.buffered += bytes - entry.bytes
        this.bufferedBytes += bytes - entry.bytes
        entry.bytes = bytes
        entry.event = event
      }
      run.unsentBytes = run.buffered
      run.unsentEvents = run.entries.length
    }
  }
  detach() { this.send = undefined }
  discard(id: string) {
    const run = this.runs.get(id)
    if (!run) return
    this.inFlightBytes -= run.buffered - run.unsentBytes
    this.bufferedBytes -= run.buffered
    this.runs.delete(id)
    this.onFinishedAck(id)
  }
  ack(id: string, seq: number) {
    const run = this.runs.get(id)
    if (!run || seq < run.acked || seq > run.lastSeq) return
    run.acked = seq
    let count = 0
    for (const entry of run.entries) {
      if (entry.event.seq > seq) break
      count++
      if (entry.event.seq <= run.sentSeq) this.inFlightBytes -= entry.bytes
      else { run.unsentBytes -= entry.bytes; run.unsentEvents-- }
      run.buffered -= entry.bytes
      this.bufferedBytes -= entry.bytes
    }
    if (count) run.entries.splice(0, count)
    run.sentSeq = Math.max(run.sentSeq, seq)
    if (run.finished !== undefined && seq >= run.finished) this.discard(id)
    else if (run.buffered < this.config.runBufferBytes / 2 && this.bufferedBytes < this.config.totalBufferBytes / 2) this.recordDrop(run)
  }
  resend(id: string, fromSeq: number) {
    const run = this.runs.get(id)
    if (run && fromSeq <= run.lastSeq + 1 && fromSeq - 1 < run.sentSeq) {
      for (const entry of run.entries) {
        if (entry.event.seq > run.sentSeq) break
        if (entry.event.seq < fromSeq) continue
        this.inFlightBytes -= entry.bytes
        run.unsentBytes += entry.bytes
        run.unsentEvents++
      }
      run.sentSeq = fromSeq - 1
    }
    this.flush()
  }
  flush() {
    if (!this.send) return
    for (const [runId, run] of this.runs) {
      const oldest = run.entries[0]?.event.seq ?? run.lastSeq + 1
      if (run.sentSeq < oldest - 1) {
        if (!this.send({ type: 'run.gap', payload: { runId, fromSeq: run.sentSeq + 1, toSeq: oldest - 1 } })) return
        run.sentSeq = oldest - 1
      }
      const entries = run.entries.filter(entry => entry.event.seq > run.sentSeq)
      let batch: RunEvent[] = [], bytes = 0
      const sendBatch = () => {
        if (!batch.length) return true
        if (!this.send?.({ type: 'run.events', payload: { runId, taskId: run.taskId, events: batch } })) return false
        run.sentSeq = batch.at(-1)!.seq
        this.inFlightBytes += bytes
        run.unsentBytes -= bytes
        run.unsentEvents -= batch.length
        batch = []; bytes = 0
        return true
      }
      for (const entry of entries) {
        const limit = Math.min(this.frameBudget(), Math.max(MIN_WORKER_WINDOW_BYTES, entry.bytes))
        if (batch.length >= 200 || bytes + entry.bytes > limit) if (!sendBatch()) return
        if (entry.bytes > this.frameBudget()) {
          // Keep conclusions for replay if the negotiated frame cannot represent them.
          if (entry.event.kind === 'verify' || entry.event.kind === 'finished') break
          if (batch.length && !sendBatch()) return
          if (!this.send({ type: 'run.gap', payload: { runId, fromSeq: entry.event.seq, toSeq: entry.event.seq } })) return
          run.sentSeq = entry.event.seq
          this.inFlightBytes += entry.bytes
          run.unsentBytes -= entry.bytes
          run.unsentEvents--
          continue
        }
        if (this.inFlightBytes + bytes + entry.bytes > this.maxInFlightBytes) break
        batch.push(downgradeEvent(entry.event, this.capabilities))
        bytes += entry.bytes
      }
      if (!sendBatch()) return
    }
  }
}
