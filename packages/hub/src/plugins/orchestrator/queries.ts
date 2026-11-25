import { and, desc, eq, gte, inArray, like, lt, lte, or, sql } from 'drizzle-orm'
import { TaskStatus } from '@agent-hub/protocol'
import type { LogsQuery, LogsResponse, OverviewView, TaskListQuery, TaskListResponse, TaskView } from '@agent-hub/protocol'
import type { Repos, TaskRow } from '../../services/store.js'
import type { WorkerGateway } from '../../services/workers.js'
import { HubError } from '../../services/errors.js'
import { taskLogs, tasks } from '../store-sqlite/schema.js'
import { activeRunStatuses } from '../../services/workers.js'
import { findRun } from './views.js'

export function listTasks(db: Repos, query: TaskListQuery, view: (task: TaskRow) => TaskView): TaskListResponse {
  let cursor: { at: number; no: number } | undefined
  if (query.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) as typeof cursor
      if (!Number.isSafeInteger(cursor?.at) || !Number.isSafeInteger(cursor?.no)) throw new Error()
    } catch { throw new HubError('VALIDATION_FAILED', 400) }
  }
  const rows = db.select().from(tasks).where(and(
    query.status ? inArray(tasks.status, query.status) : undefined,
    query.adapter ? sql`coalesce(tasks.adapter, (select adapter from task_runs where task_id = tasks.id order by run_seq desc limit 1)) = ${query.adapter}` : undefined,
    query.workerId ? sql`(select worker_id from task_runs where task_id = tasks.id order by run_seq desc limit 1) = ${query.workerId}` : undefined,
    query.source ? eq(tasks.source, query.source) : undefined,
    query.requesterId ? eq(tasks.requesterId, query.requesterId) : undefined,
    query.parentTaskId ? eq(tasks.parentTaskId, query.parentTaskId) : undefined,
    query.q ? like(tasks.prompt, '%' + query.q + '%') : undefined,
    query.from !== undefined ? gte(tasks.createdAt, query.from) : undefined,
    query.to !== undefined ? lte(tasks.createdAt, query.to) : undefined,
    cursor ? or(lt(tasks.createdAt, cursor.at), and(eq(tasks.createdAt, cursor.at), lt(tasks.taskNo, cursor.no))) : undefined,
  )).orderBy(desc(tasks.createdAt), desc(tasks.taskNo)).limit(query.limit + 1).all()
  const more = rows.length > query.limit
  if (more) rows.pop()
  const last = rows.at(-1)
  return { items: rows.map(view), ...(more && last && { nextCursor: Buffer.from(
    JSON.stringify({ at: last.createdAt, no: last.taskNo })).toString('base64url') }) }
}

export function logs(db: Repos, taskId: string, id: string, query: LogsQuery): LogsResponse {
  const run = findRun(db, id)
  if (!run || run.taskId !== taskId) throw new HubError('RUN_NOT_FOUND', 404)
  const rows = db.select().from(taskLogs).where(and(eq(taskLogs.runId, id), or(sql`${taskLogs.seq} > ${query.afterSeq}`,
    and(eq(taskLogs.kind, 'gap'), sql`json_extract(${taskLogs.dataJson}, '$.toSeq') > ${query.afterSeq}`)),
  query.kinds ? inArray(taskLogs.kind, query.kinds) : undefined)).orderBy(taskLogs.seq).limit(query.limit + 1).all()
  const hasMore = rows.length > query.limit
  if (hasMore) rows.pop()
  return { entries: rows.map(row => ({ seq: row.seq, ts: row.ts, kind: row.kind, stream: row.stream, text: row.text,
    data: row.dataJson as LogsResponse['entries'][number]['data'] })), lastSeq: run.lastSeq, hasMore,
    runFinished: !activeRunStatuses.some(status => status === run.status) }
}

export function overview(db: Repos, gateway: WorkerGateway, now: number, draining: boolean, localDate: Intl.DateTimeFormat): OverviewView {
  const workers = gateway.list(), online = workers.filter(worker => worker.connection === 'online')
  const counts = Object.fromEntries(TaskStatus.options.map(status => [status, 0])) as OverviewView['counts']
  for (const row of db.select({ status: tasks.status, count: sql<number>`count(*)` }).from(tasks).groupBy(tasks.status).all()) counts[row.status] = row.count
  const today = localDate.format(now)
  let start = now - 36 * 3_600_000, end = now
  while (start < end) {
    const mid = start + Math.floor((end - start) / 2)
    if (localDate.format(mid) < today) start = mid + 1
    else end = mid
  }
  const recent = db.select().from(tasks).where(and(gte(tasks.finishedAt, start), lte(tasks.finishedAt, now))).all()
  const succeeded = recent.filter(task => task.status === 'succeeded').length
  const failed = recent.filter(task => task.status === 'failed' || task.status === 'timed_out').length
  const durations = recent.filter(task => task.startedAt !== null && task.finishedAt !== null)
    .map(task => task.finishedAt! - task.startedAt!).sort((a, b) => a - b)
  return { workersOnline: online.length, workersTotal: workers.length, slotsUsed: online.reduce((n, w) => n + w.slotsUsed, 0),
    slotsTotal: online.reduce((n, w) => n + w.maxConcurrency, 0), counts,
    today: { succeeded, failed, cancelled: recent.filter(task => task.status === 'cancelled').length,
      successRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
      p50DurationMs: durations[Math.ceil(durations.length * .5) - 1] ?? null,
      p90DurationMs: durations[Math.ceil(durations.length * .9) - 1] ?? null },
    feishu: { state: 'disabled', since: gateway.startedAt },
    hub: { bootId: gateway.bootId, startedAt: gateway.startedAt, version: '0.1.0', draining, restartRequired: false, configError: null },
  }
}
