import { expect, it } from 'vitest'
import { HandoffPreview, RunHarnessView, TaskDetail, WorkspacePointerView } from '@agent-hub/protocol'
import { safeOn } from '../src/kernel/safe.js'
import { FakeWorker, openHarness, eventually } from './pi/harness.js'
import { DashClient } from './pi/dash.js'
import { ORIGIN, rest } from './pi/rest.js'
import { capabilities, dispatch, finish, mockPrompt, owner, requester } from './pi/phase7.js'

it.each([
  [undefined, undefined], ['junk', []], ['verify.v1', []], ['verify.v1,blackboard.v1', ['blackboard.v1', 'verify.v1']],
] as const)('negotiates and persists upgrade header %s', async (header, expected) => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'worker-7', headers: header === undefined ? {} : { 'X-Agent-Hub-Capabilities': header } })
    expect(w.welcome?.capabilities).toEqual(expected)
    expect(hub.ctx.workers.get('worker-7')?.protocolCapabilities).toEqual(expected)
    expect(hub.ctx.store.repos.workers.get('worker-7')?.protocolCapsJson).toEqual(expected ?? null)
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: ok', workspaceId: 'sandbox' }, owner)
    const run = await dispatch(w, task.id)
    expect(run).not.toHaveProperty('harness')
    expect(hub.ctx.orchestrator.getTask(task.id)?.runs[0]).not.toHaveProperty('harness')
  } finally { await cleanup() }
})

it('freezes facts, detects interleaving, protects snapshots and gates Requester delivery through REST and WS', async () => {
  const { hub, cleanup, url } = await openHarness({ dashboard: { allowedOrigins: [ORIGIN] } })
  const { orchestrator: api, store } = hub.ctx
  const token = hub.ctx.auth.createApiToken('test', ['admin'])
  const call = rest(hub)
  const ws = await DashClient.open(url, { token })
  const captured: unknown[] = []
  const off = safeOn(hub.ctx, 'run/events', (_id, _task, events) => { captured.push(...events) })
  try {
    await ws.handshake(['workers'])
    const worker = await FakeWorker.connect(hub, { workerId: 'worker-7', headers: capabilities })
    const data = { prompt: mockPrompt, adapter: 'mock' as const, workspaceId: 'sandbox', profile: 'edit' as const }
    const first = await api.createTask(data, owner)
    const r1 = await dispatch(worker, first.id)
    expect(r1.harness).toMatchObject({ board: 'write', inject: 'fresh', facts: { currentRun: { runId: r1.runId } } })
    expect(await api.handoff(first.id, owner, { intent: 'relay' }).catch(e => e.code)).toBe('INVALID_TRANSITION')
    const replay = await finish(hub, worker, r1)
    const second = await api.createTask(data, requester)
    await api.approve(second.id, owner, { overrides: { harness: { blackboard: true } } })
    expect(store.repos.tasks.get(second.id)?.harnessRequestJson?.overrides).toEqual({ blackboard: true })
    const r2 = await dispatch(worker, second.id)
    expect(r2.harness).toMatchObject({ board: 'write', trust: 'requester', bootstrap: false })
    await finish(hub, worker, r2)
    const base = '/api/v1/tasks/' + first.id
    const prefix = '/api/v1/workspaces/worker-7/sandbox'
    const pointers = WorkspacePointerView.array().parse((await call('GET', '/api/v1/workspaces', { token })).json())
    expect(pointers[0]).toMatchObject({ attemptCounter: 2, lastAccepted: { runId: r1.runId }, lastAttempt: { runId: r2.runId } })
    await ws.waitFor(f => f.t === 'event' && f.type === 'workspace.updated' && f.data.lastAttempt?.runId === r2.runId && f.data.lastAttempt.runStatus === 'succeeded')
    expect(api.getTask(second.id)?.resultDeliveryStatus).toBe('pending_review')
    expect(api.getTask(second.id)?.timeline.map(t => t.event)).toContain('task.harness.result_gated')
    const view = RunHarnessView.parse((await call('GET', base + '/runs/' + r1.runId + '/harness', { token })).json())
    expect(view.board.pre?.files[0]?.content).toBe('private board text')
    expect(view.board.diff[0]).toMatchObject({ change: 'deleted' })
    expect(JSON.stringify(captured)).not.toContain('private board text')
    const logs = store.repos.prepare("SELECT data_json AS json, bytes FROM task_logs WHERE kind IN ('harness','workspace')").all() as { json: string; bytes: number }[]
    expect(logs).toHaveLength(4)
    for (const row of logs) { expect(row.json).not.toContain('"content"'); expect(row.bytes).toBe(Buffer.byteLength(row.json)) }
    expect(JSON.stringify(store.repos.runs.get(r2.runId)?.harnessJson)).not.toContain('private board text')
    const preview = HandoffPreview.parse((await call('GET', base + '/handoff-preview', { token })).json())
    expect(preview.warnings).toContain('INTERLEAVED')
    expect(preview.facts.handoff?.intent).toBe('relay')
    expect(preview.facts.continuity?.interleaved.map(r => r.runId)).toEqual([r2.runId])
    expect(preview.promptPreview).toContain('WARNING')
    expect(await api.handoff(first.id, requester, { intent: 'relay' }).catch(e => e.status)).toBe(403)
    expect(await api.handoff(first.id, owner, { intent: 'relay', fromRunId: r2.runId }).catch(e => e.status)).toBe(404)
    const opts = { token, payload: { intent: 'fix', prompt: mockPrompt }, headers: { 'Idempotency-Key': 'retry-fixed' } }
    const created = await call('POST', base + '/handoff', opts)
    expect(created.status, created.body).toBe(201)
    const child = TaskDetail.parse(created.json())
    expect((await call('POST', base + '/handoff', opts)).json()).toMatchObject({ id: child.id })
    const r3 = await dispatch(worker, child.id)
    expect(r3).toMatchObject({ resume: { cliSessionId: 'session-' + r1.runId }, harness: { inject: 'resume', facts: { handoff: { intent: 'fix' } } } })
    expect(store.repos.tasks.get(child.id)).toMatchObject({ parentTaskId: first.id, rootTaskId: first.id, requiredWorkerId: 'worker-7', handoffFromRunId: r1.runId })
    const accept = { token, payload: { runId: r2.runId, expectedAcceptedRunId: r1.runId } }
    const results = await Promise.all([call('POST', prefix + '/accept', accept), call('POST', prefix + '/accept', accept)])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(await api.acceptRun('worker-7', 'sandbox', owner, { runId: r1.runId, expectedAcceptedRunId: r2.runId }).catch(e => e.details.reason)).toBe('NOT_NEWER')
    worker.events(r1.runId, first.id, replay)
    await finish(hub, worker, r3)
    await eventually(() => store.repos.pointers.get('worker-7', 'sandbox')?.lastAcceptedRunId === r3.runId)
    expect(store.repos.pointers.get('worker-7', 'sandbox')?.attemptCounter).toBe(3)
    expect(api.getTask(first.id)?.timeline.filter(t => t.event === 'task.workspace.accepted')).toHaveLength(1)
  } finally { off(); await ws.close(); await cleanup() }
}, 30000)

it('captures Requester snapshots without injection and honors critical capacity', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'worker-7', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner)
    const run = await dispatch(worker, task.id)
    expect(run.harness).toMatchObject({ inject: 'none', board: 'capture' })
    expect(run.harness).not.toHaveProperty('facts')
    hub.ctx.store.retention.storageLevel = 'critical'
    await finish(hub, worker, run)
    const rows = hub.ctx.store.repos.snapshots.forRun(run.runId)
    expect(rows).toHaveLength(2)
    for (const row of rows) { expect(row.contentBytes).toBe(0); expect(JSON.stringify(row.snapshotJson)).not.toContain('"content"') }
    expect(hub.ctx.orchestrator.getTask(task.id)).toMatchObject({ status: 'succeeded', resultDeliveryStatus: 'pending_review' })
  } finally { await cleanup() }
})
