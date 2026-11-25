import type { Context } from 'cordis'
import type { DashServerFrame, LogEntry } from '@agent-hub/protocol'
import type { StoredEvent } from '../../services/store.js'
import { guardAsync } from '../../kernel/safe.js'

export function logEntryEnd(entry: LogEntry): number {
  const end = entry.kind === 'gap' && entry.data && typeof entry.data === 'object' && 'toSeq' in entry.data
    ? entry.data.toSeq : undefined
  return typeof end === 'number' ? end : entry.seq
}

function toEntry(event: StoredEvent): LogEntry {
  const { seq, ts, kind, ...data } = event
  return event.kind === 'log'
    ? { seq, ts, kind, stream: event.stream, text: event.text, data: event.truncatedBytes ? { truncatedBytes: event.truncatedBytes } : null }
    : { seq, ts, kind, stream: null, text: null, data: data as LogEntry['data'] }
}

interface Follow {
  cursor: number
  pending: LogEntry[]
  bytes: number
  catchingUp: boolean
  stopTimer?: () => void
}
type LogFrame = Extract<DashServerFrame, { t: 'logs' | 'logs.reset' | 'error' }>

export class LogFollows {
  private readonly follows = new Map<string, Follow>()
  bytes = 0
  constructor(private readonly ctx: Context, private readonly send: (frame: LogFrame) => Promise<boolean>,
    private readonly checkPressure: () => boolean) {}

  follow(runId: string, fromSeq: number) {
    if (!this.follows.has(runId) && this.follows.size >= 8) {
      void this.send({ t: 'error', code: 'RATE_LIMITED', message: '每条连接最多跟随 8 个 Run' })
      return
    }
    this.unfollow(runId)
    if (this.checkPressure()) {
      void this.send({ t: 'logs.reset', runId, reason: 'slow_consumer', resumeFromSeq: fromSeq })
      return
    }
    const follow: Follow = { cursor: fromSeq, pending: [], bytes: 0, catchingUp: true }
    this.follows.set(runId, follow)
    void guardAsync(this.ctx, this.catchUp(runId, follow).catch(error => {
      if (this.follows.get(runId) === follow) {
        this.unfollow(runId)
        void this.send({ t: 'logs.reset', runId, reason: 'server_restart', resumeFromSeq: follow.cursor })
      }
      throw error
    }), 'dashboard log follow')
  }

  private async catchUp(runId: string, follow: Follow) {
    const run = this.ctx.store.repos.runs.get(runId)
    if (!run) {
      this.unfollow(runId)
      void this.send({ t: 'logs.reset', runId, reason: 'run_not_found', resumeFromSeq: follow.cursor })
      return
    }
    while (this.follows.get(runId) === follow && follow.cursor < run.lastSeq) {
      const page = this.ctx.orchestrator.logs(run.taskId, runId, { afterSeq: follow.cursor, limit: 500 })
      if (!page.entries.length || !await this.flush(runId, follow, page.entries, false)) break
      if (!page.hasMore) break
    }
    if (this.follows.get(runId) !== follow) return
    follow.catchingUp = false
    this.flushLive(runId, follow)
  }

  append(runId: string, events: StoredEvent[]) {
    const follow = this.follows.get(runId)
    if (!follow) return
    for (const event of events) {
      const entry = toEntry(event)
      if (logEntryEnd(entry) <= follow.cursor) continue
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1
      follow.pending.push(entry)
      this.bytes += bytes
      follow.bytes += bytes
      if (this.checkPressure()) return
      if (!follow.catchingUp && (follow.pending.length >= 200 || follow.bytes >= 512 * 1024)) this.flushLive(runId, follow)
    }
    if (follow.catchingUp || !follow.pending.length || follow.stopTimer) return
    follow.stopTimer = this.ctx.clock.setInterval(() => this.flushLive(runId, follow), 100)
  }

  private flushLive(runId: string, follow: Follow) {
    follow.stopTimer?.()
    delete follow.stopTimer
    const entries = follow.pending
    follow.pending = []
    this.bytes -= follow.bytes
    follow.bytes = 0
    for (let i = 0; i < entries.length; i += 200) {
      if (this.follows.get(runId) !== follow) break
      void this.flush(runId, follow, entries.slice(i, i + 200), true)
    }
  }

  private async flush(runId: string, follow: Follow, entries: LogEntry[], live: boolean) {
    const send = (batch: LogEntry[], end: number) => {
      if (this.follows.get(runId) !== follow) return Promise.resolve(false)
      // Retain the previous cursor if enqueueing triggers a synchronous reset.
      const previous = follow.cursor
      const result = this.send({ t: 'logs', runId, entries: batch, live })
      if (this.follows.get(runId) === follow && follow.cursor === previous) follow.cursor = end
      return result
    }
    let end = follow.cursor
    let batch: LogEntry[] = []
    let bytes = 0
    for (const entry of entries) {
      const entryEnd = logEntryEnd(entry)
      if (entryEnd <= end) continue
      const next = entry.seq <= end ? { ...entry, seq: end + 1 } : entry
      const size = Buffer.byteLength(JSON.stringify(next)) + 1
      if (batch.length && bytes + size > 512 * 1024) {
        const written = send(batch, end)
        if (!live && !await written) return false
        batch = []
        bytes = 0
      }
      batch.push(next)
      bytes += size
      end = entryEnd
    }
    return !batch.length || send(batch, end)
  }

  unfollow(runId: string) {
    const follow = this.follows.get(runId)
    if (!follow) return
    follow.stopTimer?.()
    this.bytes -= follow.bytes
    this.follows.delete(runId)
  }

  reset(reason?: 'slow_consumer' | 'server_restart') {
    for (const [runId, follow] of this.follows) {
      this.unfollow(runId)
      if (reason) void this.send({ t: 'logs.reset', runId, reason, resumeFromSeq: follow.cursor })
    }
  }
}

