import { BOARD_HARD_CAP_BYTES, stripBoardContent } from '@agent-hub/protocol'
import type Database from 'better-sqlite3'
import { boundLogLine, createRedactor, Lru } from '@agent-hub/common'
import type { Repos, RunGap, StoredEvent, TaskStore, LogIngestQueue } from '../../services/store.js'

type Apply = (repos: Repos, events: StoredEvent[]) => void
interface Job {
  runId: string
  events: StoredEvent[]
  bytes: number
  apply?: Apply
  resolve(value: { lastSeq: number }): void
  reject(error: unknown): void
}
interface RunMeta { lastSeq: number; logBytes: number; logDroppedBytes: number; logTruncated: number; logsPurgedAt: number | null }
interface TailRow { seq: number; ts: number; kind: string; dataJson: unknown }
interface Stmts {
  selectRun: Database.Statement<[string], RunMeta>
  selectTail: Database.Statement<[string], { seq: number; ts: number; kind: string; dataJson: string | null }>
  insertLog: Database.Statement<[string, number, number, string, string | null, string | null, string | null, number]>
  updateGap: Database.Statement<[string, string, number]>
  updateRun: Database.Statement<[number, number, number, number, number | null, string]>
}
export interface IngestOptions { batchRows: number; maxQueueRows: number; maxBytesPerRun: number; redactionPatterns: string[] }
const maxQueueBytes = 64 << 20
type Redactor = ReturnType<typeof createRedactor>

export class IngestQueue implements LogIngestQueue {
  private jobs: Job[] = []
  private readonly waiting: Job[] = []
  private rows = 0
  private bytes = 0
  private waitingBytes = 0
  private patterns: string[]
  private readonly streams = new Lru<string, Redactor>(4096)
  private readonly stmts = new WeakMap<Repos, Stmts>()
  private truncatedBytes = 0
  constructor(private readonly store: Pick<TaskStore, 'tx' | 'retention'>, private options: IngestOptions) {
    this.patterns = options.redactionPatterns
  }
  get depth() { return this.rows }
  get metrics() { return { ingestDepth: this.rows, ingestWaiters: this.waiting.length, hubTruncatedBytesTotal: this.truncatedBytes } }
  configure(options: IngestOptions) {
    this.options = options
    if (this.patterns.join('\0') !== options.redactionPatterns.join('\0')) {
      this.patterns = options.redactionPatterns
      this.streams.clear()
    }
  }
  enqueue(runId: string, events: StoredEvent[], apply?: Apply): Promise<{ lastSeq: number }> {
    const bytes = Buffer.byteLength(JSON.stringify(events))
    return new Promise((resolve, reject) => {
      const job = { runId, events, bytes, resolve, reject, ...(apply && { apply }) }
      const stateful = events.some(event => event.kind !== 'log' && event.kind !== 'agent')
      if (this.waiting.length || !this.hasRoom(job)) {
        // Gateway reads a single frame per connection at a time while it awaits admission.
        if (this.waiting.length >= 256 || this.waitingBytes + bytes > maxQueueBytes) {
          reject(new Error('Ingest queue full'))
          return
        }
        this.waiting.push(job)
        this.waitingBytes += bytes
        if (stateful) void this.flush()
        return
      }
      this.admit(job)
      if (this.rows >= this.options.batchRows || stateful) void this.flush()
    })
  }
  private hasRoom(job: Job) {
    if (!this.jobs.length) return true // An individual validated frame retains its transaction boundary.
    return this.rows + job.events.length <= this.options.maxQueueRows && this.bytes + job.bytes <= maxQueueBytes
  }
  private admit(job: Job) {
    this.jobs.push(job)
    this.rows += job.events.length
    this.bytes += job.bytes
  }
  async flush(): Promise<void> {
    while (this.jobs.length || this.waiting.length) {
      while (this.waiting[0] && this.hasRoom(this.waiting[0])) {
        const job = this.waiting.shift()!
        this.waitingBytes -= job.bytes
        this.admit(job)
      }
      const jobs = this.jobs
      this.jobs = []
      this.rows = 0
      this.bytes = 0
      try {
        const results = this.store.tx(repos => jobs.map(job => this.write(repos, job)))
        for (const [index, job] of jobs.entries()) {
          this.truncatedBytes += results[index]!.truncated
          job.resolve({ lastSeq: results[index]!.lastSeq })
        }
      } catch (error) {
        for (const job of jobs) job.reject(error)
      }
    }
  }
  private statements(repos: Repos): Stmts {
    let cached = this.stmts.get(repos)
    if (!cached) {
      cached = {
        selectRun: repos.prepare('SELECT last_seq AS lastSeq, log_bytes AS logBytes, log_dropped_bytes AS logDroppedBytes, log_truncated AS logTruncated, logs_purged_at AS logsPurgedAt FROM task_runs WHERE id = ?') as Stmts['selectRun'],
        selectTail: repos.prepare('SELECT seq, ts, kind, data_json AS dataJson FROM task_logs WHERE run_id = ? ORDER BY seq DESC LIMIT 1') as Stmts['selectTail'],
        insertLog: repos.prepare('INSERT INTO task_logs (run_id, seq, ts, kind, stream, text, data_json, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, seq) DO NOTHING') as Stmts['insertLog'],
        updateGap: repos.prepare('UPDATE task_logs SET data_json = ? WHERE run_id = ? AND seq = ?') as Stmts['updateGap'],
        updateRun: repos.prepare('UPDATE task_runs SET last_seq = ?, log_bytes = ?, log_dropped_bytes = ?, log_truncated = ?, logs_purged_at = ? WHERE id = ?') as Stmts['updateRun'],
      }
      this.stmts.set(repos, cached)
    }
    return cached
  }
  private write(repos: Repos, job: Job): { lastSeq: number; truncated: number } {
    const stmt = this.statements(repos)
    const run = stmt.selectRun.get(job.runId)
    if (!run) throw new Error('Run not found')
    let lastSeq = run.lastSeq
    let logBytes = run.logBytes
    let logDroppedBytes = run.logDroppedBytes
    let logTruncated = Boolean(run.logTruncated)
    let truncated = 0
    const accepted: StoredEvent[] = []
    const rawTail = stmt.selectTail.get(job.runId)
    let tail: TailRow | undefined = rawTail
      ? { seq: rawTail.seq, ts: rawTail.ts, kind: rawTail.kind, dataJson: rawTail.dataJson ? JSON.parse(rawTail.dataJson) : null }
      : undefined
    const critical = this.store.retention.storageLevel === 'critical'
    for (const source of job.events) {
      if (source.seq <= lastSeq) continue
      if (source.seq !== lastSeq + 1) throw new Error('Non-contiguous run events')
      const event = this.scrubEvent(job.runId, source)
      const { seq, ts, kind, ...data } = stripBoardContent(event)
      const dataJson = event.kind === 'log' ? (event.truncatedBytes ? { truncatedBytes: event.truncatedBytes } : null) : data
      const dataText = dataJson === null ? null : JSON.stringify(dataJson)
      const bytes = (event.kind === 'log' ? Buffer.byteLength(event.text) : 0) +
        (dataText === null ? 0 : Buffer.byteLength(dataText))
      const runCap = logTruncated || logBytes + bytes > this.options.maxBytesPerRun
      if (event.kind === 'log' && (runCap || critical)) {
        const prior = tail?.dataJson as { reason?: string; toSeq?: number; droppedBytes?: number } | null | undefined
        const extended = tail?.kind === 'gap' && prior?.reason === 'hub_cap' && prior.toSeq === lastSeq
        const gap: RunGap = { kind: 'gap', seq: extended ? tail!.seq : event.seq, ts: extended ? tail!.ts : event.ts,
          reason: 'hub_cap', toSeq: event.seq, droppedBytes: (extended ? prior.droppedBytes ?? 0 : 0) + bytes }
        const { kind: gapKind, seq: gapSeq, ts: gapTs, ...gapData } = gap
        const gapText = JSON.stringify(gapData)
        if (extended) {
          stmt.updateGap.run(gapText, job.runId, gapSeq)
          tail = { ...tail!, dataJson: gapData }
        } else {
          stmt.insertLog.run(job.runId, gapSeq, gapTs, gapKind, null, null, gapText, 0)
          tail = { seq: gapSeq, ts: gapTs, kind: gapKind, dataJson: gapData }
        }
        const previous = accepted.at(-1)
        if (previous?.kind === 'gap' && previous.seq === gap.seq) accepted[accepted.length - 1] = gap
        else accepted.push(gap)
        logDroppedBytes += bytes
        truncated += bytes
        logTruncated = runCap
      } else {
        stmt.insertLog.run(job.runId, seq, ts, kind, event.kind === 'log' ? event.stream : null,
          event.kind === 'log' ? event.text : null, dataText, bytes)
        tail = { seq, ts, kind, dataJson }
        accepted.push(event)
        if (event.kind === 'dropped') logDroppedBytes += event.bytes
        logBytes += bytes
      }
      lastSeq = event.kind === 'gap' ? event.toSeq : event.seq
    }
    // A late frame for an expired Run must become eligible for bounded cleanup again.
    const purgedAt = accepted.length > 0 && run.logsPurgedAt !== null ? null : run.logsPurgedAt
    stmt.updateRun.run(lastSeq, logBytes, logDroppedBytes, logTruncated ? 1 : 0, purgedAt, job.runId)
    if (accepted.length) job.apply?.(repos, accepted)
    return { lastSeq, truncated }
  }
  private scrubEvent(runId: string, source: StoredEvent): StoredEvent {
    if (source.kind === 'log') {
      const key = runId + ':' + source.stream
      let redact = this.streams.get(key)
      if (!redact) { redact = createRedactor({}, this.patterns); this.streams.set(key, redact) }
      return { ...source, ...boundLogLine({ text: redact(source.text), ...(source.truncatedBytes && { truncatedBytes: source.truncatedBytes }) }, 16 << 10) }
    }
    const event = this.scrub(source, () => createRedactor({}, this.patterns)) as StoredEvent
    if (event.kind === 'harness' || event.kind === 'workspace') {
      for (const file of event.board?.files ?? []) {
        if (!file.content || Buffer.byteLength(file.content) <= BOARD_HARD_CAP_BYTES) continue
        const prefix = Buffer.from(file.content).subarray(0, BOARD_HARD_CAP_BYTES)
        file.content = prefix.subarray(0, prefix.lastIndexOf(10) + 1).toString('utf8')
        file.truncated = true
      }
    }
    return event
  }
  private scrub(value: unknown, makeRedactor: () => Redactor): unknown {
    if (typeof value === 'string') return makeRedactor()(value)
    if (Array.isArray(value)) return value.map(item => this.scrub(item, makeRedactor))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, typeof item === 'string' && ['kind', 'type', 'status', 'adapter', 'stream', 'reason', 'errorCode', 'requestId', 'cliSessionId',
        'sha256', 'file', 'dir', 'dirReason', 'phase', 'mode', 'board', 'inject', 'trust', 'runId'].includes(key)
        ? item : this.scrub(item, makeRedactor),
    ]))
    return value
  }
}
