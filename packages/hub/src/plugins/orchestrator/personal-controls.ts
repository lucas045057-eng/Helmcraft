import type { Context } from 'cordis'
import { ulid } from '@agent-hub/common'
import { PersonalBinding, type Actor } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos } from '../../services/store.js'
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
  return !!db.prepare(`SELECT 1 FROM personal_steps s JOIN task_runs r ON r.id=s.run_id
    JOIN personal_items i ON i.project_id=s.project_id AND i.item_id=s.item_id
    WHERE s.project_id=? AND s.kind IN ('commit','push') AND (s.result_json IS NULL OR r.status!='succeeded'
    OR json_extract(s.result_json,'$.status')!='succeeded' OR i.commit_sha IS NULL OR (s.kind='push' AND i.remote_sha IS NULL))`).get(id) ||
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
    const ack=await ctx.workers.send(b.workerId,{v:1,id:ulid(ts),ts,type:'project.release',payload:{projectId:id,workspaceId:b.workspaceId,root:b.root}})
    if(!ack.ok || ack.result?.releasedProject!==id) throw new Error(ack.error?.message ?? 'RELEASE_UNCONFIRMED')
    ctx.store.tx(tx=>{
      const phase=stopped?'stopped':'done'
      if(!tx.prepare("UPDATE personal_projects SET control='closed',phase=?,updated_at=? WHERE id=? AND control='releasing'").run(phase,ctx.clock.now(),id).changes) return
      tx.prepare('UPDATE personal_projects SET closed_reports=? WHERE id=?').run(JSON.stringify(projectReports(tx,id,ctx.clock.now())),id)
    })
  } catch(error) {
    inspect(error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : 'RELEASE_UNCONFIRMED')
  }
}
