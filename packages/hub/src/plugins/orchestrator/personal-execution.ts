import { createHash } from 'node:crypto'
import { PersonalBinding, PersonalItemExecution, PersonalPlanReceipt } from '@agent-hub/protocol'
import type { RunEvent } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos, RunRow } from '../../services/store.js'
import { verificationRecord } from './harness.js'

type Project = { id: string; phase: string; plan_json: string; sources_json: string; binding_json: string; active_ms: number; last_commit: string | null }
type Item = { item_id: string; ordinal: number; active_ms: number; status: string; review_rounds: number; rejects: number; unknown_rounds: number; repair_debug_calls: number; tested_json: string | null; commit_sha: string | null; remote_sha: string | null }
type Step = { project_id: string; item_id: string; task_id: string; run_id: string | null; result_json: string | null; kind: string; ordinal: number }
const hour = 3_600_000
const managed = (reason: string) => new HubError('INVALID_TRANSITION', 409, { reason })
export function executionStep(db: Repos, taskId: string) {
  return db.prepare('SELECT * FROM personal_steps WHERE task_id=?').get(taskId) as Step | undefined
}
export function blockProject(db: Repos, id: string, reason: string, now: number) {
  db.prepare("UPDATE personal_projects SET phase='blocked',reason=?,updated_at=? WHERE id=? AND phase NOT IN ('done','stopped','blocked')").run(reason, now, id)
  db.prepare("UPDATE personal_items SET status='blocked' WHERE project_id=? AND status IN ('implementing','verifying')").run(id)
}
export function occupied(db: Repos, workspace: string, worker?: string | null) {
  return !!db.prepare(`SELECT 1 FROM personal_projects WHERE phase NOT IN ('done','stopped')
    AND json_extract(binding_json,'$.workspaceId')=? AND (? IS NULL OR worker_id=?)`).get(workspace, worker ?? null, worker ?? null)
}
export function managedTask(db: Repos, task: string) {
  return db.prepare('SELECT 1 FROM personal_projects WHERE plan_task_id=? UNION ALL SELECT 1 FROM personal_steps WHERE task_id=? LIMIT 1').get(task, task)
}
export function projectExecution(db: Repos, id: string) {
  const project = db.prepare('SELECT * FROM personal_projects WHERE id=?').get(id) as Project | undefined
  const final = project && ['core_ready','verifying_final','final_ready','final_consulting','acceptance_ready'].includes(project.phase)
  const item = (final ? db.prepare('SELECT * FROM personal_items WHERE project_id=? ORDER BY ordinal DESC LIMIT 1') :
    db.prepare("SELECT * FROM personal_items WHERE project_id=? AND status!='delivered' ORDER BY ordinal LIMIT 1")).get(id) as Item | undefined
  if (!project || !item) throw managed('FIXED_ITEM_UNAVAILABLE')
  const plan = PersonalPlanReceipt.parse(JSON.parse(project.plan_json))
  const entry = plan.items[item.ordinal]
  if (entry?.id !== item.item_id || ((item.ordinal > 0 || final) && !project.last_commit)) throw managed('PLAN_STATE_CHANGED')
  if (final && db.prepare("SELECT 1 FROM personal_items WHERE project_id=? AND status!='delivered'").get(id)) throw managed('FINAL_ITEMS_INCOMPLETE')
  const execution = PersonalItemExecution.parse({ item: entry, first: item.ordinal === 0, sources: JSON.parse(project.sources_json),
    head: project.last_commit ?? plan.head, tasksDigest: plan.tasksDigest, checksDigest: plan.checksDigest, sourceDigest: plan.sourceDigest })
  const timeout = Math.min(30 * 60000, 4 * hour - item.active_ms, 24 * hour - project.active_ms)
  return { project, item, binding: PersonalBinding.parse(JSON.parse(project.binding_json)), execution, timeout }
}
export function beginImplementation(db: Repos, projectId: string, task: string, now: number) {
  const { project, item, timeout } = projectExecution(db, projectId)
  if (project.phase !== 'implementation_ready' || item.status !== 'pending' || timeout < 10000) throw managed('ITEM_NOT_READY')
  db.prepare("INSERT INTO personal_steps(project_id,item_id,kind,ordinal,task_id,created_at) VALUES(?,?,'implement',1,?,?)").run(projectId, item.item_id, task, now)
  db.prepare("UPDATE personal_projects SET phase='implementing',current_item=?,updated_at=? WHERE id=?").run(item.item_id, now, projectId)
  db.prepare("UPDATE personal_items SET status='implementing' WHERE project_id=? AND item_id=?").run(projectId, item.item_id)
}
export function finishImplementation(db: Repos, run: RunRow, event: Extract<RunEvent,{kind:'finished'}>, now: number) {
  const step = executionStep(db, run.taskId)
  if (!step || !['implement','repair'].includes(step.kind) || step.run_id !== run.id || step.result_json) return
  const result = JSON.stringify({ status: event.status, exitCode: event.exitCode, verification: event.verification ?? null,
    digest: event.personalResultDigest ?? null, candidate: event.testedCandidate, usage: event.usage ?? 'unknown', durationMs: event.durationMs })
  const elapsed = Math.max(0, event.durationMs)
  db.prepare('UPDATE personal_steps SET result_json=?,active_ms=? WHERE task_id=?').run(result, elapsed, run.taskId)
  db.prepare('UPDATE personal_items SET active_ms=active_ms+? WHERE project_id=? AND item_id=?').run(elapsed, step.project_id, step.item_id)
  db.prepare('UPDATE personal_projects SET active_ms=active_ms+?,updated_at=? WHERE id=?').run(elapsed, now, step.project_id)
  const { project, item, execution } = projectExecution(db, step.project_id)
  if (!['implementing','verifying'].includes(project.phase) || item.item_id !== step.item_id) return
  const expected = [...new Set(execution.item.checks)]
  const attempts = verificationRecord(run).attempts
  const results = attempts[0]?.results ?? []
  const tested = event.verification?.status === 'passed' && event.verification.attempts === 1 && attempts.length === 1 &&
    attempts[0]?.status === 'passed' && results.length === expected.length &&
    expected.every((id, i) => results[i]?.id === id && results[i]?.status === 'passed' && results[i]?.exitCode === 0)
  const complete = event.status === 'succeeded' && run.status === 'succeeded' && event.exitCode === 0 &&
    event.personalResultDigest === createHash('sha256').update(event.summary).digest('hex')
  const timeout = db.tasks.get(run.taskId)!.timeoutMs
  const reason = event.durationMs < 0 ? 'DURATION_UNKNOWN' : project.active_ms >= 24 * hour || item.active_ms >= 4 * hour || elapsed >= timeout ? 'TIME_BUDGET' :
    !complete ? 'IMPLEMENTATION_UNCONFIRMED' : !tested ? 'REQUIRED_CHECK_NOT_PASSED' : event.testedCandidate?.head !== execution.head ? 'TESTED_CANDIDATE_UNKNOWN' : null
  if (reason === 'REQUIRED_CHECK_NOT_PASSED' && event.verification?.status === 'failed' && attempts.length === 1 && attempts[0]?.status === 'failed' &&
      results.length === expected.length && results.every((r,i) => r.id === expected[i]) &&
      results.some(r => r.status === 'failed' && r.exitCode !== null && r.exitCode !== 0) &&
      results.every(r => r.status === 'passed' || r.status === 'failed' || r.status === 'not_run')) {
    db.prepare("UPDATE personal_projects SET phase='debug_ready',reason=?,updated_at=? WHERE id=?").run(reason,now,project.id)
    return
  }
  db.prepare('UPDATE personal_items SET status=?,tested_json=? WHERE project_id=? AND item_id=?').run(reason ? 'blocked' : 'awaiting_review',
    reason ? null : JSON.stringify(event.testedCandidate), project.id, item.item_id)
  db.prepare('UPDATE personal_projects SET phase=?,reason=?,updated_at=? WHERE id=?').run(reason ? 'blocked' : 'review_ready', reason, now, project.id)
}
