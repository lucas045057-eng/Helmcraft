import { expect, it } from 'vitest'
import { defaultAdapters, FakeWorker, openHarness, eventually } from './pi/harness.js'
import { dispatch, owner, requester, mockPrompt } from './pi/phase7.js'
import { extractProgress } from '../src/plugins/channel-feishu/cards/progress.js'
import { PiFeishuTransport } from './pi/feishu.js'

const headers = { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' }
const task = { adapter: 'mock' as const, workspaceId: 'sandbox', profile: 'edit' as const, prompt: mockPrompt }
it.each(['INTERNAL', 'WORKER_RESTARTED'] as const)('VF-26 falls back to %s and attaches resume facts', async reason => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'vf', headers })
    const api = hub.ctx.orchestrator, first = await api.createTask(task, owner)
    const run = await dispatch(w, first.id)
    expect(api.getTask(first.id)?.verification).toBe('pending')
    w.events(run.runId, first.id, [{ kind: 'finished', seq: 1, ts: Date.now(), status: 'succeeded', cliSessionId: 'vf-session',
      exitCode: 0, signal: null, summary: '', durationMs: 4, ...(reason === 'WORKER_RESTARTED' && { errorCode: reason }) }])
    await eventually(() => api.getTask(first.id)?.verification === 'unverified')
    expect(api.runHarness(first.id, run.runId).verification?.outcome?.reason).toBe(reason)
    const child = await api.followUp(first.id, owner, { prompt: mockPrompt })
    expect((await dispatch(w, child.id)).harness?.facts?.parent?.verificationDetail?.reason).toBe(reason)
  } finally { await cleanup() }
})
it.each(['running', 'dispatching'])('VF-27/CR-8 resolves lost verification in %s', async phase => {
  const { hub, cleanup } = await openHarness({ workers: { gracePeriodMs: 100 } })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'vf-lost', headers })
    const created = await hub.ctx.orchestrator.createTask(task, owner)
    const frame = await w.waitFor('run.dispatch')
    const id = (frame.payload as { runId: string }).runId
    if (phase === 'running') {
      await w.ackCommand(frame)
      w.events(id, created.id, [{ kind: 'verify', attempt: 1, phase: 'started', commands: ['tests'], seq: 1, ts: Date.now() }])
      await eventually(() => hub.ctx.orchestrator.getTask(created.id)?.verification === 'running')
    }
    w.terminate()
    await eventually(() => hub.ctx.store.repos.runs.get(id)?.verificationStatus === 'unverified', { timeoutMs: 10000 })
    expect(hub.ctx.orchestrator.runHarness(created.id, id).verification?.outcome).toMatchObject({ reason: 'RUN_LOST', attempts: phase === 'running' ? 1 : 0 })
  } finally { await cleanup() }
}, 20000)
it.each([['failed', undefined, 'VERIFICATION'], ['unverified', 'MANIFEST_INCOMPLETE', 'VERIFICATION'],
  ['skipped', 'TAMPER_RISK', 'TAMPER_RISK'], ['skipped', 'CONFIG_EXPOSED', 'TAMPER_RISK']] as const)(
  'VF-29 gates %s/%s even with automatic delivery', async (status, reason, gate) => {
    const { hub, cleanup } = await openHarness({ feishu: { requesterReplyPolicy: 'auto' } })
    try {
      const api = hub.ctx.orchestrator
      const w = await FakeWorker.connect(hub, { workerId: 'vf-gate', headers })
      const created = await api.createTask(task, requester)
      await api.approve(created.id, owner, { overrides: { harness: { verify: true } } })
      const run = await dispatch(w, created.id)
      w.events(run.runId, created.id, [{ kind: 'finished', seq: 1, ts: Date.now(), status: 'succeeded', exitCode: 0, signal: null, summary: 'done',
        durationMs: 20, verification: { status, ...(reason && { reason }), attempts: status === 'failed' ? 1 : 0, failed: [] } }])
      await eventually(() => api.getTask(created.id)?.resultDeliveryStatus === 'pending_review')
      expect(hub.ctx.store.repos.runs.get(run.runId)?.harnessJson).toMatchObject({ gated: gate })
    } finally { await cleanup() }
  })
it('UX-13/15/16 shows safe progress to the requester and updates owner badges', async () => {
  const transport = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'],
    defaultWorkspaceId: 'sandbox', allowedChatIds: ['oc_group'] } }, { feishuTransport: transport })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'vf-cards', headers })
    await transport.group(mockPrompt)
    const created = hub.ctx.store.repos.tasks.getByNo(1)!
    const messages = () => hub.ctx.store.repos.feishu.messages(created.id)
    const approval = messages().find(m => m.role === 'approval_card')!
    const approved = await transport.click(approval.messageId, 'ou_owner', { v: 1, t: created.id, ver: created.version, a: 'approve' },
      { form: { harness: 'board_verify', profile: 'edit', adapter: 'mock' } })
    expect(approved.toast.type).toBe('success')
    const run = await dispatch(w, created.id)
    expect(run.harness?.verify?.autoFixMaxRetries).toBe(0)
    const started = { kind: 'verify', phase: 'started', seq: 1, ts: Date.now(), attempt: 1, commands: ['unit'] } as const
    const event = { ...started, commands: [...started.commands] }
    expect(extractProgress([event], 'owner')).toEqual(['验证 #1：unit'])
    w.events(run.runId, created.id, [event])
    const req = messages().find(m => m.audience === 'requester' && m.role === 'progress_card')!
    await eventually(() => transport.json(req.messageId).includes('正在进行自动验证'), { timeoutMs: 10000 })
    expect(transport.json(req.messageId)).not.toContain('unit')
    expect(hub.ctx.orchestrator.getTask(created.id)?.lastProgress).toBe('验证中 · unit')
  } finally { await cleanup() }
}, 20000)

it('UX-12/16 shows the live Owner badge and starts a fresh repair session on the selected CLI', async () => {
  const transport = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { enabled: true, ownerOpenIds: ['ou_owner'], defaultWorkspaceId: 'sandbox' } }, { feishuTransport: transport })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'vf-switch', headers, adapters: [...defaultAdapters, { ...defaultAdapters[0]!, id: 'codex' }] })
    await transport.p2p('/run --profile=edit --cli=mock ' + mockPrompt, { user: 'ou_owner' })
    const db = hub.ctx.store.repos, first = db.tasks.getByNo(1)!, run = await dispatch(w, first.id)
    const card = db.feishu.messages(first.id).find(m => m.role === 'progress_card')!
    w.events(run.runId, first.id, [{ kind: 'started', seq: 1, ts: Date.now(), pid: 1, commandSummary: 'mock', effectiveProfile: 'edit', adapter: 'mock' },
      { kind: 'verify', seq: 2, ts: Date.now(), attempt: 1, phase: 'started', commands: ['unit'] }])
    await eventually(() => transport.json(card.messageId).includes('⏳ 验证中'), { timeoutMs: 12000 })
    w.events(run.runId, first.id, [{ kind: 'verify', seq: 3, ts: Date.now(), attempt: 1, phase: 'result', commands: ['unit'], status: 'failed',
      results: [{ id: 'unit', status: 'failed', exitCode: 1, signal: null, durationMs: 10, tail: 'expected 2' }] },
      { kind: 'finished', seq: 4, ts: Date.now(), status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 50, cliSessionId: 'old-session',
        verification: { status: 'failed', attempts: 1, failed: ['unit'] } }])
    await eventually(() => transport.json(card.messageId).includes('❌ 验证失败：unit'))
    const result = await transport.click(card.messageId, 'ou_owner', { v: 1, a: 'fix', t: first.id, r: run.runId, ver: db.tasks.get(first.id)!.version },
      { form: { cli: 'codex' } })
    expect(result.toast.type).toBe('success')
    const child = await dispatch(w, db.tasks.getByNo(2)!.id)
    expect(child.resume).toBeUndefined()
    expect(child).toMatchObject({ adapter: 'codex', harness: { inject: 'handoff', facts: { handoff: { intent: 'fix', from: { verification: 'failed' } } } } })
  } finally { await cleanup() }
}, 30000)
it('HP-12/BC-9/10 negotiates verification per connection and retains conclusions across rollback', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const api = hub.ctx.orchestrator
    const w = await FakeWorker.connect(hub, { workerId: 'vf-rollback', headers })
    const first = await api.createTask(task, owner), run = await dispatch(w, first.id)
    expect(run.harness?.verify).toBeDefined()
    w.events(run.runId, first.id, [{ kind: 'finished', seq: 1, ts: Date.now(), status: 'succeeded', exitCode: 0, signal: null, summary: '', durationMs: 1,
      verification: { status: 'skipped', reason: 'NO_COMMANDS', attempts: 0, failed: [] } }])
    await eventually(() => api.getTask(first.id)?.verification === 'skipped')
    await hub.fibers.get('workers')!.update({ ...hub.config.workers, capabilities: ['blackboard.v1'] })
    const next = await FakeWorker.connect(hub, { workerId: 'vf-rollback', headers, identity: w.identity })
    expect(next.welcome?.capabilities).toEqual(['blackboard.v1'])
    const second = await api.createTask(task, owner)
    expect((await dispatch(next, second.id)).harness?.verify).toBeUndefined()
    expect(api.runHarness(first.id, run.runId).verification?.outcome?.reason).toBe('NO_COMMANDS')
  } finally { await cleanup() }
})
