import type { Context } from 'cordis'
import { ulid } from '@agent-hub/common'
import { PersonalBinding, PersonalPlanReceipt, type Actor } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos } from '../../services/store.js'
import { auditLogs } from '../store-sqlite/schema.js'
import { projectOptions } from './personal-execution.js'
import { personalProject, projectReports } from './personal-status.js'

const tasksForProject = `SELECT plan_task_id FROM personal_projects WHERE id=?
  UNION ALL SELECT task_id FROM personal_steps WHERE project_id=?`
const pendingStatuses = "('queued','awaiting_approval','dispatching','running','cancelling','awaiting_input')"

export async function controlProject(ctx:Context,id:string,action:'pause'|'resume'|'stop',actor:Actor) {
  const db=ctx.store.repos, now=ctx.clock.now(), project=personalProject(db,id)
  if (['done','stopped'].includes(project.phase) || ['releasing','inspect'].includes(project.control)) throw new HubError('INVALID_TRANSITION',409)
  if (action==='resume' && (project.control!=='paused' || project.phase==='blocked') ||
      action==='pause' && (project.control!=='running' || project.phase==='blocked') ||
      action!=='stop' && project.control==='stop_requested') throw new HubError('INVALID_TRANSITION',409)
  const control=action==='stop'?'stop_requested':action==='pause'?'paused':'running'
  db.prepare('UPDATE personal_projects SET control=?,updated_at=? WHERE id=?').run(control,now,id)
  if(action!=='stop') return
  const tasks=db.prepare(`SELECT id,status FROM tasks WHERE id IN (${tasksForProject}) AND status IN ${pendingStatuses}`).all(id,id) as {id:string;status:string}[]
  for(const task of tasks) {
    // A Git write already sent to the Worker reaches a known result before release.
    const kind=db.prepare('SELECT kind FROM personal_steps WHERE task_id=?').pluck().get(task.id)
    if(task.status==='cancelling' || (['commit','push'].includes(String(kind)) && !['queued','awaiting_approval'].includes(task.status))) continue
    if(!db.prepare(`SELECT 1 FROM tasks WHERE id=? AND status IN ${pendingStatuses}`).get(task.id)) continue
    await ctx.orchestrator.cancel(task.id,actor,{reason:'Owner stopped the personal project'})
  }
}

export function blockUnconfirmedDelivery(db:Repos,now:number) {
  db.prepare(`UPDATE personal_projects AS p SET phase='blocked',reason='DELIVERY_RECEIPT_UNCONFIRMED',updated_at=?
    WHERE p.phase IN ('committing','pushing','verifying_final') AND NOT EXISTS (
      SELECT 1 FROM personal_steps s JOIN tasks t ON t.id=s.task_id
      WHERE s.project_id=p.id AND s.item_id=p.current_item AND s.result_json IS NULL AND
      s.kind=CASE p.phase WHEN 'committing' THEN 'commit' WHEN 'pushing' THEN 'push' ELSE 'verify_final' END AND
      t.status IN ${pendingStatuses})`).run(now)
}
function uncertain(db:Repos,id:string) {
  const proj = personalProject(db, id)
  const opts = projectOptions(proj.options_json)
  const kinds: string[] = []
  if (proj.mode !== 'flexible' || opts.autoCommit !== false) kinds.push("'commit'")
  if (proj.mode !== 'flexible' || opts.autoPush === true) kinds.push("'push'")
  const gitCheck = kinds.length
    ? !!db.prepare(`SELECT 1 FROM personal_steps s JOIN task_runs r ON r.id=s.run_id
      JOIN personal_items i ON i.project_id=s.project_id AND i.item_id=s.item_id
      WHERE s.project_id=? AND s.kind IN (${kinds.join(',')}) AND (s.result_json IS NULL OR r.status!='succeeded'
      OR json_extract(s.result_json,'$.status')!='succeeded' OR i.commit_sha IS NULL OR (s.kind='push' AND i.remote_sha IS NULL))`).get(id)
    : false
  return gitCheck ||
    !!db.prepare(`SELECT 1 FROM task_runs WHERE task_id IN (${tasksForProject}) AND (status='lost' OR error_code='WORKER_RESTARTED')`).get(id,id)
}
export async function closeProject(ctx:Context,id:string) {
  const db=ctx.store.repos, p=personalProject(db,id)
  const stopped=p.control==='stop_requested'
  if (!stopped && !(p.phase==='acceptance_ready' && p.control==='running')) return
  if (db.prepare(`SELECT 1 FROM tasks WHERE id IN (${tasksForProject}) AND status IN ${pendingStatuses}`).get(id,id)) return
  const inspect=(reason:string)=>db.prepare("UPDATE personal_projects SET control='inspect',phase='blocked',reason=?,updated_at=? WHERE id=?")
    .run(reason,ctx.clock.now(),id)
  if (uncertain(db,id) || ['HUB_RESTART_INSPECT','DISPATCH_LOST','RUN_LOST','WORKER_RESTARTED','DELIVERY_RECEIPT_UNCONFIRMED'].includes(p.reason ?? '')) {
    inspect(p.reason ?? 'GIT_RESULT_INSPECT'); return
  }
  if (!db.prepare("UPDATE personal_projects SET control='releasing' WHERE id=? AND phase=? AND control=?").run(id,p.phase,p.control).changes) return
  const b=PersonalBinding.parse(JSON.parse(p.binding_json)), ts=ctx.clock.now()
  try {
    if(!ctx.workers.isOnline(b.workerId)) throw new Error('WORKER_OFFLINE_INSPECT')
    const ack=await ctx.workers.send(b.workerId,{v:1,id:ulid(ts),ts,type:'project.release',payload:{projectId:id,workspaceId:b.workspaceId,root:b.root,...(b.subdir && {subdir:b.subdir})}})
    if(!ack.ok || ack.result?.releasedProject!==id) throw new Error(ack.error?.message ?? 'RELEASE_UNCONFIRMED')
    let targetPhase = ''
    ctx.store.tx(tx=>{
      const phase=stopped?'stopped':'done'
      if(!tx.prepare("UPDATE personal_projects SET control='closed',phase=?,updated_at=? WHERE id=? AND control='releasing'").run(phase,ctx.clock.now(),id).changes) return
      tx.prepare('UPDATE personal_projects SET closed_reports=? WHERE id=?').run(JSON.stringify(projectReports(tx,id,ctx.clock.now())),id)
      targetPhase = phase
    })
    if (targetPhase) {
      const opts = projectOptions(p.options_json)
      ctx.emit('personal/phase', {
        projectId: id, phase: targetPhase, prevPhase: p.phase, currentItem: null, reason: null,
        label: b.subdir ? `${b.workspaceId}/${b.subdir}` : b.workspaceId,
        ...(opts.notifyFeishuChatId && { notifyFeishuChatId: opts.notifyFeishuChatId }),
      })
    }
  } catch(error) {
    inspect(error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : 'RELEASE_UNCONFIRMED')
  }
}

export async function rebaselineProject(ctx: Context, id: string) {
  const db = ctx.store.repos
  const project = personalProject(db, id)
  if (!project.plan_json || ['done', 'stopped'].includes(project.phase) || ['releasing', 'inspect'].includes(project.control)) {
    throw new HubError('INVALID_TRANSITION', 409)
  }
  if (db.prepare(`SELECT 1 FROM tasks WHERE id IN (${tasksForProject}) AND status IN ${pendingStatuses}`).get(id, id)) {
    throw new HubError('INVALID_TRANSITION', 409, { reason: 'ACTIVE_TASK_PENDING' })
  }
  const plan = PersonalPlanReceipt.parse(JSON.parse(project.plan_json))
  if (plan.checksDigestVersion === 2) {
    return { projectId: id, checksDigest: plan.checksDigest, checksDigestVersion: 2 as const }
  }
  const binding = PersonalBinding.parse(JSON.parse(project.binding_json))
  const options = projectOptions(project.options_json)
  if (!ctx.workers.isOnline(binding.workerId)) {
    throw new HubError('WORKER_OFFLINE', 503)
  }
  if (!ctx.workers.capabilities(binding.workerId).includes('checks-digest.v2')) {
    throw new HubError('INVALID_TRANSITION', 409, { reason: 'WORKER_CAPABILITY_UNSUPPORTED' })
  }
  const ts = ctx.clock.now()
  const ack = await ctx.workers.send(binding.workerId, {
    v: 1,
    id: ulid(ts),
    ts,
    type: 'project.rebaseline',
    payload: {
      projectId: id,
      binding,
      legacyChecksDigest: plan.checksDigest,
      ...(options.noChecks && { noChecks: true as const }),
    },
  })
  if (!ack.ok || !ack.result?.rebaseline) {
    throw new HubError('INVALID_TRANSITION', 409, { reason: ack.error?.message ?? 'REBASELINE_FAILED' })
  }
  const updatedPlan = {
    ...plan,
    checksDigest: ack.result.rebaseline.checksDigest,
    checksDigestVersion: 2 as const,
  }
  const now = ctx.clock.now()
  let restoredPhase: string | undefined
  ctx.store.tx(tx => {
    const fresh = personalProject(tx, id)
    if (fresh.phase === 'done' || fresh.phase === 'stopped' || !fresh.plan_json) throw new HubError('INVALID_TRANSITION', 409)
    tx.prepare('UPDATE personal_projects SET plan_json=?,updated_at=? WHERE id=?').run(JSON.stringify(updatedPlan), now, id)
    if (fresh.phase === 'blocked' && fresh.reason === 'CHECKS_REBASELINE_REQUIRED') {
      const lastStep = tx.prepare('SELECT task_id,run_id,kind,item_id,result_json FROM personal_steps WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(id) as { task_id: string; run_id: string | null; kind: string; item_id: string; result_json: string | null } | undefined
      const phaseForStep: Record<string, string> = {
        implement: 'implementation_ready',
        repair: 'repair_ready',
        PLAN_READY: 'plan_ready',
        review: 'review_ready',
        debug: 'debug_ready',
        REVIEW_REJECTED_TWICE: 'reject_advice_ready',
        DEBUG_NO_ROOT_CAUSE_TWICE: 'debug_advice_ready',
        commit: 'delivery_ready',
        push: 'push_ready',
        verify_final: 'core_ready',
        FINAL_READY: 'final_ready',
      }
      let lastResult: { status?: string; summary?: string } | undefined
      if (lastStep?.result_json) {
        try { lastResult = JSON.parse(lastStep.result_json) as { status?: string; summary?: string } } catch { lastResult = undefined }
      }
      if (lastStep && lastResult?.status === 'failed' && lastResult?.summary === 'CHECKS_REBASELINE_REQUIRED') {
        const nextPhase = phaseForStep[lastStep.kind]
        if (nextPhase) {
          tx.prepare('DELETE FROM personal_steps WHERE task_id=?').run(lastStep.task_id)
          if (lastStep.kind === 'implement') {
            tx.prepare("UPDATE personal_items SET status='pending' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, lastStep.item_id)
          } else if (lastStep.kind === 'repair') {
            tx.prepare("UPDATE personal_items SET repair_debug_calls=MAX(0,repair_debug_calls-1),status=CASE WHEN status='blocked' THEN 'awaiting_review' ELSE status END WHERE project_id=? AND item_id=?").run(id, lastStep.item_id)
          } else if (lastStep.kind === 'debug') {
            tx.prepare("UPDATE personal_items SET repair_debug_calls=MAX(0,repair_debug_calls-1),status=CASE WHEN status IN ('blocked','diagnosing') THEN 'implementing' ELSE status END WHERE project_id=? AND item_id=?").run(id, lastStep.item_id)
          } else if (lastStep.kind === 'review') {
            tx.prepare("UPDATE personal_items SET status='awaiting_review' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, lastStep.item_id)
          } else if (lastStep.kind === 'commit' || lastStep.kind === 'push') {
            tx.prepare("UPDATE personal_items SET status='reviewed' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, lastStep.item_id)
          }
          tx.prepare('UPDATE personal_projects SET phase=?,reason=NULL,resume_phase=NULL,updated_at=? WHERE id=?').run(nextPhase, now, id)
          tx.insert(auditLogs).values({
            ts: now, actorType: 'owner', actorId: 'owner', channel: 'api', action: 'project.rebaseline',
            targetType: 'task', targetId: lastStep.task_id, fromStatus: 'blocked', toStatus: nextPhase,
            detailJson: { projectId: id, clearedStepKind: lastStep.kind, clearedRunId: lastStep.run_id, restoredPhase: nextPhase },
          }).run()
          restoredPhase = nextPhase
        }
      } else if (fresh.resume_phase && Object.values(phaseForStep).includes(fresh.resume_phase)) {
        if (fresh.resume_phase === 'implementation_ready' && fresh.current_item) {
          tx.prepare("UPDATE personal_items SET status='pending' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, fresh.current_item)
        } else if (fresh.resume_phase === 'review_ready' && fresh.current_item) {
          tx.prepare("UPDATE personal_items SET status='awaiting_review' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, fresh.current_item)
        } else if ((fresh.resume_phase === 'delivery_ready' || fresh.resume_phase === 'push_ready') && fresh.current_item) {
          tx.prepare("UPDATE personal_items SET status='reviewed' WHERE project_id=? AND item_id=? AND status='blocked'").run(id, fresh.current_item)
        }
        tx.prepare('UPDATE personal_projects SET phase=?,reason=NULL,resume_phase=NULL,updated_at=? WHERE id=?').run(fresh.resume_phase, now, id)
        restoredPhase = fresh.resume_phase
      }
    }
  })
  if (restoredPhase) {
    ctx.emit('personal/phase', {
      projectId: id,
      phase: restoredPhase,
      prevPhase: 'blocked',
      currentItem: project.current_item,
      reason: null,
      label: binding.subdir ? `${binding.workspaceId}/${binding.subdir}` : binding.workspaceId,
      ...(options.notifyFeishuChatId && { notifyFeishuChatId: options.notifyFeishuChatId }),
    })
  }
  return { projectId: id, checksDigest: ack.result.rebaseline.checksDigest, checksDigestVersion: 2 as const }
}
