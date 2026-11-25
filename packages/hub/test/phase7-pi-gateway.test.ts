/**
 * Pi 独立验收 · Phase 7a 能力协商与向后兼容（HP-6 ~ HP-10、HP-13 ~ HP-15）。
 *
 * 这些用例刻意不调用 Codex 的 phase7-*.test.ts，独立构造裸协议连接与冻结字段表。
 */
import { WebSocket } from 'ws'
import { expect, it } from 'vitest'
import { RunDispatch, WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import { assertInvariants, enrollWorker, eventually, FakeWorker, openHarness, wsUrl } from './pi/harness.js'
import { assertPhase6Dispatch, assertPhase6Event, assertPhase6Welcome, PHASE6_FORBIDDEN_KINDS, unexpectedKeys,
  PHASE6_WELCOME_KEYS } from './pi/frozen.js'
import { assertHarnessInvariants } from './pi/invariants.js'
import { capabilities, dispatch, finish, mockPrompt, owner } from './pi/phase7.js'

it('HP-6 omits every capability surface for a worker without the upgrade header', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-nocap' })
    expect(worker.welcome).toBeDefined()
    // 字段必须整体省略，而不是 undefined / null（C-6）。
    expect(Object.keys(worker.welcome!)).not.toContain('capabilities')
    expect(unexpectedKeys(worker.welcome!, PHASE6_WELCOME_KEYS)).toEqual([])
    expect(hub.ctx.store.repos.workers.get('pi-nocap')?.protocolCapsJson).toBeNull()
    expect(hub.ctx.workers.get('pi-nocap')).not.toHaveProperty('protocolCapabilities')
    expect(hub.ctx.workers.capabilities('pi-nocap')).toEqual([])
    expect(hub.ctx.workers.capabilities('unknown-worker')).toEqual([])
    // 无能力 → 派发载荷与 Phase 6 逐字节同形。
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'ordinary', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const run = await dispatch(worker, task.id)
    expect(unexpectedKeys(run as unknown as Record<string, unknown>, ['taskId', 'runId', 'taskNo', 'attempt', 'adapter',
      'workspaceId', 'profile', 'prompt', 'timeoutMs', 'idleTimeoutMs', 'notAfter', 'origin'])).toEqual([])
    assertPhase6Dispatch(run)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('HP-7/HP-8 negotiate the intersection, drop unknown tokens and keep all-invalid headers connected', async () => {
  const { hub, cleanup } = await openHarness({ workers: { capabilities: ['blackboard.v1'] } })
  try {
    // 7a Hub 默认只提供 blackboard.v1（08 §8.1）：verify.v1 属于 7b 灰度增量。
    const both = await FakeWorker.connect(hub, { workerId: 'pi-both', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1,foo.v1' } })
    expect(both.welcome?.capabilities).toEqual(['blackboard.v1'])
    const verifyOnly = await FakeWorker.connect(hub, { workerId: 'pi-verify', headers: { 'X-Agent-Hub-Capabilities': 'verify.v1,foo.v1' } })
    expect(verifyOnly.welcome?.capabilities).toEqual([])
    const blackboardOnly = await FakeWorker.connect(hub, { workerId: 'pi-bb', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1' } })
    expect(blackboardOnly.welcome?.capabilities).toEqual(['blackboard.v1'])
    const junk = await FakeWorker.connect(hub, { workerId: 'pi-junk', headers: { 'X-Agent-Hub-Capabilities': '!!!,???,.v1' } })
    expect(junk.closeCode).toBeUndefined()
    expect(junk.welcome?.capabilities).toEqual([])
    expect(hub.ctx.workers.capabilities('pi-junk')).toEqual([])
    expect(hub.ctx.store.repos.workers.get('pi-junk')?.protocolCapsJson).toEqual([])
    // 大小写与重复去重（字典序）
    const messy = await FakeWorker.connect(hub, { workerId: 'pi-messy',
      headers: { 'X-Agent-Hub-Capabilities': ' verify.v1 , blackboard.v1 ,blackboard.v1, blackboard.v1 ' } })
    expect(messy.welcome?.capabilities).toEqual(['blackboard.v1'])
    for (const worker of [both, verifyOnly, blackboardOnly, junk, messy]) worker.close()
  } finally { await cleanup() }
})

it('HP-9 still rejects an upgrade offering more than one subprotocol', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    await enrollWorker(hub, 'pi-sub')
    const socket = new WebSocket(wsUrl(hub.address!), [WORKER_SUBPROTOCOL, 'extra.v1'] as unknown as string,
      { headers: { 'X-Worker-Id': 'pi-sub', 'X-Agent-Hub-Capabilities': 'blackboard.v1' } })
    const outcome = await new Promise<string>(resolve => {
      socket.on('open', () => resolve('open'))
      socket.on('unexpected-response', (_request, response) => resolve('http ' + response.statusCode))
      socket.on('error', () => resolve('error'))
      setTimeout(() => resolve('timeout'), 5000)
    })
    socket.terminate()
    expect(outcome).toBe('http 400')
  } finally { await cleanup() }
})

it('HP-10 keeps the negotiated set on a live connection while hot updates apply to the next one', async () => {
  const { hub, cleanup } = await openHarness({ workers: { capabilities: ['blackboard.v1'] } })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-hot', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' } })
    expect(worker.welcome?.capabilities).toEqual(['blackboard.v1'])
    await hub.fibers.get('workers')!.update({ ...hub.config.workers, capabilities: ['blackboard.v1', 'verify.v1'] })
    // 已有连接保留重连时的协商结果，不会被热更新改写。
    expect(hub.ctx.workers.capabilities('pi-hot')).toEqual(['blackboard.v1'])
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    expect((await dispatch(worker, task.id)).harness?.verify).toBeUndefined()
    const reconnect = await FakeWorker.connect(hub, { workerId: 'pi-hot', identity: worker.identity, headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' } })
    expect(reconnect.welcome?.capabilities).toEqual(['blackboard.v1', 'verify.v1'])
    expect(hub.ctx.workers.capabilities('pi-hot')).toEqual(['blackboard.v1', 'verify.v1'])
  } finally { await cleanup() }
})

it('HP-13 parses every frame of an unnegotiated worker with the frozen Phase 6 schema', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-legacy-out' })
    assertPhase6Welcome(worker.welcome)
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'legacy task', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const run = await dispatch(worker, task.id)
    const events = [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock' },
      { kind: 'session', cliSessionId: 'legacy-session' },
      { kind: 'progress', phase: 'working' },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'ok', durationMs: 1 },
    ].map((item, index) => ({ ...item, seq: index + 1, ts: Date.now() }))
    worker.events(run.runId, run.taskId, events)
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    for (const event of events) assertPhase6Event(event)
    for (const kind of PHASE6_FORBIDDEN_KINDS) expect(events.some(event => event.kind === kind)).toBe(false)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('HP-14 keeps every Hub frame parseable by Phase 6 while no capability is declared', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-legacy-in' })
    assertPhase6Welcome(worker.welcome)
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    const dispatchFrame = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === task.id)
    assertPhase6Dispatch(dispatchFrame.payload)
    expect(RunDispatch.parse(dispatchFrame.payload)).not.toHaveProperty('harness')
    const run = RunDispatch.parse(dispatchFrame.payload)
    await worker.ackCommand(dispatchFrame)
    await finish(hub, worker, run)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('HP-15 refuses a stale harness dispatch after a capability-less reconnect and re-dispatches without it', async () => {
  const { hub, cleanup } = await openHarness({ orchestrator: { scheduler: { refuseBackoffMs: 120, tickMs: 100, scanLimit: 200 } } })
  try {
    const workerId = 'pi-refuse'
    const worker = await FakeWorker.connect(hub, { workerId, headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    const pending = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === task.id)
    expect(RunDispatch.parse(pending.payload).harness).toBeDefined()
    // 未 ack 就断线，再以无能力身份重连：Hub 会重发同一份（已冻结的）harness 载荷。
    worker.terminate()
    const legacy = await FakeWorker.connect(hub, { workerId, identity: worker.identity })
    const resent = await legacy.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === task.id)
    const resentRun = RunDispatch.parse(resent.payload)
    expect(resentRun.runId).toBe(RunDispatch.parse(pending.payload).runId)
    expect(resentRun.harness).toEqual(RunDispatch.parse(pending.payload).harness)
    await legacy.ackCommand(resent, { ok: false, error: { code: 'INVALID', message: 'harness unsupported' } })
    // RUN_REFUSED → 重新入队；refuseBackoffMs 过后同一 Worker 才会被重新选中，新 Run 不再带 harness。
    const retried = await eventually(async () => {
      const frame = legacy.frames.find(candidate => candidate.type === 'run.dispatch'
        && (candidate.payload as RunDispatch).taskId === task.id && (candidate.payload as RunDispatch).runId !== resentRun.runId)
      return frame
    }, { timeoutMs: 8000 }) as { payload: unknown }
    expect(RunDispatch.parse(retried.payload)).not.toHaveProperty('harness')
    expect(hub.ctx.orchestrator.getTask(task.id)?.runs.length).toBeGreaterThanOrEqual(2)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 20000)
