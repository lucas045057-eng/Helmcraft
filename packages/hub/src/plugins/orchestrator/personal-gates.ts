import { createHash } from 'node:crypto'
import { AdvisorJudgment, DebugJudgment, GateReceipt, personalRoleSettings, ReviewJudgment } from '@agent-hub/protocol'
import type { PersonalGateKind, RunDispatch, RunEvent } from '@agent-hub/protocol'
import type { Repos, RunRow } from '../../services/store.js'
import { verificationRecord } from './harness.js'
import { blockProject, executionStep, projectExecution } from './personal-execution.js'

type Kind = PersonalGateKind | 'repair'
const gates = {
  plan_ready: ['PLAN_READY','plan_consulting'], review_ready: ['review','reviewing'],
  debug_ready: ['debug','diagnosing'], repair_ready: ['repair','implementing'],
  reject_advice_ready: ['REVIEW_REJECTED_TWICE','reject_consulting'],
  debug_advice_ready: ['DEBUG_NO_ROOT_CAUSE_TWICE','debug_consulting'], final_ready: ['FINAL_READY','final_consulting'],
} as const
export const gatePhases = Object.keys(gates)
const activePhase = (kind: string) => Object.values(gates).find(([k]) => k===kind)?.[1]
export function stepCanDispatch(kind: string, phase: string) {
  return phase === (kind === 'implement' ? 'implementing' : activePhase(kind))
}

function priorEvidence(db: Repos, project: string, item: string) {
  const prior = db.prepare('SELECT kind,ordinal,task_id,run_id,result_json FROM personal_steps WHERE project_id=? AND item_id=? ORDER BY created_at,rowid').all(project,item) as
    {kind:string; ordinal:number; task_id:string; run_id:string|null; result_json:string|null}[]
  return prior.map(s => {
    const run = s.run_id ? db.runs.get(s.run_id) : undefined
    return { kind:s.kind, ordinal:s.ordinal, task:s.task_id, run:s.run_id, result:s.result_json && JSON.parse(s.result_json),
      ...(run && ['implement','repair'].includes(s.kind) && { summary:run.summary, checks:verificationRecord(run).attempts }) }
  })
}
export function prepareGate(db: Repos, id: string) {
  const {project,item,binding,execution,timeout} = projectExecution(db,id)
  const route = gates[project.phase as keyof typeof gates]
  if (!route) throw new Error('UNEXPECTED_GATE_PHASE')
  const [kind,active] = route
  const ordinal = Number(db.prepare('SELECT count(*) FROM personal_steps WHERE project_id=? AND item_id=? AND kind=?').pluck().get(id,item.item_id,kind)) + 1
  if (kind === 'review' && item.review_rounds >= 5 || ['repair','debug'].includes(kind) && item.repair_debug_calls >= 8) throw new Error('ITEM_CALL_LIMIT')
  if (['PLAN_READY','FINAL_READY','REVIEW_REJECTED_TWICE'].includes(kind) && ordinal !== 1) throw new Error('TRIGGER_ALREADY_RECORDED')
  const role = kind === 'review' ? 'reviewer' : kind === 'repair' || kind === 'debug' ? 'main' : 'advisor'
  const target = personalRoleSettings[role]
  const limit = Math.min(timeout, (role === 'main' ? 30 : role === 'reviewer' ? 20 : 15) * 60000)
  if (limit < 10000) throw new Error('TIME_BUDGET')
  const history = priorEvidence(db,id,item.item_id)
  const request = kind === 'repair' ? 'Implement the minimal repair using these findings and checks. Preserve the fixed plan and requirements. Leave commit and push to delivery.' :
    'Evaluate only the current requirements and complete evidence. Return the requested structured result.'
  const finalItems = kind === 'FINAL_READY' ? (db.prepare('SELECT item_id,status FROM personal_items WHERE project_id=? ORDER BY ordinal').all(id) as
    {item_id:string;status:string}[]).map(row=>({...row,evidence:priorEvidence(db,id,row.item_id)})) : undefined
  const prompt = [request,JSON.stringify({project:id,item:execution.item,kind,ordinal,head:execution.head,
    history:finalItems ? undefined : history,finalItems})].join('\n')
  if (Buffer.byteLength(prompt) > 80000) throw new Error('ROLE_INPUT_TOO_LARGE')
  return {id,kind,active,ordinal,item:item.item_id,role,input:{ prompt, adapter:target.adapter,model:target.model,profile:target.profile,
    workspaceId:binding.workspaceId,requiredWorkerId:binding.workerId,timeoutMs:limit }}
}

export function planAdvice(db: Repos, projectId: string) {
  const record = db.prepare("SELECT result_json FROM personal_steps WHERE project_id=? AND kind='PLAN_READY'").pluck().get(projectId)
  if (!record) return undefined
  const receipt = GateReceipt.parse(JSON.parse(JSON.parse(String(record)).summary))
  return AdvisorJudgment.parse(receipt.judgment).advice
}
export function beginGate(db: Repos, id: string, taskId: string, now: number) {
  const g=prepareGate(db,id)
  db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,created_at) VALUES(?,?,?,?,?,?)').run(taskId,id,g.item,g.kind,g.ordinal,now)
  db.prepare('UPDATE personal_projects SET phase=?,current_item=?,reason=NULL,updated_at=? WHERE id=?').run(g.active,g.item,now,id)
  if (g.kind === 'debug' || g.kind === 'repair') db.prepare('UPDATE personal_items SET repair_debug_calls=repair_debug_calls+1,status=? WHERE project_id=? AND item_id=?')
    .run(g.active,id,g.item)
}

export function personalDispatch(db: Repos, step: NonNullable<ReturnType<typeof executionStep>>): NonNullable<RunDispatch['personal']> {
  const {binding,execution} = projectExecution(db,step.project_id)
  const base = {projectId:step.project_id,binding}
  if (step.kind === 'implement' || step.kind === 'repair') return {...base,role:'main',execution,...(step.kind === 'repair' && {repair:true as const})}
  const kind = step.kind as PersonalGateKind
  return {...base,role:kind==='review'?'reviewer':kind==='debug'?'main':'advisor',gate:{kind,ordinal:step.ordinal,spec:execution}}
}

export function nextGate(kind: Kind, receipt: GateReceipt, counts: {review_rounds:number;rejects:number;unknown_rounds:number}) {
  if (kind === 'review') {
    const {decision} = ReviewJudgment.parse(receipt.judgment)
    if (decision === 'PASS') return 'delivery_ready'
    if (counts.review_rounds + 1 >= 5) return 'REVIEW_LIMIT'
    return counts.rejects + 1 === 2 ? 'reject_advice_ready' : 'repair_ready'
  }
  if (kind === 'debug') {
    if (DebugJudgment.parse(receipt.judgment).located) return 'repair_ready'
    return counts.unknown_rounds + 1 >= 2 ? 'debug_advice_ready' : 'debug_ready'
  }
  const advice = AdvisorJudgment.parse(receipt.judgment)
  if (kind === 'PLAN_READY' || kind === 'FINAL_READY') return advice.assessment === 'concern' ? 'ADVISOR_CONCERN' :
    kind === 'PLAN_READY' ? 'implementation_ready' : 'acceptance_ready'
  return kind === 'REVIEW_REJECTED_TWICE' ? 'repair_ready' : 'debug_ready'
}

export function finishGate(db: Repos, run: RunRow, event: Extract<RunEvent,{kind:'finished'}>, now: number) {
  const step = executionStep(db,run.taskId)
  if (!step || ['implement','repair'].includes(step.kind) || step.run_id !== run.id || step.result_json) return
  const id = step.project_id, itemId = step.item_id, elapsed = Math.max(0,event.durationMs)
  db.prepare('UPDATE personal_steps SET result_json=?,active_ms=? WHERE task_id=?').run(JSON.stringify({
    summary:event.summary, digest:event.personalResultDigest, usage:event.usage ?? 'unknown', status:event.status, exitCode:event.exitCode
  }),elapsed,run.taskId)
  db.prepare('UPDATE personal_items SET active_ms=active_ms+? WHERE project_id=? AND item_id=?').run(elapsed,id,itemId)
  db.prepare('UPDATE personal_projects SET active_ms=active_ms+?,updated_at=? WHERE id=?').run(elapsed,now,id)
  const row = db.prepare('SELECT phase,current_item FROM personal_projects WHERE id=?').get(id) as {phase:string;current_item:string}
  if (!stepCanDispatch(step.kind,row.phase) || row.current_item !== itemId) return
  try {
    const {item,execution,project} = projectExecution(db,id)
    if (elapsed >= db.tasks.get(run.taskId)!.timeoutMs || project.active_ms >= 86400000 || item.active_ms >= 14400000 || event.durationMs < 0) {
      blockProject(db,id,'TIME_BUDGET',now); return
    }
    if (event.status !== 'succeeded' || run.status !== 'succeeded' || event.exitCode !== 0 ||
        event.personalResultDigest !== createHash('sha256').update(event.summary).digest('hex')) throw new Error('Unconfirmed role output')
    const parsed = GateReceipt.parse(JSON.parse(event.summary))
    if (parsed.kind !== step.kind || parsed.ordinal !== step.ordinal || parsed.taskId !== run.taskId || parsed.runId !== run.id ||
        parsed.itemId !== itemId || parsed.head !== execution.head) throw new Error('Stale role result')
    const phase = nextGate(parsed.kind,parsed,item)
    if (parsed.kind === 'review') {
      const review = ReviewJudgment.parse(parsed.judgment)
      if (review.findings.some(f => f.kind === 'requirement' && ![...execution.item.requirements,...execution.item.acceptanceRefs].includes(f.ref))) throw new Error('Unbound requirement')
      db.prepare('UPDATE personal_items SET review_rounds=review_rounds+1,rejects=rejects+? WHERE project_id=? AND item_id=?').run(Number(review.decision==='REJECT'),id,itemId)
    }
    if (parsed.kind === 'debug') {
      const debug = DebugJudgment.parse(parsed.judgment)
      if (debug.located) {
        const source = db.prepare("SELECT run_id FROM personal_steps WHERE project_id=? AND item_id=? AND kind IN ('implement','repair') ORDER BY created_at DESC,rowid DESC LIMIT 1").pluck().get(id,itemId)
        const failed = typeof source === 'string' && db.runs.get(source)
        if (!failed || !verificationRecord(failed).attempts.some(a=>a.results?.some(r=>r.status==='failed' && r.tail?.includes(debug.evidence)))) {
          throw new Error('Unknown diagnostic evidence')
        }
      }
      db.prepare('UPDATE personal_items SET unknown_rounds=? WHERE project_id=? AND item_id=?').run(debug.located ? 0 : item.unknown_rounds+1,id,itemId)
    }
    if (parsed.kind === 'DEBUG_NO_ROOT_CAUSE_TWICE') db.prepare('UPDATE personal_items SET unknown_rounds=0 WHERE project_id=? AND item_id=?').run(id,itemId)
    if (phase==='REVIEW_LIMIT' || phase==='ADVISOR_CONCERN') {
      blockProject(db,id,phase,now)
      if (phase==='REVIEW_LIMIT') db.prepare("UPDATE personal_items SET status='failed' WHERE project_id=? AND item_id=?").run(id,itemId)
    } else {
      db.prepare('UPDATE personal_projects SET phase=?,reason=NULL,updated_at=? WHERE id=?').run(phase,now,id)
      if (phase==='delivery_ready') db.prepare("UPDATE personal_items SET status='reviewed' WHERE project_id=? AND item_id=?").run(id,itemId)
    }
  } catch { blockProject(db,id,'ROLE_RESULT_UNCONFIRMED',now) }
}
