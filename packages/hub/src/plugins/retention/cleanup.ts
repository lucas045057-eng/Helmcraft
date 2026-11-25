import type { Repos, TaskStore } from '../../services/store.js'

export const dayMs = 86_400_000
const terminalRuns = "('succeeded','failed','timed_out','cancelled','refused','lost')"
const terminalTasks = "('succeeded','rejected','failed','timed_out','cancelled')"

export function purgeLogSlice(db: Repos, now: number, days: { succeeded: number; other: number }, limit: number) {
  const row = db.prepare(`SELECT r.id FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.logs_purged_at IS NULL AND r.status IN ${terminalRuns} AND r.finished_at < ?
      AND NOT EXISTS (SELECT 1 FROM personal_projects p WHERE p.plan_task_id=t.id AND p.phase NOT IN ('done','stopped'))
      AND r.finished_at < CASE WHEN t.status='succeeded' THEN ? ELSE ? END
    ORDER BY r.finished_at LIMIT 1`).get(now - Math.min(days.succeeded, days.other) * dayMs,
    now - days.succeeded * dayMs, now - days.other * dayMs) as { id: string } | undefined
  if (!row) return 0
  const deleted = db.prepare('DELETE FROM task_logs WHERE id IN (SELECT id FROM task_logs WHERE run_id=? LIMIT ?)').run(row.id, limit).changes
  if (deleted >= limit) return deleted
  const snapshots = db.prepare('DELETE FROM run_board_snapshots WHERE rowid IN (SELECT rowid FROM run_board_snapshots WHERE run_id=? AND NOT EXISTS (SELECT 1 FROM workspace_pointers WHERE last_attempt_run_id=? OR last_accepted_run_id=?) LIMIT ?)').run(row.id, row.id, row.id, limit - deleted).changes
  if (deleted + snapshots < limit) db.prepare('UPDATE task_runs SET logs_purged_at=? WHERE id=?').run(now, row.id)
  return deleted + snapshots
}

// Drain dependants first. A single old task can have more children than the entire slice budget.
function purgeTask(db: Repos, cutoff: number, limit: number) {
  const task = db.prepare(`SELECT t.id FROM tasks t WHERE t.finished_at < ? AND t.status IN ${terminalTasks}
    AND NOT EXISTS (SELECT 1 FROM personal_projects p WHERE p.plan_task_id=t.id AND p.phase NOT IN ('done','stopped'))
    AND NOT EXISTS (SELECT 1 FROM task_runs r WHERE r.task_id=t.id AND
      (r.logs_purged_at IS NULL OR r.finished_at IS NULL OR r.finished_at >= ? OR r.status NOT IN ${terminalRuns}))
    AND NOT EXISTS (SELECT 1 FROM input_requests i WHERE i.task_id=t.id AND i.created_at >= ?)
    ORDER BY t.finished_at LIMIT 1`).get(cutoff, cutoff, cutoff) as { id: string } | undefined
  if (!task) return 0
  let remaining = limit
  for (const table of ['input_requests', 'feishu_messages', 'task_runs']) {
    if (table === 'task_runs') {
      for (const prefix of ['last_attempt', 'last_accepted']) {
        const accepted = prefix === 'last_accepted' ? ', accepted_by=NULL, accepted_at=NULL' : ''
        db.prepare(`UPDATE workspace_pointers SET ${prefix}_run_id=NULL, ${prefix}_seq=NULL${accepted}
          WHERE ${prefix}_run_id IN (SELECT id FROM task_runs WHERE task_id=? LIMIT ?)`).run(task.id, remaining)
      }
    }
    remaining -= db.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE task_id=? LIMIT ?)`).run(task.id, remaining).changes
    if (remaining === 0) break
  }
  // Preserve referential integrity for task views during a multi-tick metadata purge.
  db.prepare('UPDATE tasks SET current_run_id=NULL WHERE id=? AND current_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_runs WHERE id=tasks.current_run_id)').run(task.id)
  if (remaining > 0) {
    const detached = db.prepare('UPDATE tasks SET parent_task_id=NULL WHERE rowid IN (SELECT rowid FROM tasks WHERE parent_task_id=? LIMIT ?)').run(task.id, remaining).changes
    if (detached < remaining) remaining -= db.prepare('DELETE FROM tasks WHERE id=?').run(task.id).changes
  }
  return limit - remaining
}

const auxiliary = [
  ['audit_logs', 'ts', 365], ['feishu_event_dedupe', 'received_at', 7], ['idempotency_keys', 'created_at', 1],
  ['dashboard_sessions', 'expires_at', 7], ['enroll_tokens', 'expires_at', 7],
] as const

export function incrementalVacuum(db: Repos, pages = 2000) {
  // SQLite PRAGMA incremental_vacuum(N) frees one page per sqlite3_step().
  // prepare().run() only steps once (1 page); db.pragma() drains all N pages.
  db.pragma('incremental_vacuum(' + Math.max(1, Math.floor(pages)) + ')')
}

export function cleanup(store: TaskStore, now: number, config: { sliceRows: number; retentionDays: { succeeded: number; other: number } }) {
  const { sliceRows, retentionDays } = config
  const factor = store.retention.storageLevel === 'ok' ? 1 : 0.5
  const days = { succeeded: retentionDays.succeeded * factor, other: retentionDays.other * factor }
  const metrics = store.retention
  metrics.retentionDeletedRowsTotal += store.tx(db => purgeLogSlice(db, now, days, sliceRows))
  metrics.retentionDeletedRowsTotal += store.tx(db => purgeTask(db, now - 365 * dayMs, sliceRows))
  for (const [table, column, days] of auxiliary) {
    metrics.retentionDeletedRowsTotal += store.repos.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`).run(now - days * dayMs, sliceRows).changes
  }
}
