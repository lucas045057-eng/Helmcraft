/**
 * Pi 独立验收 · Phase 2 门禁：SC-1 ~ SC-16（调度器）
 * 使用 FakeClock + FakeWorkerClient；时间参数按 pi-test-matrix 头部约定缩短。
 */
import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import type { AdapterCapability, WorkspaceDecl } from '@agent-hub/protocol'
import { assertInvariants, delay, eventually, FakeWorker, openHarness, ownerActor, seedRun } from './pi/harness.js'

const cap = (id: AdapterCapability['id'], status: AdapterCapability['status'] = 'ready'): AdapterCapability =>
  ({ id, status, features: { resume: true, liveInput: true, structuredOutput: true } })
const ws = (id: string, allowedAdapters: AdapterCapability['id'][], maxProfile: WorkspaceDecl['maxProfile'] = 'full',
  maxConcurrent = 2): WorkspaceDecl => ({ id, label: id, allowedAdapters, maxProfile, maxConcurrent, isGitRepo: false })

const base = {
  server: { port: 0, allowInsecureWorker: true },
  workers: { ackIntervalMs: 20, cmdAckTimeoutMs: 5000 },
  orchestrator: {
    scheduler: { tickMs: 50, unschedulableWarnMs: 1, refuseBackoffMs: 200, scanLimit: 50 },
    tasks: { dispatchAckTimeoutMs: 5000 },
    limits: { maxActivePerRequester: 2, requesterTasksPerHour: 200 },
  },
}

async function harness(overrides: Record<string, unknown> = {}) {
  const clock = new FakeClock(1_000)
  const opened = await openHarness({ ...base, ...overrides } as never, { clock })
  return { ...opened, clock }
}

function create(hub: Awaited<ReturnType<typeof harness>>['hub'], input: Record<string, unknown>, actor = ownerActor) {
  return hub.ctx.orchestrator.createTask({ workspaceId: 'sandbox', ...input } as never, actor as never)
}

function hint(hub: Awaited<ReturnType<typeof harness>>['hub'], id: string) {
  return hub.ctx.orchestrator.getTask(id)?.scheduleHint
}

describe('SC-1 ~ SC-4 过滤（adapter / 工作区 / profile）', () => {
  it('SC-1 W1 仅 codex ready，任务要求 claude-code → 不派单，hint=NO_READY_ADAPTER', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc1', adapters: [cap('codex')] })
      const task = await create(hub, { prompt: 'need claude', adapter: 'claude-code' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'NO_READY_ADAPTER')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-2 adapterPrefs 回退：[gemini, codex] 且无 gemini → 选 codex', async () => {
    const { hub, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc2', adapters: [cap('codex')],
        workspaces: [ws('sandbox', ['codex'])] })
      const task = await create(hub, { prompt: 'prefs', adapterPrefs: ['gemini', 'codex'] })
      const dispatch = await worker.waitFor('run.dispatch', 3000)
      expect((dispatch.payload as { adapter: string }).adapter).toBe('codex')
      expect(hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.adapter).toBe('codex')
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-3 W1 无 workspace backend → 不派给 W1', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc3', workspaces: [ws('sandbox', ['mock'])] })
      const task = await create(hub, { prompt: 'backend', workspaceId: 'backend' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'WORKSPACE_UNAVAILABLE')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-4 workspace.maxProfile=readonly + 任务 edit → 不可调度，hint=PROFILE_NOT_ALLOWED', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc4', workspaces: [ws('sandbox', ['mock'], 'readonly')] })
      const task = await create(hub, { prompt: 'edit task', profile: 'edit' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'PROFILE_NOT_ALLOWED')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('SC-5 ~ SC-8 负载、平局与容量', () => {
  it('SC-5 最小负载：W1 1/4、W2 0/2 → 选 W2', async () => {
    const { hub, cleanup } = await harness()
    try {
      const w1 = await FakeWorker.connect(hub, { workerId: 'sc5-a', maxConcurrency: 4 })
      const w2 = await FakeWorker.connect(hub, { workerId: 'sc5-b', maxConcurrency: 2 })
      seedRun(hub, { workerId: 'sc5-a', taskStatus: 'running', runStatus: 'running', profile: 'readonly' })
      const task = await create(hub, { prompt: 'least loaded' })
      const dispatch = await Promise.race([w1.waitFor('run.dispatch', 3000).then(() => 'w1'),
        w2.waitFor('run.dispatch', 3000).then(() => 'w2')])
      expect(dispatch).toBe('w2')
      expect(hub.ctx.orchestrator.getTask(task.id)!.workerId).toBe('sc5-b')
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-6 平局打破：lastDispatchAt 早者优先，再按 id 字典序', async () => {
    const { hub, cleanup } = await harness()
    try {
      const older = await FakeWorker.connect(hub, { workerId: 'sc6-a' })
      const newer = await FakeWorker.connect(hub, { workerId: 'sc6-b' })
      hub.ctx.store.tx(db => {
        db.prepare("UPDATE workers SET last_dispatch_at = 100 WHERE id = 'sc6-a'").run()
        db.prepare("UPDATE workers SET last_dispatch_at = 900 WHERE id = 'sc6-b'").run()
      })
      const first = await create(hub, { prompt: 'tie one' })
      const winner = await Promise.race([older.waitFor('run.dispatch', 3000).then(() => 'a'), newer.waitFor('run.dispatch', 3000).then(() => 'b')])
      expect(winner).toBe('a')
      expect(hub.ctx.orchestrator.getTask(first.id)!.workerId).toBe('sc6-a')
      // 首单后 sc6-a 的 lastDispatchAt 变成 now，高于 sc6-b(900) → 第二单给 b
      const second = await create(hub, { prompt: 'tie two' })
      await eventually(() => hub.ctx.orchestrator.getTask(second.id)!.workerId === 'sc6-b')
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-7 容量含预留：maxConcurrency=1 且已有 1 个 dispatching → 不再派单', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc7', maxConcurrency: 1 })
      seedRun(hub, { workerId: 'sc7', taskStatus: 'dispatching', runStatus: 'dispatching' })
      const task = await create(hub, { prompt: 'no slot' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'NO_AVAILABLE_SLOT')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-8 工作区写锁：同 Worker 同工作区已有 edit Run → 第二个 edit 不派；readonly 可派', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc8', maxConcurrency: 2 })
      const first = await create(hub, { prompt: 'edit one', profile: 'edit' })
      await worker.waitFor('run.dispatch', 3000, frame => (frame.payload as { taskId: string }).taskId === first.id)
      const second = await create(hub, { prompt: 'edit two', profile: 'edit' })
      clock.advance(1100)
      await eventually(() => hint(hub, second.id) === 'NO_AVAILABLE_SLOT')
      expect(worker.count('run.dispatch')).toBe(1)
      const readonly = await create(hub, { prompt: 'read only', profile: 'readonly' })
      await worker.waitFor('run.dispatch', 3000, frame => (frame.payload as { taskId: string }).taskId === readonly.id)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('SC-9 ~ SC-13 队列与拒单', () => {
  it('SC-9 Drain：不派单；运行中的任务继续并能正常完成', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc9' })
      await hub.ctx.workers.setDrain('sc9', true, ownerActor)
      const task = await create(hub, { prompt: 'drained' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'NO_ONLINE_WORKER')
      expect(worker.count('run.dispatch')).toBe(0)
      // 运行中的任务不受 drain 影响
      const running = seedRun(hub, { workerId: 'sc9', taskStatus: 'running', runStatus: 'running' })
      worker.events(running.runId, running.taskId, [{ seq: 1, ts: 1, kind: 'finished', status: 'succeeded',
        exitCode: 0, signal: null, summary: 'ok', durationMs: 1 }])
      await eventually(() => hub.ctx.orchestrator.getTask(running.taskId)!.status === 'succeeded')
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-10 无队头阻塞：队首不可调度，第二个可调度 → 第二个被派发', async () => {
    const { hub, cleanup } = await harness()
    try {
      const blocked = await create(hub, { prompt: 'needs claude', adapter: 'claude-code' })
      const worker = await FakeWorker.connect(hub, { workerId: 'sc10' })
      const ready = await create(hub, { prompt: 'uses mock' })
      const dispatch = await worker.waitFor('run.dispatch', 3000)
      expect((dispatch.payload as { taskId: string }).taskId).toBe(ready.id)
      expect(hub.ctx.store.repos.runs.forTask(blocked.id)).toHaveLength(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-11 优先级与 FIFO：priority 高者先；同优先级 queued_at 早者先', async () => {
    const { hub, cleanup } = await harness()
    try {
      const lowFirst = await create(hub, { prompt: 'low first', priority: 0, profile: 'readonly' })
      const high = await create(hub, { prompt: 'high', priority: 5, profile: 'readonly' })
      const lowSecond = await create(hub, { prompt: 'low second', priority: 0, profile: 'readonly' })
      const worker = await FakeWorker.connect(hub, { workerId: 'sc11', maxConcurrency: 2 })
      await eventually(() => worker.frames.filter(frame => frame.type === 'run.dispatch').length === 2)
      const order = worker.frames.filter(frame => frame.type === 'run.dispatch')
        .map(frame => (frame.payload as { taskId: string }).taskId)
      expect(order).toEqual([high.id, lowFirst.id])
      expect(hub.ctx.store.repos.runs.forTask(lowSecond.id)).toHaveLength(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-12 硬亲和：requiredWorkerId=W2 且 W2 离线 → 保持 queued；W2 上线后派发', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const decoy = await FakeWorker.connect(hub, { workerId: 'sc12-a' })
      const task = await create(hub, { prompt: 'affinity', requiredWorkerId: 'sc12-b' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'NO_ONLINE_WORKER')
      expect(decoy.count('run.dispatch')).toBe(0)
      expect(hub.ctx.orchestrator.getTask(task.id)!.status).toBe('queued')
      const target = await FakeWorker.connect(hub, { workerId: 'sc12-b' })
      const dispatch = await target.waitFor('run.dispatch', 3000)
      expect((dispatch.payload as { taskId: string }).taskId).toBe(task.id)
      expect(hub.ctx.orchestrator.getTask(task.id)!.workerId).toBe('sc12-b')
      expect(decoy.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-13 拒单排斥：NO_SLOT → 回 queued，60s（测试缩短为 200ms）内不再派给 W1，attempt_count 不变', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc13' })
      const task = await create(hub, { prompt: 'refuse me' })
      const first = await worker.waitFor('run.dispatch', 3000)
      await worker.ackCommand(first, { ok: false, error: { code: 'NO_SLOT', message: 'full' } })
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'queued')
      const runs = hub.ctx.store.repos.runs.forTask(task.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('refused')
      expect(hub.ctx.store.repos.tasks.get(task.id)!.attemptCount).toBe(0)
      clock.advance(150)
      await delay(100)
      expect(worker.frames.filter(frame => frame.type === 'run.dispatch')).toHaveLength(1)
      clock.advance(1000)
      const second = await worker.waitFor('run.dispatch', 3000, frame => frame.id !== first.id)
      expect((second.payload as { taskId: string }).taskId).toBe(task.id)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('SC-14 ~ SC-16 公平性、单飞与 suspect', () => {
  it('SC-14 发起人并发上限：已有 2 个活动任务 → 第 3 个保持 queued', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc14', maxConcurrency: 4 })
      const requester = { type: 'requester', id: 'rq-14', channel: 'api' } as const
      seedRun(hub, { workerId: 'sc14', taskStatus: 'running', runStatus: 'running', profile: 'readonly', requesterType: 'requester', requesterId: 'rq-14' })
      seedRun(hub, { workerId: 'sc14', taskStatus: 'running', runStatus: 'running', profile: 'readonly', requesterType: 'requester', requesterId: 'rq-14' })
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'third', workspaceId: 'sandbox' }, requester)
      await hub.ctx.orchestrator.approve(task.id, ownerActor)
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'REQUESTER_LIMIT')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-15 单飞：1 ms 内触发 100 次 schedule → 只派发一次', async () => {
    const { hub, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc15' })
      const task = await create(hub, { prompt: 'single flight' })
      const view = hub.ctx.workers.get('sc15')!
      for (let index = 0; index < 100; index++) hub.ctx.emit('worker/updated', view, null)
      await worker.waitFor('run.dispatch', 3000)
      await delay(120)
      expect(worker.frames.filter(frame => frame.type === 'run.dispatch')).toHaveLength(1)
      expect(hub.ctx.store.repos.runs.forTask(task.id)).toHaveLength(1)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('SC-16 suspect Worker 不派单', async () => {
    const { hub, clock, cleanup } = await harness()
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'sc16' })
      hub.ctx.store.tx(db => { db.prepare("UPDATE workers SET connection = 'suspect' WHERE id = 'sc16'").run() })
      const task = await create(hub, { prompt: 'suspect' })
      clock.advance(1100)
      await eventually(() => hint(hub, task.id) === 'NO_ONLINE_WORKER')
      expect(worker.count('run.dispatch')).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})
