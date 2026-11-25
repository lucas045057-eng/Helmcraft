import { AdvisorJudgment, DeliveryReceipt, GateReceipt, PersonalBinding, PersonalPlanReceipt, PersonalProjectView, PersonalReports, ReviewJudgment } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { HubError } from '../../services/errors.js'
import { verificationRecord } from './harness.js'

type Project = { id:string;phase:string;control:string;reason:string|null;current_item:string|null;last_commit:string|null;
  binding_json:string;plan_task_id:string;plan_run_id:string|null;plan_json:string|null;active_ms:number;closed_reports:string|null }
type Step = {item_id:string;kind:string;task_id:string;run_id:string|null;result_json:string|null;ordinal:number;active_ms:number}
type Item = {item_id:string;status:string;review_rounds:number;commit_sha:string|null;remote_sha:string|null}
export function personalProject(db:Repos,id:string) {
  const row=db.prepare('SELECT * FROM personal_projects WHERE id=?').get(id) as Project|undefined
  if (!row) throw new HubError('TASK_NOT_FOUND',404)
  return row
}
export function projectViews(db:Repos) {
  const rows=db.prepare('SELECT * FROM personal_projects ORDER BY updated_at DESC,rowid DESC LIMIT 50').all() as Project[]
  return rows.map(p=>{
    const step=db.prepare('SELECT task_id,run_id FROM personal_steps WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(p.id) as Step|undefined
    return PersonalProjectView.parse({id:p.id,phase:p.phase,control:p.control,reason:p.reason,currentItem:p.current_item,lastCommit:p.last_commit,
      taskId:step?.task_id ?? p.plan_task_id,runId:step?.run_id ?? p.plan_run_id,branch:PersonalBinding.parse(JSON.parse(p.binding_json)).branch,activeMs:p.active_ms})
  })
}

function documentTitle(name:string,id:string,now:number) {
  return ['# '+name,'','项目 '+id+' · 快照 '+new Date(now).toISOString(),'']
}
function readReceipt<T>(raw:string|null,parse:(s:unknown)=>T):T|undefined {
  if (!raw) return
  try { const result=JSON.parse(raw); if(result.status==='succeeded') return parse(JSON.parse(result.summary)) } catch { /* Retain incomplete evidence. */ }
}
export function projectReports(db:Repos,id:string,now:number):PersonalReports {
  const p=personalProject(db,id)
  if(p.closed_reports) return PersonalReports.parse(JSON.parse(p.closed_reports))
  const binding=PersonalBinding.parse(JSON.parse(p.binding_json))
  const plan=p.plan_json ? PersonalPlanReceipt.parse(JSON.parse(p.plan_json)) : undefined
  const items=db.prepare('SELECT * FROM personal_items WHERE project_id=? ORDER BY ordinal').all(id) as Item[]
  const steps=db.prepare('SELECT * FROM personal_steps WHERE project_id=? ORDER BY created_at,rowid').all(id) as Step[]
  const acceptance=documentTitle('项目验收',id,now), advisor=documentTitle('顾问记录',id,now), unresolved=documentTitle('待确认事项',id,now)
  acceptance.push('工作目录 '+binding.root,'','分支 '+binding.branch+' · '+binding.remote+' '+binding.ref,'',
    '需求摘要 '+(plan?.sourceDigest ?? 'unknown')+' · 计划摘要 '+(plan?.tasksDigest ?? 'unknown'),'',
    '规划 Task '+p.plan_task_id+' · Run '+(p.plan_run_id ?? 'unknown'),'','累计活动时间 '+p.active_ms+' ms','')
  let verifiedItems=0,finalChecks=false,finalAdvice=false,adviceCount=0
  const expectedChecks=[...new Set(plan?.items.flatMap(i=>i.checks) ?? [])]
  for(const item of items) {
    const definition=plan?.items.find(i=>i.id===item.item_id)
    const evidence=steps.filter(s=>s.item_id===item.item_id)
    const last=(kind:string)=>evidence.filter(s=>s.kind===kind).at(-1)
    const review=readReceipt(last('review')?.result_json ?? null, GateReceipt.parse)
    const push=readReceipt(last('push')?.result_json ?? null,DeliveryReceipt.parse)
    const commit=readReceipt(last('commit')?.result_json ?? null,DeliveryReceipt.parse)
    const tested=evidence.filter(s=>s.kind==='implement'||s.kind==='repair').at(-1)
    const trial=tested?.run_id ? db.runs.get(tested.run_id) : undefined
    const candidate=tested?.result_json ? JSON.parse(tested.result_json).candidate : null
    const results=trial && verificationRecord(trial).attempts.at(-1)?.results
    const checks=definition?.checks ?? []
    const confirmed=item.status==='delivered' && !!review && ReviewJudgment.safeParse(review.judgment).data?.decision==='PASS' &&
      review.runId===last('review')?.run_id && review.tree===candidate?.tree && review.head===candidate?.head &&
      !!commit && commit.tree===review.tree && commit.parent===review.head && commit.commit===item.commit_sha &&
      !!push && push.commit===commit.commit && push.remoteSha===item.remote_sha && push.remoteSha===commit.commit &&
      !!results && results.length===checks.length && results.every((r,i)=>r.id===checks[i] && r.status==='passed' && r.exitCode===0)
    for(const finding of ReviewJudgment.safeParse(review?.judgment).data?.findings ?? []) {
      unresolved.push('- '+item.item_id+' · '+finding.kind+' · '+finding.ref+' · '+finding.basis+' · '+finding.impact)
    }
    if(confirmed) verifiedItems++
    else unresolved.push('- '+item.item_id+' · '+item.status+' · 交付证据未闭合')
    acceptance.push('- ['+(confirmed?'x':item.status==='failed'?'!':' ')+'] '+item.item_id+' '+(definition?.title ?? ''),
      '  - 需求 '+(definition?.requirements.join('、') ?? 'unknown')+' · 验收 '+(definition?.acceptanceRefs.join('、') ?? 'unknown'),
      '  - 审查 '+item.review_rounds+' 轮 · commit '+(item.commit_sha ?? 'unknown')+' · 远端 '+(item.remote_sha ?? 'unknown'))
  }
  acceptance.push('','## 执行记录','')
  for(const s of steps) {
    const run=s.run_id ? db.runs.get(s.run_id) : undefined
    const output=s.result_json ? JSON.parse(s.result_json) : undefined
    acceptance.push('- '+[s.item_id,s.kind+' '+s.ordinal,'Task '+s.task_id,'Run '+(s.run_id ?? 'unknown'),run?.status ?? 'unknown',s.active_ms+' ms'].join(' · '))
    if (run) {
      acceptance.push('  - '+run.adapter+' '+(run.cliVersion ?? '')+' · 退出码 '+(run.exitCode ?? 'unknown')+' · token '+JSON.stringify(run.usageJson ?? 'unknown'))
      const attempts=verificationRecord(run).attempts
      for(const a of attempts) for(const r of a.results ?? []) acceptance.push('  - '+r.id+' · '+r.status+' · exit '+(r.exitCode ?? 'unknown'))
      if(s.kind==='verify_final'){
        const core=readReceipt(s.result_json,DeliveryReceipt.parse)
        const checks=attempts.at(-1)?.results ?? []
        finalChecks=!!core && core.commit===p.last_commit && core.remoteSha===p.last_commit && expectedChecks.length>0 &&
          checks.length===expectedChecks.length && checks.every((r,i)=>r.id===expectedChecks[i] && r.status==='passed' && r.exitCode===0)
      }
      if(run.status!=='succeeded' && ['commit','push','verify_final'].includes(s.kind)) {
        const log=db.prepare("SELECT text FROM task_logs WHERE run_id=? AND kind='log' AND stream='system' ORDER BY seq DESC LIMIT 1").pluck().get(run.id)
        unresolved.push('- '+s.kind+' · '+run.id+' · '+(output?.summary ?? run.errorCode ?? 'unknown')+' · '+(log ?? '现场日志未取得'))
      }
    }
    if(s.kind==='review'){
      const receipt=readReceipt(s.result_json,GateReceipt.parse)
      const judgment=ReviewJudgment.safeParse(receipt?.judgment).data
      acceptance.push('  - 审查 '+(judgment?.decision ?? 'unknown')+' · 树 '+(receipt?.tree ?? 'unknown'))
      for(const f of judgment?.findings ?? []) acceptance.push('    - '+f.ref+' · '+f.basis+' · '+f.impact)
    }
    if(['PLAN_READY','REVIEW_REJECTED_TWICE','DEBUG_NO_ROOT_CAUSE_TWICE','FINAL_READY'].includes(s.kind)){
      const receipt=readReceipt(s.result_json,GateReceipt.parse)
      const advice=AdvisorJudgment.safeParse(receipt?.judgment).data
      advisor.push('- '+[s.item_id,s.kind+' '+s.ordinal,s.task_id,s.run_id ?? 'unknown',advice?.assessment ?? 'unknown'].join(' · '),'  - '+(advice?.advice ?? '未取得有效结论'))
      adviceCount++
      if(s.kind==='FINAL_READY') finalAdvice=!!receipt && receipt.head===p.last_commit && advice?.assessment==='ok'
    }
  }
  const complete=p.phase==='done' && p.control==='closed' && !!plan && verifiedItems===plan.items.length && finalChecks && finalAdvice
  acceptance.splice(4,0,complete?'结论：已具备人工验收条件。':'结论：未完成。','','最终 SHA '+(p.last_commit ?? 'unknown'),'')
  if(!adviceCount) advisor.push('尚无顾问回执。')
  if(!complete) unresolved.push('- '+p.phase+' · '+(p.reason ?? '尚未完成全部交付、最终检查和顾问判断'))
  if(complete && unresolved.length===4) unresolved.push('当前项目执行记录无待确认项。')
  return {'ACCEPTANCE.md':acceptance.join('\n')+'\n','ADVISOR_FINAL.md':advisor.join('\n')+'\n','UNRESOLVED.md':unresolved.join('\n')+'\n'}
}
