import { projectOf } from '@agent-hub/protocol'
import type { BoardSnapshot, ProjectOverview, WorkerView } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { pointerView } from './pointers.js'

type Activity = Pick<ProjectOverview, 'workerId' | 'workspaceId' | 'activeTasks' | 'totalTasks' | 'succeededTasks' |
  'failedTasks' | 'lastActiveAt' | 'latestTaskId' | 'latestTaskNo' | 'latestRunId' | 'latestAdapter' | 'latestVerification'>

const key = (workerId: string, workspaceId: string) => workerId + '/' + workspaceId

const boardOf = (snapshot: { snapshot: unknown; capturedAt: number } | undefined) =>
  ({ board: (snapshot?.snapshot as BoardSnapshot | undefined) ?? null, boardCapturedAt: snapshot?.capturedAt ?? null })

export function listProjects(db: Repos, workers: WorkerView[]): ProjectOverview[] {
  const pointers = new Map(db.pointers.list().map(row => [key(row.workerId, row.workspaceId), row]))
  const nodes = new Map(workers.map(worker => [worker.id, worker]))
  const workspaces = workers.flatMap(worker => worker.workspaces.map(ws => ({ worker, ws })))
  const declared = new Map(workspaces.map(entry => [key(entry.worker.id, entry.ws.id), entry]))
  const pairs = new Set([...declared.keys(), ...pointers.keys()])
  // A queued task with automatic scheduling belongs to a node only when its workspace is unambiguous.
  const uniqueOwners = new Map<string, string | null>()
  for (const { worker, ws } of workspaces) uniqueOwners.set(ws.id, uniqueOwners.has(ws.id) ? null : worker.id)
  const sql = (partition: string) => `
    WITH owners AS (SELECT key, value FROM json_each(?)),
    attributed AS (
      SELECT coalesce(r.worker_id, t.required_worker_id, owners.value) AS workerId,
        coalesce(r.workspace_id, t.workspace_id) AS workspaceId, t.id AS latestTaskId, t.task_no AS latestTaskNo,
        r.id AS latestRunId, coalesce(r.adapter, t.adapter) AS latestAdapter, r.verification_status AS latestVerification,
        t.status, t.updated_at AS lastActiveAt, t.subdir AS subdir
      FROM tasks t
      LEFT JOIN task_runs r ON r.id = (SELECT id FROM task_runs WHERE task_id = t.id ORDER BY run_seq DESC LIMIT 1)
      LEFT JOIN owners ON owners.key = t.workspace_id
    ), ranked AS (
      SELECT *, count(*) OVER project AS totalTasks,
        sum(status IN ('dispatching', 'running', 'awaiting_input', 'cancelling')) OVER project AS activeTasks,
        sum(status = 'succeeded') OVER project AS succeededTasks,
        sum(status IN ('failed', 'timed_out')) OVER project AS failedTasks,
        row_number() OVER (project ORDER BY lastActiveAt DESC, latestTaskNo DESC) AS position
      FROM attributed WINDOW project AS (PARTITION BY ${partition})
    )
    SELECT workerId, workspaceId, subdir, latestTaskId, latestTaskNo, latestRunId, latestAdapter, latestVerification,
      lastActiveAt, totalTasks, activeTasks, succeededTasks, failedTasks FROM ranked WHERE position = 1
  `
  const owners = JSON.stringify(Object.fromEntries(uniqueOwners))
  const strip = (row: Activity & { subdir: string | null }): Activity => { const { subdir, ...rest } = row; void subdir; return rest }
  const activity = (db.prepare(sql('workerId, workspaceId')).all(owners) as (Activity & { subdir: string | null })[]).map(strip)
  const stats = new Map(activity.map(row => [key(row.workerId, row.workspaceId), row]))
  // 子项目：同一项目的多种 subdir 写法（Forma、Forma/src）合并计数，"最近一次"取最新的那组
  const subStats = new Map<string, Activity>()
  for (const row of db.prepare(sql('workerId, workspaceId, subdir')).all(owners) as (Activity & { subdir: string | null })[]) {
    const project = projectOf(row.subdir)
    if (!project) continue
    const id = key(row.workerId, row.workspaceId) + '/' + project, seen = subStats.get(id), next = strip(row)
    if (!seen) { subStats.set(id, next); continue }
    const newer = (next.lastActiveAt ?? 0) > (seen.lastActiveAt ?? 0) ? next : seen
    subStats.set(id, { ...newer, totalTasks: seen.totalTasks + next.totalTasks, activeTasks: seen.activeTasks + next.activeTasks,
      succeededTasks: seen.succeededTasks + next.succeededTasks, failedTasks: seen.failedTasks + next.failedTasks })
  }
  const projects: ProjectOverview[] = []
  for (const id of pairs) {
    const entry = declared.get(id)
    const pointer = pointers.get(id)
    const workerId = entry?.worker.id ?? pointer!.workerId
    const workspaceId = entry?.ws.id ?? pointer!.workspaceId
    projects.push({
      workerId, workspaceId, label: entry?.ws.label || workspaceId, isGitRepo: entry?.ws.isGitRepo ?? false,
      maxProfile: entry?.ws.maxProfile ?? 'readonly', allowedAdapters: entry?.ws.allowedAdapters ?? [],
      workerOnline: nodes.get(workerId)?.connection === 'online', pointer: pointer ? pointerView(db, pointer) : null,
      ...boardOf(db.snapshots.latestForWorkspace(workerId, workspaceId)),
      activeTasks: 0, totalTasks: 0, succeededTasks: 0, failedTasks: 0, lastActiveAt: null,
      latestTaskId: null, latestTaskNo: null, latestAdapter: null, latestRunId: null, latestVerification: null,
      ...stats.get(id),
    })
    for (const sub of entry?.ws.projects ?? []) projects.push({
      workerId, workspaceId, subdir: sub.dir, label: sub.dir, isGitRepo: sub.isGitRepo,
      maxProfile: entry!.ws.maxProfile, allowedAdapters: entry!.ws.allowedAdapters,
      workerOnline: nodes.get(workerId)?.connection === 'online', pointer: null,
      activeTasks: 0, totalTasks: 0, succeededTasks: 0, failedTasks: 0, lastActiveAt: null,
      latestTaskId: null, latestTaskNo: null, latestAdapter: null, latestRunId: null, latestVerification: null,
      ...subStats.get(id + '/' + sub.dir),
      ...boardOf(db.snapshots.latestForWorkspace(workerId, workspaceId, sub.dir)),
    })
  }
  return projects.sort((a, b) => Number(!!b.board) - Number(!!a.board) ||
    (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.label.localeCompare(b.label) || a.workerId.localeCompare(b.workerId))
}
