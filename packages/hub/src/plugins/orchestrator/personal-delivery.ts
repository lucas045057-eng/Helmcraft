import { createHash } from 'node:crypto'
import { DeliveryReceipt, DeliveryStep, PersonalDelivery, PersonalPlanReceipt, TestedCandidate } from '@agent-hub/protocol'
import type { RunEvent } from '@agent-hub/protocol'
import type { Repos, RunRow } from '../../services/store.js'
import { blockProject, executionStep, projectExecution } from './personal-execution.js'
import { verificationRecord } from './harness.js'

export const deliveryRoutes = {delivery_ready:['commit','committing'],push_ready:['push','pushing'],core_ready:['verify_final','verifying_final']} as const
export function deliveryAction(db: Repos, projectId: string, kind: PersonalDelivery['kind']) {
  const {project, item, execution} = projectExecution(db, projectId)
  const candidate = TestedCandidate.parse(JSON.parse(item.tested_json ?? 'null'))
  const final = kind === 'verify_final'
  if (final ? !item.commit_sha || item.commit_sha !== item.remote_sha || item.commit_sha !== execution.head :
    item.status !== 'reviewed' || candidate.head !== execution.head) throw new Error('DELIVERY_STATE_CHANGED')
  if (kind === 'commit' && item.commit_sha || kind !== 'commit' && !item.commit_sha) throw new Error('DELIVERY_COMMIT_UNKNOWN')
  if (final) {
    const plan = PersonalPlanReceipt.parse(JSON.parse(project.plan_json))
    execution.item.checks = [...new Set(plan.items.flatMap(i=>i.checks))]
  }
  return PersonalDelivery.parse({ kind, candidate, spec:execution, ...(item.commit_sha && {commit:item.commit_sha}) })
}
export function finishDelivery(db: Repos, run: RunRow, event: Extract<RunEvent,{kind:'finished'}>, now: number) {
  const step = executionStep(db,run.taskId)
  const parsed = DeliveryStep.safeParse(step?.kind)
  if (!step || !parsed.success || step.result_json || step.run_id !== run.id) return
  const kind = parsed.data, id = step.project_id
  const cost = Math.max(0,event.durationMs)
  db.prepare('UPDATE personal_steps SET result_json=?,active_ms=? WHERE task_id=?').run(JSON.stringify({
    summary:event.summary,status:event.status,verification:event.verification,usage:event.usage ?? 'unknown',
  }),cost,step.task_id)
  db.prepare('UPDATE personal_projects SET active_ms=active_ms+?,updated_at=? WHERE id=?').run(cost,now,id)
  db.prepare('UPDATE personal_items SET active_ms=active_ms+? WHERE project_id=? AND item_id=?').run(cost,id,step.item_id)
  const row = db.prepare('SELECT phase,current_item FROM personal_projects WHERE id=?').get(id) as {phase:string;current_item:string}
  const active = Object.values(deliveryRoutes).find(([k])=>k===kind)![1]
  if (row.phase !== active || row.current_item !== step.item_id) return
  try {
    const {project,item} = projectExecution(db,id)
    if (cost >= db.tasks.get(run.taskId)!.timeoutMs || event.durationMs < 0 || project.active_ms >= 86400000 || item.active_ms >= 14400000) throw new Error('TIME_BUDGET')
    const action = deliveryAction(db,id,kind)
    if (run.status !== 'succeeded' || event.status !== 'succeeded' || event.exitCode !== 0 ||
        event.personalResultDigest !== createHash('sha256').update(event.summary).digest('hex')) {
      throw new Error(/^[A-Z_]{1,80}$/u.test(event.summary) ? event.summary : 'DELIVERY_RESULT_UNKNOWN')
    }
    const r = DeliveryReceipt.parse(JSON.parse(event.summary))
    if (r.taskId !== step.task_id || r.runId !== run.id || r.itemId !== step.item_id || r.kind !== kind ||
        r.tree !== action.candidate.tree || r.parent !== action.candidate.head || r.commit === r.parent ||
        (kind !== 'commit' && (r.commit !== action.commit || r.remoteSha !== r.commit))) throw new Error('DELIVERY_RECEIPT_MISMATCH')
    let next: string
    if (kind === 'commit') {
      db.prepare('UPDATE personal_items SET commit_sha=? WHERE project_id=? AND item_id=?').run(r.commit,id,step.item_id)
      next='push_ready'
    } else if (kind === 'push') {
      db.prepare("UPDATE personal_items SET status='delivered',remote_sha=? WHERE project_id=? AND item_id=?").run(r.remoteSha,id,step.item_id)
      db.prepare('UPDATE personal_projects SET last_commit=? WHERE id=?').run(r.commit,id)
      next=db.prepare("SELECT 1 FROM personal_items WHERE project_id=? AND status!='delivered'").get(id) ? 'implementation_ready' : 'core_ready'
    } else {
      const attempts=verificationRecord(run).attempts
      const results=attempts[0]?.results ?? []
      const checks=action.spec.item.checks
      if (event.verification?.status !== 'passed' || attempts.length !== 1 || attempts[0]?.status !== 'passed' ||
          results.length !== checks.length || !results.every((r,i)=>r.id===checks[i] && r.status==='passed' && r.exitCode===0)) throw new Error('FINAL_CHECKS_NOT_PASSED')
      next='final_ready'
    }
    db.prepare('UPDATE personal_projects SET phase=?,reason=NULL,updated_at=? WHERE id=?').run(next,now,id)
  } catch (error) {
    blockProject(db,id,error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : 'DELIVERY_RESULT_UNKNOWN',now)
  }
}
