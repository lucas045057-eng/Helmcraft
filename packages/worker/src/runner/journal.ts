import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { RunEvent, RunId, TaskId } from '@agent-hub/protocol'
import type { Clock } from '@agent-hub/common'
import { aggregateRound } from '../harness/autofix.js'
import { trackProcessTree } from './kill-tree.js'
import { processStartTime } from './process-identity.js'
import { VerificationHolds } from './verification-holds.js'
import { ProjectOccupation } from '../personal/occupation.js'

type Finished = Extract<RunEvent, { kind: 'finished' }>
interface CliExited { round: number; verifyRequested: boolean; verifyAttempts: number; outcome: Omit<Finished, 'seq' | 'ts' | 'verification'> }
interface Entry { cliExited?: CliExited; runId: string; taskId: string; workspaceId: string; workspaceRoot?: string; pid?: number; pidStartTime?: string; processRole?: 'cli' | 'verify'; lastSeq?: number; finished?: Finished }
type RecordEntry =
  | ({ type: 'run.accepted' } & Omit<Entry, 'finished' | 'cliExited'>)
  | { type: 'run.process'; runId: string; pid: number; pidStartTime?: string; role: 'cli' | 'verify' }
  | ({ type: 'run.cli_exited'; runId: string } & CliExited)
  | { type: 'run.finished'; runId: string; finishedEvent: Finished }
  | { type: 'run.checkpoint'; runId: string; lastSeq: number }
  | { type: 'run.acked'; runId: string }
export class Journal {
  private readonly records = new Map<string, Entry>()
  readonly verificationHolds: VerificationHolds
  readonly projectOccupation: ProjectOccupation
  constructor(private readonly path: string, private readonly clock: Clock) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.verificationHolds = new VerificationHolds(path + '.verification.json')
    this.projectOccupation = new ProjectOccupation(path + '.project.json')
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as RecordEntry
        if (RunId.safeParse(entry.runId).success) this.apply(entry)
      } catch { /* A crash can leave a partial last write. */ }
    }
  }
  private apply(record: RecordEntry) {
    if (record.type === 'run.accepted' && TaskId.safeParse(record.taskId).success) this.records.set(record.runId, record)
    else if (record.type === 'run.process') {
      const entry = this.records.get(record.runId)
      if (entry && Number.isSafeInteger(record.pid) && record.pid > 0) {
        entry.pid = record.pid
        entry.processRole = record.role
        delete entry.pidStartTime
        if (record.pidStartTime) entry.pidStartTime = record.pidStartTime
      }
    } else if (record.type === 'run.cli_exited') {
      const entry = this.records.get(record.runId)
      const { round, verifyRequested, verifyAttempts, outcome } = record
      if (entry && Number.isInteger(round) && round >= 0 && round <= 2 && typeof verifyRequested === 'boolean' &&
        Number.isInteger(verifyAttempts) && verifyAttempts >= 0 && verifyAttempts <= 3 && outcome?.kind === 'finished' &&
        RunEvent.safeParse({ ...outcome, seq: 1, ts: 0 }).success) {
        const previous = entry.cliExited
        if (previous && round < previous.round) return
        entry.cliExited = { round, verifyRequested, verifyAttempts, outcome: previous?.round === round
          ? previous.outcome : aggregateRound(previous?.outcome, outcome) }
      }
    } else if (record.type === 'run.finished') {
      const entry = this.records.get(record.runId)
      const event = RunEvent.safeParse(record.finishedEvent)
      if (entry && event.success && event.data.kind === 'finished') entry.finished = event.data
    } else if (record.type === 'run.checkpoint') {
      const entry = this.records.get(record.runId)
      if (entry) entry.lastSeq = Math.max(entry.lastSeq ?? 0, record.lastSeq)
    } else if (record.type === 'run.acked') this.records.delete(record.runId)
  }
  private write(record: RecordEntry) {
    appendFileSync(this.path, JSON.stringify(record) + '\n', { mode: 0o600, flush: true })
    this.apply(record)
  }
  accepted(record: Omit<Entry, 'finished' | 'cliExited'>) { this.write({ ...record, type: 'run.accepted' }) }
  progress(runId: string, seq: number) { const entry = this.records.get(runId); if (entry && !entry.finished && seq > (entry.lastSeq ?? 0)) this.write({ type: 'run.checkpoint', runId, lastSeq: seq }) }
  process(record: Omit<Extract<RecordEntry, { type: 'run.process' }>, 'type'>) { this.write({ ...record, type: 'run.process' }) }
  cliExited(runId: string, exit: CliExited) { this.write({ type: 'run.cli_exited', runId, ...exit }) }
  finished(runId: string, event: Finished) { this.write({ type: 'run.finished', runId, finishedEvent: event }) }
  acked(runId: string) { this.write({ type: 'run.acked', runId }) }
  compact() {
    const records: RecordEntry[] = []
    for (const { finished, cliExited, ...entry } of this.records.values()) {
      records.push({ ...entry, type: 'run.accepted' })
      if (cliExited) records.push({ ...cliExited, type: 'run.cli_exited', runId: entry.runId })
      if (finished) records.push({ type: 'run.finished', runId: entry.runId, finishedEvent: finished })
    }
    writeFileSync(this.path + '.tmp', records.map(entry => JSON.stringify(entry) + '\n').join(''), { mode: 0o600, flush: true })
    renameSync(this.path + '.tmp', this.path)
  }
  async recover(onWarning?: (error: unknown) => void) {
    for (const entry of this.records.values()) {
      if (entry.finished) continue
      if (entry.processRole === 'verify' || (entry.cliExited?.verifyAttempts ?? 0) > 0) {
        // A legacy workspace ID may have been rebound since the crash. Only
        // trust the path from admission or the pre-spawn verification record.
        this.verificationHolds.recover(entry.runId, entry.workspaceId, entry.workspaceRoot)
      }
      if (entry.pid && entry.pid !== process.pid && entry.pidStartTime && processStartTime(entry.pid) === entry.pidStartTime) {
        try {
          const tree = trackProcessTree(entry.pid, { useJobObject: false, ...(onWarning && { onWarning }) })
          try { await tree.kill({ force: true }) } finally { tree.close() }
        } catch (error) { onWarning?.(error) }
      }
      if (entry.cliExited) {
        const { outcome, verifyRequested, verifyAttempts } = entry.cliExited
        const verification = outcome.status === 'succeeded'
          ? { status: 'unverified' as const, reason: 'WORKER_RESTARTED' as const, attempts: verifyAttempts, failed: [] }
          : { status: 'skipped' as const, reason: 'CLI_NOT_SUCCEEDED' as const, attempts: verifyAttempts, failed: [] }
        this.finished(entry.runId, { ...outcome, seq: (entry.lastSeq ?? 0) + 1, ts: this.clock.now(), ...(verifyRequested && { verification }) })
        continue
      }
      this.finished(entry.runId, { kind: 'finished', seq: (entry.lastSeq ?? 0) + 1, ts: this.clock.now(),
        status: 'failed', errorCode: 'WORKER_RESTARTED', exitCode: null, signal: null, summary: '', durationMs: 0 })
    }
    this.compact()
    return [...this.records.values()]
  }
}
