import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { PersonalGateKind } from '@agent-hub/protocol'
import { beginGate, finishGate, planAdvice, prepareGate } from '../src/plugins/orchestrator/personal-gates.js'
import { recordPlanningTask, recordPlanResult } from '../src/plugins/orchestrator/personal-plan.js'
import { enrollWorker, openHarness, seedRun } from './pi/harness.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const tip='1'.repeat(40), tree='2'.repeat(40), ref='REQ.md:L1'
const binding={workerId:'test-worker',workspaceId:'sandbox',root:'/repo',branch:'main',remote:'origin',ref:'refs/heads/main',
  destination:hash('origin'),executables:{main:'/codex',reviewer:'/claude',advisor:'/agy'}}
const reject={ decision:'REJECT',findings:[{kind:'correctness',ref,basis:'Adds one twice',impact:'Incorrect total'}]}
const pass={decision:'PASS',findings:[]}
const ok={assessment:'ok',advice:'Continue with the current scope'}
const unknown={located:false,hypothesis:'Check the reader',experiment:'Compare counts in the failed check with the change',observation:'Cause is unconfirmed',evidence:''}

async function fixture() {
  const {hub,cleanup}=await openHarness({},{listen:false})
  hub.ctx.orchestrator.pauseScheduling()
  await enrollWorker(hub,binding.workerId)
  const db=hub.ctx.store.repos, id='p'
  const item={id:'COUNT',title:'Count objects',requirements:[ref],acceptanceRefs:[ref],checks:['core']}
  const plan=JSON.stringify({items:[item],head:tip,checksDigest:hash('c'),sourceDigest:hash('s'),tasksDigest:hash('t')})
  recordPlanningTask(db,{projectId:id,binding,sources:['REQ.md']},'plan-task',0)
  recordPlanResult(db,'plan-task','plan-run',{kind:'finished',seq:1,ts:1,status:'succeeded',durationMs:100,exitCode:0,signal:null,
    summary:plan,personalResultDigest:hash(plan)},1)
  db.prepare('UPDATE personal_items SET tested_json=?').run(JSON.stringify({head:tip,indexTree:tip,tree}))
  const phase=()=>String(db.prepare('SELECT phase FROM personal_projects').pluck().get())
  const set=(phase:string)=>db.prepare('UPDATE personal_projects SET phase=?').run(phase)
  function complete(kind:PersonalGateKind, judgment:unknown, stale=false) {
    const g=prepareGate(db,id)
    expect(g.kind).toBe(kind)
    const {taskId,runId}=seedRun(hub,{workerId:binding.workerId,runStatus:'succeeded'})
    beginGate(db,id,taskId,10)
    db.prepare('UPDATE personal_steps SET run_id=? WHERE task_id=?').run(runId,taskId)
    const summary=JSON.stringify({taskId,runId:stale?'other':runId,itemId:item.id,kind,ordinal:g.ordinal,
      head:kind==='FINAL_READY'?tree:tip,tree,inputDigest:hash('input'),judgment})
    const event={kind:'finished' as const,status:'succeeded' as const,seq:1,ts:20,exitCode:0,signal:null,durationMs:10,summary,personalResultDigest:hash(summary)}
    const run=db.runs.get(runId)!
    for(let i=0;i<2;i++) hub.ctx.store.tx(tx=>finishGate(tx,run,event,20))
  }
  return {db,cleanup,phase,set,complete}
}
it.each(['PASS','REJECT'])('deduplicates consultations, preserves five review rounds and accepts fifth %s',async decision=>{
  const s=await fixture()
  try {
    s.complete('PLAN_READY',ok)
    expect(planAdvice(s.db,'p')).toBe(ok.advice)
    expect(s.phase()).toBe('implementation_ready')
    for(let n=1;n<=5;n++){
      s.set('review_ready') // Each cycle starts at the output of a new, passing implementation test.
      s.complete('review',n===5 && decision==='PASS'?pass:reject)
      if(n===2){expect(s.phase()).toBe('reject_advice_ready');s.complete('REVIEW_REJECTED_TWICE',ok)}
      if(n<5)expect(s.phase()).toBe('repair_ready')
    }
    expect(s.db.prepare('SELECT review_rounds,rejects,status FROM personal_items').get()).toEqual({
      review_rounds:5,rejects:decision==='PASS'?4:5,status:decision==='PASS'?'reviewed':'failed'})
    expect(s.phase()).toBe(decision==='PASS'?'delivery_ready':'blocked')
    expect(s.db.prepare('SELECT active_ms FROM personal_projects').pluck().get()).toBe(170)
    if(decision==='PASS'){
      s.db.prepare("UPDATE personal_items SET status='delivered'").run()
      s.db.prepare("UPDATE personal_projects SET phase='final_ready',last_commit=?").run(tree)
      s.complete('FINAL_READY',ok)
      expect(s.phase()).toBe('acceptance_ready')
    }
  }finally{await s.cleanup()}
})
it('consults before a third unresolved debug and enforces the shared repair limit',async()=>{
  const s=await fixture()
  try{
    s.set('debug_ready');s.complete('debug',unknown)
    expect(s.phase()).toBe('debug_ready')
    s.complete('debug',unknown)
    expect(s.phase()).toBe('debug_advice_ready')
    s.complete('DEBUG_NO_ROOT_CAUSE_TWICE',ok)
    expect(s.phase()).toBe('debug_ready')
    expect(s.db.prepare('SELECT unknown_rounds,repair_debug_calls FROM personal_items').get()).toEqual({unknown_rounds:0,repair_debug_calls:2})
    s.db.prepare('UPDATE personal_items SET repair_debug_calls=8').run()
    expect(()=>prepareGate(s.db,'p')).toThrow('ITEM_CALL_LIMIT')
  }finally{await s.cleanup()}
})
it.each(['stale','suggestion'])('stops without counting a %s rejection',async mode=>{
  const s=await fixture()
  try{
    s.set('review_ready')
    s.complete('review',mode==='stale'?reject:{decision:'REJECT',findings:[{...reject.findings[0],kind:'suggestion'}]},mode==='stale')
    expect(s.phase()).toBe('blocked')
    expect(s.db.prepare('SELECT review_rounds FROM personal_items').pluck().get()).toBe(0)
  }finally{await s.cleanup()}
})
