import type { BoardSnapshot, ProjectOverview, WorkerView } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { pointerView } from './pointers.js'

type Activity = Pick<ProjectOverview, 'workerId' | 'workspaceId' | 'activeTasks' | 'totalTasks' | 'succeededTasks' |
  'failedTasks' | 'lastActiveAt' | 'latestTaskId' | 'latestTaskNo' | 'latestRunId' | 'latestAdapter' | 'latestVerification'>

const key = (workerId: string, workspaceId: string) => workerId + '/' + workspaceId

export function listProjects(db: Repos, workers: WorkerView[]): ProjectOverview[] {
  const pointers = new Map(db.pointers.list().map(row => [key(row.workerId, row.workspaceId), row]))
  const nodes = new Map(workers.map(worker => [worker.id, worker]))
  const workspaces = workers.flatMap(worker => worker.workspaces.map(ws => ({ worker, ws })))
  const declared = new Map(workspaces.map(entry => [key(entry.worker.id, entry.ws.id), entry]))
  const pairs = new Set([...declared.keys(), ...pointers.keys()])
  // A queued task with automatic scheduling belongs to a node only when its workspace is unambiguous.
  const uniqueOwners = new Map<string, string | null>()
  for (const { worker, ws } of workspaces) uniqueOwners.set(ws.id, uniqueOwners.has(ws.id) ? null : worker.id)
  const activity = db.prepare(`
    WITH owners AS (SELECT key, value FROM json_each(?)),
    attributed AS (
      SELECT coalesce(r.worker_id, t.required_worker_id, owners.value) AS workerId,
        coalesce(r.workspace_id, t.workspace_id) AS workspaceId, t.id AS latestTaskId, t.task_no AS latestTaskNo,
        r.id AS latestRunId, coalesce(r.adapter, t.adapter) AS latestAdapter, r.verification_status AS latestVerification,
        t.status, t.updated_at AS lastActiveAt
      FROM tasks t
      LEFT JOIN task_runs r ON r.id = (SELECT id FROM task_runs WHERE task_id = t.id ORDER BY run_seq DESC LIMIT 1)
      LEFT JOIN owners ON owners.key = t.workspace_id
    ), ranked AS (
      SELECT *, count(*) OVER project AS totalTasks,
        sum(status IN ('dispatching', 'running', 'awaiting_input', 'cancelling')) OVER project AS activeTasks,
        sum(status = 'succeeded') OVER project AS succeededTasks,
        sum(status IN ('failed', 'timed_out')) OVER project AS failedTasks,
        row_number() OVER (project ORDER BY lastActiveAt DESC, latestTaskNo DESC) AS position
      FROM attributed WINDOW project AS (PARTITION BY workerId, workspaceId)
    )
    SELECT workerId, workspaceId, latestTaskId, latestTaskNo, latestRunId, latestAdapter, latestVerification,
      lastActiveAt, totalTasks, activeTasks, succeededTasks, failedTasks FROM ranked WHERE position = 1
  `).all(JSON.stringify(Object.fromEntries(uniqueOwners))) as Activity[]
  const stats = new Map(activity.map(row => [key(row.workerId, row.workspaceId), row]))
  const projects: ProjectOverview[] = []
  for (const id of pairs) {
    const entry = declared.get(id)
    const pointer = pointers.get(id)
    const workerId = entry?.worker.id ?? pointer!.workerId
    const workspaceId = entry?.ws.id ?? pointer!.workspaceId
    const snapshot = db.snapshots.latestForWorkspace(workerId, workspaceId)
    projects.push({
      workerId, workspaceId, label: entry?.ws.label || workspaceId, isGitRepo: entry?.ws.isGitRepo ?? false,
      maxProfile: entry?.ws.maxProfile ?? 'readonly', allowedAdapters: entry?.ws.allowedAdapters ?? [],
      workerOnline: nodes.get(workerId)?.connection === 'online', pointer: pointer ? pointerView(db, pointer) : null,
      board: (snapshot?.snapshot as BoardSnapshot | undefined) ?? null, boardCapturedAt: snapshot?.capturedAt ?? null,
      activeTasks: 0, totalTasks: 0, succeededTasks: 0, failedTasks: 0, lastActiveAt: null,
      latestTaskId: null, latestTaskNo: null, latestAdapter: null, latestRunId: null, latestVerification: null,
      ...stats.get(id),
    })
  }
  return projects.sort((a, b) => Number(!!b.board) - Number(!!a.board) ||
    (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || a.label.localeCompare(b.label) || a.workerId.localeCompare(b.workerId))
}
