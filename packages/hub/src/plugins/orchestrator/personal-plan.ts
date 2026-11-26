import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PersonalPlanReceipt } from '@agent-hub/protocol'
import type { PersonalPlanRequest, RunEvent } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { HubError } from '../../services/errors.js'

type PlanRow = { id: string; binding_json: string; sources_json: string; plan_task_id: string; phase: string; subdir: string | null; mode: string; options_json: string | null }
export function findPlanningTask(db: Repos, id: string) {
  return db.prepare('SELECT id,binding_json,sources_json,plan_task_id,phase,subdir,mode,options_json FROM personal_projects WHERE plan_task_id=?').get(id) as PlanRow | undefined
}
export function existingPlan(db: Repos, input: PersonalPlanRequest) {
  const row = db.prepare('SELECT binding_json,sources_json,plan_task_id,options_json FROM personal_projects WHERE id=?').get(input.projectId) as PlanRow | undefined
  if (row) {
    const mode = input.binding.mode ?? 'strict'
    const normalizedInputOptions = {
      ...(input.inlinePrompt !== undefined && { inlinePrompt: input.inlinePrompt }),
      ...(input.boardContext !== undefined && { boardContext: input.boardContext }),
      ...(input.methodBlock !== undefined && { methodBlock: input.methodBlock }),
      ...(input.noChecks && { noChecks: true }),
      ...(input.notifyFeishuChatId && { notifyFeishuChatId: input.notifyFeishuChatId }),
      autoCommit: input.binding.autoCommit ?? true,
      autoPush: input.binding.autoPush ?? (mode === 'strict'),
    }
    const existingOptions = row.options_json ? JSON.parse(row.options_json) : { autoCommit: true, autoPush: mode === 'strict' }
    if (!isDeepStrictEqual(JSON.parse(row.binding_json), input.binding) ||
        !isDeepStrictEqual(JSON.parse(row.sources_json), input.sources) ||
        !isDeepStrictEqual(existingOptions, normalizedInputOptions)) {
      throw new HubError('IDEMPOTENCY_MISMATCH', 409)
    }
    return row.plan_task_id
  }
  if (db.prepare("SELECT 1 FROM personal_projects WHERE worker_id=? AND root=? AND phase NOT IN ('done','stopped')").get(input.binding.workerId, input.binding.root)) {
    throw new HubError('INVALID_TRANSITION', 409, { reason: 'PROJECT_OCCUPIED' })
  }
}

export function recordPlanningTask(db: Repos, input: PersonalPlanRequest, taskId: string, now: number) {
  const mode = input.binding.mode ?? 'strict'
  const options = {
    ...(input.inlinePrompt !== undefined && { inlinePrompt: input.inlinePrompt }),
    ...(input.boardContext !== undefined && { boardContext: input.boardContext }),
    ...(input.methodBlock !== undefined && { methodBlock: input.methodBlock }),
    ...(input.noChecks && { noChecks: true }),
    ...(input.notifyFeishuChatId && { notifyFeishuChatId: input.notifyFeishuChatId }),
    autoCommit: input.binding.autoCommit ?? true,
    autoPush: input.binding.autoPush ?? (mode === 'strict'),
  }
  db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,updated_at,subdir,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(input.projectId, input.binding.workerId, input.binding.root, JSON.stringify(input.binding), JSON.stringify(input.sources), taskId, now,
      input.binding.subdir ?? null, mode, JSON.stringify(options))
}

// Called inside the existing run-event ingest transaction after Run/Task correlation.
export function recordPlanResult(db: Repos, taskId: string, runId: string, event: Extract<RunEvent, { kind: 'finished' }>, now: number) {
  const project = findPlanningTask(db, taskId)
  if (!project) return
  if (project.phase !== 'planning') {
    db.prepare("UPDATE personal_projects SET plan_run_id=?,plan_finished=1,active_ms=active_ms+?,updated_at=? WHERE id=? AND phase='blocked' AND plan_finished=0")
      .run(runId, Math.max(0, event.durationMs), now, project.id)
    return
  }
  let receipt: PersonalPlanReceipt | undefined
  if (event.status === 'succeeded' && event.exitCode === 0 && event.personalResultDigest === createHash('sha256').update(event.summary).digest('hex')) {
    try {
      const parsed = PersonalPlanReceipt.parse(JSON.parse(event.summary))
      if (parsed.checksDigestVersion === 2) receipt = parsed
    } catch { /* Preserve invalid evidence as a blocked result. */ }
  }
  if (receipt) {
    const insert = db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json) VALUES(?,?,?,?)')
    receipt.items.forEach((item, i) => insert.run(project.id, item.id, i, JSON.stringify(item)))
  }
  db.prepare('UPDATE personal_projects SET phase=?,reason=?,plan_json=?,plan_run_id=?,plan_finished=1,active_ms=active_ms+?,updated_at=? WHERE id=?')
    .run(receipt ? 'plan_ready' : 'blocked', receipt ? null : 'PLAN_UNCONFIRMED', receipt ? JSON.stringify(receipt) : null,
      runId, Math.max(0, event.durationMs), now, project.id)
}
