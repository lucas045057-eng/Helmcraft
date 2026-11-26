import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { expect, it } from 'vitest'
import { RunDispatch } from '@agent-hub/protocol'
import { createTestHub, type TestHub } from '../src/app.js'
import { recordPlanningTask, recordPlanResult } from '../src/plugins/orchestrator/personal-plan.js'
import { defaultAdapters, eventually, FakeWorker, openHarness, tmpDir } from './pi/harness.js'
import { owner } from './pi/phase7.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const binding = { workerId: 'personal', workspaceId: 'sandbox', root: '/work/repo', branch: 'main', remote: 'origin',
  ref: 'refs/heads/main', destination: hash('remote'), executables: { main: '/main', reviewer: '/review', advisor: '/advice' } }
function ready(hub: TestHub) {
  const items = ['ONE','TWO'].map(id => ({ id, title: id, requirements: ['README.md:L1'], acceptanceRefs: ['README.md:L2'], checks: ['core'] }))
  const summary = JSON.stringify({ items, head: 'a'.repeat(40), tasksDigest: hash('tasks'), sourceDigest: hash('req'), checksDigest: hash('cfg'), checksDigestVersion: 2 })
  hub.ctx.store.tx(db => {
    recordPlanningTask(db, { binding, projectId: 'p', sources: ['README.md'] }, 'plan', 0)
    recordPlanResult(db,'plan','source-run',{ seq: 1, ts: 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null,
      durationMs: 50, summary, personalResultDigest: hash(summary) },1)
    // The preceding PLAN_READY gate belongs to T14. This fixture starts at its output.
    db.prepare("UPDATE personal_projects SET phase='implementation_ready' WHERE id='p'").run()
  })
}
it.each(['passed','missing','failed','quarantined','budget','unbound'])('runs only the first fixed item and gates its %s receipt', async mode => {
  const { hub, cleanup } = await openHarness()
  let worker: FakeWorker | undefined
  try {
    ready(hub)
    const db = hub.ctx.store.repos
    worker = await FakeWorker.connect(hub, {
      workerId: binding.workerId,
      headers: { 'X-Agent-Hub-Capabilities': 'checks-digest.v2' },
      adapters: [{ ...defaultAdapters[0]!, id: 'codex' }],
    })
    const cmd = await worker.waitFor('run.dispatch', 8000)
    hub.ctx.orchestrator.pauseScheduling() // Observe the execution boundary before a T14 role is queued.
    const d = RunDispatch.parse(cmd.payload)
    expect(d.personal?.execution?.item.id).toBe('ONE')
    expect(d.harness?.verify?.autoFixMaxRetries).toBe(0)
    await expect(hub.ctx.orchestrator.createTask({ prompt: 'another', workspaceId: 'sandbox', profile: 'edit' }, owner)).rejects.toThrow()
    await worker.ackCommand(cmd)
    let seq = 1
    const emit = (ev: Record<string, unknown>) => worker!.events(d.runId,d.taskId,[{...ev,seq:seq++,ts:Date.now()}])
    const phase = () => (db.prepare('SELECT phase FROM personal_projects').get() as {phase:string}).phase
    if (mode !== 'missing') {
      emit({ kind: 'verify', attempt: 1, commands: ['core'], phase:'started' })
      await eventually(() => phase() === 'verifying')
      emit({ kind: 'verify', attempt: 1, commands: ['core'], phase:'result', status: mode === 'failed' || mode === 'quarantined' ? 'failed' : 'passed',
        results: [{ id:'core', status: mode === 'quarantined' ? 'unavailable' : mode === 'failed' ? 'failed' : 'passed', exitCode: mode === 'failed' ? 2 : 0, signal: null, durationMs: 10 }] })
    }
    const duration = mode === 'budget' ? 1800000 : 1200
    const terminal = { seq, ts: Date.now(), kind: 'finished', status:'succeeded', durationMs:duration, signal:null, exitCode:0, summary:'ok',
      ...(mode !== 'unbound' && {testedCandidate:{head:'a'.repeat(40),indexTree:'b'.repeat(40),tree:'c'.repeat(40)}}),
      personalResultDigest:hash('ok'), verification:{ status: mode === 'quarantined' ? 'unverified' : mode === 'failed' ? 'failed' : 'passed',
        ...(mode === 'quarantined' && { reason:'INTERNAL' }), attempts:1, failed:mode === 'failed' ? ['core'] : [] } }
    worker.events(d.runId,d.taskId,[terminal])
    await eventually(() => ['review_ready','debug_ready','blocked'].includes(phase()))
    worker.events(d.runId,d.taskId,[terminal])
    expect(phase()).toBe(mode === 'passed' ? 'review_ready' : mode === 'failed' ? 'debug_ready' : 'blocked')
    expect(db.prepare('SELECT item_id,run_id,active_ms FROM personal_steps').all()).toEqual([{ item_id:'ONE',run_id:d.runId,active_ms:duration }])
    expect(db.prepare('SELECT current_item,active_ms FROM personal_projects').get()).toEqual({current_item:'ONE',active_ms:duration+50})
    expect(db.prepare("SELECT status FROM personal_items WHERE item_id='TWO'").get()).toEqual({status:'pending'})
    await expect(hub.ctx.orchestrator.retry(d.taskId,owner)).rejects.toThrow()
  } finally { worker?.close(); await cleanup() }
},15000)
it('stops a restarted project before dispatch and keeps the occupied workspace', async () => {
  const dir = tmpDir(), config = { storage:{ path:join(dir,'hub.sqlite') } }
  try {
    const first = await createTestHub(config,{listen:false})
    try { first.ctx.orchestrator.pauseScheduling(); ready(first) } finally { await first.close() }
    const second = await createTestHub(config,{listen:false})
    try {
      const db = second.ctx.store.repos
      expect(db.prepare('SELECT phase,reason,active_ms FROM personal_projects').get()).toEqual({phase:'blocked',reason:'HUB_RESTART_INSPECT',active_ms:50})
      expect(db.prepare('SELECT * FROM personal_steps').all()).toHaveLength(0)
      await expect(second.ctx.orchestrator.createTask({workspaceId:'sandbox',prompt:'other',profile:'edit'},owner)).rejects.toThrow()
    } finally { await second.close() }
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
