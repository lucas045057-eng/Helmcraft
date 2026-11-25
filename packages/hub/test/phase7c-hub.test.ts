import { FakeClock } from '@agent-hub/common'
import { RunOutbox } from '../../worker/src/tunnel/outbox.js'
import { HubConfigSchema } from '../src/config/schema.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { RunDispatch } from '@agent-hub/protocol'
import { expect, it } from 'vitest'
import { FakeWorker, openHarness, eventually, defaultAdapters } from './pi/harness.js'
import { dispatch, finish, mockPrompt, owner, snapshot } from './pi/phase7.js'
import { rest } from './pi/rest.js'

const task = { prompt: mockPrompt, adapter: 'mock' as const, workspaceId: 'sandbox', profile: 'edit' as const }
const workerOptions = { workerId: 'review', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' },
  adapters: [...defaultAdapters, { ...defaultAdapters[0]!, id: 'codex' as const }] }
const end = { kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 1, summary: 'done' }
it('F1 keeps lastAccepted when a failed attempt is followed by a skipped conclusion', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, workerOptions)
    const t = await hub.ctx.orchestrator.createTask(task, owner), r = await dispatch(w, t.id)
    w.events(r.runId, t.id, [{ kind: 'verify', phase: 'result', attempt: 1, commands: ['unit'], status: 'failed',
      results: [{ id: 'unit', status: 'failed', exitCode: 1, signal: null, durationMs: 1 }], seq: 1, ts: Date.now() },
      { ...end, seq: 2, ts: Date.now(), verification: { status: 'skipped', reason: 'NO_CHANGES', attempts: 1, failed: [] } }])
    await eventually(() => hub.ctx.store.repos.runs.get(r.runId)?.status === 'succeeded')
    expect(hub.ctx.store.repos.pointers.get('review', 'sandbox')!.lastAcceptedRunId).toBeNull()
  } finally { await cleanup() }
})
it('F2 binds retry overrides to the handoff source and drops resume on adapter change', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, workerOptions), api = hub.ctx.orchestrator
    const t = await api.createTask(task, owner), source = await dispatch(w, t.id)
    await finish(hub, w, source)
    const child = await api.handoff(t.id, owner, { intent: 'fix', prompt: mockPrompt }), run = await dispatch(w, child.id)
    expect(run.resume).toBeDefined()
    w.events(run.runId, child.id, [{ ...end, status: 'failed', exitCode: 1, seq: 1, ts: Date.now() }])
    await eventually(() => api.getTask(child.id)?.status === 'failed')
    for (const overrides of [{ workspaceId: 'backend' }, { requiredWorkerId: 'other' }]) {
      await expect(api.retry(child.id, owner, { overrides })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'HANDOFF_BINDING' } })
    }
    await api.retry(child.id, owner, { overrides: { adapter: 'codex' } })
    const frame = await w.waitFor('run.dispatch', f => (f.payload as RunDispatch).taskId === child.id && (f.payload as RunDispatch).runId !== run.runId)
    const next = RunDispatch.parse(frame.payload)
    expect(next.adapter).toBe('codex')
    expect(next.resume).toBeUndefined()
    expect(next.harness?.inject).toBe('handoff')
  } finally { await cleanup() }
})
it('F5 scrubs snapshot text with Hub patterns before SQLite and REST', async () => {
  const marker = 'hub-only-marker'
  const { hub, cleanup } = await openHarness({ workers: { redactionPatterns: [marker, 'ZZ'] } })
  try {
    const w = await FakeWorker.connect(hub, workerOptions)
    const t = await hub.ctx.orchestrator.createTask(task, owner), r = await dispatch(w, t.id)
    await finish(hub, w, r, snapshot(marker), snapshot('ZZ'.repeat(8000)))
    const rows = hub.ctx.store.repos.snapshots.forRun(r.runId)
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(marker)
    const token = hub.ctx.auth.createApiToken('snapshot', ['admin'])
    const res = await rest(hub)('GET', '/api/v1/tasks/' + t.id + '/runs/' + r.runId + '/harness', { token })
    expect(res.status).toBe(200)
    expect(res.body).not.toContain(marker)
    expect(res.body).toContain('[REDACTED]')
    const file = res.json<{ board: { post: { files: Array<{ truncated?: boolean; content?: string }> } } }>().board.post.files[0]!
    expect(file.truncated).toBe(true)
    expect(Buffer.byteLength(file.content ?? '')).toBeLessThanOrEqual(16384)
  } finally { await cleanup() }
})

it('F6 enforces the 64 KiB floor and persists bounded verify and finished events', async () => {
  const min = 64 << 10
  for (const key of ['maxInFlightBytes', 'maxFrameBytes']) {
    expect(HubConfigSchema.safeParse({ workers: { [key]: min - 1 } }).success).toBe(false)
  }
  const { hub, cleanup } = await openHarness({ workers: { maxInFlightBytes: min, maxFrameBytes: min } })
  try {
    const w = await FakeWorker.connect(hub, workerOptions)
    const t = await hub.ctx.orchestrator.createTask(task, owner), r = await dispatch(w, t.id)
    const out = new RunOutbox(new FakeClock(Date.now()), { runBufferBytes: min, totalBufferBytes: min }, () => {})
    out.register(r.runId, t.id)
    // An older peer can still advertise 1 KiB. Exercise projection into its real window.
    out.attach(frame => {
      expect(frame.type).toBe('run.events')
      if (frame.type === 'run.events') {
        expect(Buffer.byteLength(JSON.stringify(frame)) + 64).toBeLessThanOrEqual(1024)
        w.events(r.runId, t.id, frame.payload.events)
      }
      return true
    }, 1024, 1024, ['blackboard.v1', 'verify.v1'])
    const commands = Array.from({ length: 16 }, (_, i) => ('check' + i).padEnd(32, 'x'))
    out.push(r.runId, { kind: 'verify', phase: 'result', attempt: 1, commands, status: 'failed',
      results: commands.map(id => ({ id, status: 'failed', exitCode: 1, durationMs: 3, signal: null, tail: 'x'.repeat(4096) })) })
    await eventually(() => hub.ctx.store.repos.runs.get(r.runId)?.lastSeq === 1)
    out.ack(r.runId, 1)
    out.push(r.runId, { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, durationMs: 30,
      cliSessionId: 's'.repeat(256), summary: '文'.repeat(20000), verification: { status: 'failed', attempts: 1, failed: commands } })
    await eventually(() => hub.ctx.store.repos.runs.get(r.runId)?.status === 'succeeded')
    const view = hub.ctx.orchestrator.runHarness(t.id, r.runId)
    expect(view.verification).toMatchObject({ attempts: [{ status: 'failed', commands }], outcome: { status: 'failed', failed: commands } })
  } finally { await cleanup() }
})
it('F7 shows gate reasons and dispatches fix from the private owner review card', async () => {
  const transport = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'],
    allowedChatIds: ['oc_group'], defaultWorkspaceId: 'sandbox' } }, { feishuTransport: transport })
  try {
    const w = await FakeWorker.connect(hub, workerOptions), db = hub.ctx.store.repos
    await transport.group(mockPrompt)
    const task = db.tasks.getByNo(1)!
    await hub.ctx.orchestrator.approve(task.id, owner, { overrides: { adapter: 'mock', profile: 'edit', harness: { verify: true } } })
    const run = await dispatch(w, task.id)
    w.events(run.runId, task.id, [{ kind: 'workspace', seq: 1, ts: Date.now(), round: 0, readonlyCheck: 'violation',
      tamper: { total: 1, paths: ['sample'], links: 0 } }, { ...end, seq: 2, ts: Date.now(), verification: { status: 'failed', attempts: 1, failed: ['unit'] } }])
    const review = await eventually(() => db.feishu.messages(task.id).find(m => m.role === 'review_card'))
    const json = transport.json(review.messageId)
    for (const text of ['送审原因：验证未通过', '验证失败：unit', 'TAMPER_RISK', 'READONLY_VIOLATION', '派修复任务']) expect(json).toContain(text)
    const clicked = await transport.click(review.messageId, 'ou_owner', { v: 1, a: 'fix', t: task.id, r: run.runId, ver: db.tasks.get(task.id)!.version })
    expect(clicked.toast.type).toBe('success')
    expect(db.tasks.getByNo(2)?.harnessRequestJson?.intent).toBe('fix')
  } finally { await cleanup() }
}, 15000)
it('F8 inherits a model only on the source adapter and honors explicit handoff models', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, workerOptions), api = hub.ctx.orchestrator
    const t = await api.createTask({ ...task, model: 'source-model' }, owner)
    await finish(hub, w, await dispatch(w, t.id))
    const token = hub.ctx.auth.createApiToken('handoff', ['admin'])
    for (const [adapter, model, expected] of [['mock', undefined, 'source-model'], ['codex', undefined, undefined],
      ['codex', 'chosen', 'chosen'], [undefined, undefined, undefined]] as const) {
      const res = await rest(hub)('POST', '/api/v1/tasks/' + t.id + '/handoff',
        { token, payload: { intent: 'relay', prompt: mockPrompt, adapter, model } })
      expect(res.status).toBe(201)
      const r = await dispatch(w, res.json<{ id: string }>().id)
      expect(r.model).toBe(expected)
      await finish(hub, w, r)
    }
  } finally { await cleanup() }
})
it('F9 rolls back readonly clamps and preserves the preceding write pointer', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const w = await FakeWorker.connect(hub, workerOptions), api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const first = await api.createTask(task, owner), a = await dispatch(w, first.id)
    await finish(hub, w, a)
    const next = await api.createTask(task, owner), b = await dispatch(w, next.id)
    await eventually(() => db.pointers.get('review', 'sandbox')?.lastAttemptRunId === b.runId)
    await finish(hub, w, b, undefined, undefined, 'readonly')
    expect(db.pointers.get('review', 'sandbox')).toMatchObject({ attemptCounter: 1, lastAttemptRunId: a.runId, lastAttemptSeq: 1 })
    expect(db.runs.get(b.runId)?.workspaceSeq).toBe(1)
    const last = await api.createTask(task, owner), c = await dispatch(w, last.id)
    await eventually(() => db.runs.get(c.runId)?.workspaceSeq === 2)
  } finally { await cleanup() }
})
