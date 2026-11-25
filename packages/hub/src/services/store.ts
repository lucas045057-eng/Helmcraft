import type { repositories } from '../plugins/store-sqlite/repositories.js'
import type { Database } from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { RunEvent, StorageLevel } from '@agent-hub/protocol'
import type * as schema from '../plugins/store-sqlite/schema.js'

export type TaskRow = typeof schema.tasks.$inferSelect
export type RunRow = typeof schema.taskRuns.$inferSelect
export type WorkerRow = typeof schema.workers.$inferSelect
export type RunGap = { kind: 'gap'; seq: number; ts: number; toSeq: number; reason: 'hub_cap' | 'worker_evicted'; droppedBytes?: number }
export type StoredEvent = RunEvent | RunGap
export type Repos = BetterSQLite3Database<typeof schema> & ReturnType<typeof repositories> & { prepare: Database['prepare']; pragma: Database['pragma'] }
export interface LogIngestQueue {
  enqueue(runId: string, events: StoredEvent[], apply?: (repos: Repos, events: StoredEvent[]) => void): Promise<{ lastSeq: number }>
  flush(): Promise<void>
  readonly depth: number
  readonly metrics: { ingestDepth: number; ingestWaiters: number; hubTruncatedBytesTotal: number }
}
export interface RetentionMetrics {
  storageLevel: StorageLevel
  retentionDeletedRowsTotal: number
  lastBackupAt: number | null
}
export interface TaskStore {
  readonly retention: RetentionMetrics
  tx<T>(fn: (repos: Repos) => T): T
  readonly repos: Repos
  readonly ingest: LogIngestQueue
  health(): { ok: boolean; walSizeBytes: number; dbSizeBytes: number }
}
