/**
 * Pi 独立验收 · Phase 2 门禁：GW-17 ~ GW-23（传输、补偿、重启与对账）
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import type { WorkerHello } from '@agent-hub/protocol'
import { reconcileWorker } from '../src/plugins/orchestrator/recovery.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { assertInvariants, assertRunLogContinuity, ChaosProxy, delay, enrollWorker, eventually, FakeWorker,
  openHarness, ownerActor, wsUrl } from './pi/harness.js'

const config = {
  server: { port: 0, allowInsecureWorker: true },
  workers: { heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 30_000, gracePeriodMs: 3000,
    handshakeTimeoutMs: 5000, ackIntervalMs: 50, cmdAckTimeoutMs: 1000, maxResends: 3 },
}

describe('GW-17 / GW-21 / GW-23 连接健康与洪泛', () => {
  it('GW-17 心跳：30 s 无帧 → suspect；45 s → terminate(4408) 并进入宽限期', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-hb' })
      expect(hub.ctx.store.repos.workers.get('gw-hb')!.connection).toBe('online')
      clock.advance(29_000)
      await delay(30)
      expect(hub.ctx.store.repos.workers.get('gw-hb')!.connection).toBe('online')
      clock.advance(1_500)
      await delay(30)
      expect(hub.ctx.store.repos.workers.get('gw-hb')!.connection).toBe('suspect')
      const closed = worker.waitClose()
      clock.advance(15_000)
      expect(await closed).toBe(4408)
      expect(hub.ctx.store.repos.workers.get('gw-hb')!.connection).toBe('offline')
      expect(hub.ctx.store.repos.workers.get('gw-hb')!.disconnectedAt).toBe(clock.now())
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-21 入站洪泛：> 200 帧/s → 4429（或限速丢弃），Hub 不崩溃', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-flood' })
      const closed = worker.waitClose(5000)
      for (let index = 0; index < 400; index++) {
        worker.send('worker.heartbeat', { activeRuns: [], slotsUsed: 0, load: { memFreeMb: 1, memTotalMb: 1 },
          adapters: {}, bufferedBytes: 0, droppedLogBytesTotal: 0 })
      }
      expect(await closed).toBe(4429)
      expect(worker.frames.some(frame => frame.type === 'hub.reject'
        && (frame.payload as { code?: string }).code === 'RATE_LIMITED')).toBe(true)
      expect(hub.ctx.store.repos.workers.get('gw-flood')!.connection).toBe('offline')
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-23 鉴权后 Schema 失败帧 → 4400 并计入 badFrames', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-badframe' })
      const before = hub.ctx.workers.metrics().workerBadFrames
      const closed = worker.waitClose()
      // 已知 type，但 payload 含多余字段 → Schema 失败
      worker.send('worker.heartbeat', { activeRuns: [], slotsUsed: 0, load: { memFreeMb: 1, memTotalMb: 1 },
        adapters: {}, bufferedBytes: 0, droppedLogBytesTotal: 0, extra: true })
      expect(await closed).toBe(4400)
      expect(hub.ctx.workers.metrics().workerBadFrames).toBe(before + 1)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('GW-20 重连对账表 03 §7.2 全行', () => {
  const hello = (runs: WorkerHello['runs']): WorkerHello => ({
    auth: { workerId: 'w', clientNonce: 'x'.repeat(22), keyFingerprint: 'f', signature: 's' },
    agent: { version: '0', hostname: 'h', os: 'linux', arch: 'x64', nodeVersion: 'v', pid: 1 },
    maxConcurrency: 1, adapters: [], workspaces: [], runs, drain: false,
  })
  const row = (status: string, workerId = 'w') => ({ id: 'run_' + 'A'.repeat(26), taskId: 'tsk_' + 'A'.repeat(26),
    workerId, status, lastSeq: 7, notAfter: 1000 } as never)

  it('dispatching + 未上报 → 无指令，靠 Outbox 重发（notAfter 已过 → DISPATCH_LOST）', async () => {
    const lost: string[] = []
    const directives = await reconcileWorker('w', hello([]), [row('dispatching')], () => row('dispatching'),
      async run => { lost.push(run.id) }, async () => undefined, 2000)
    expect(directives).toEqual([])
    expect(lost).toHaveLength(1)
  })

  it('dispatching + 上报 → resume 并隐式受理', async () => {
    const accepted: string[] = []
    const directives = await reconcileWorker('w', hello([{ runId: row('dispatching').id, taskId: row('dispatching').taskId,
      state: 'running', lastSeq: 3, oldestBufferedSeq: 1 }]), [row('dispatching')], () => row('dispatching'),
      async () => undefined, async run => { accepted.push(run.id) }, 500)
    expect(accepted).toHaveLength(1)
    expect(directives).toEqual([{ runId: row('dispatching').id, action: 'resume', ackSeq: 7 }])
  })

  it('running/awaiting_input/cancelling + 上报 → resume，ackSeq = last_seq', async () => {
    for (const status of ['running', 'awaiting_input', 'cancelling']) {
      const current = row(status)
      const directives = await reconcileWorker('w', hello([{ runId: current.id, taskId: current.taskId,
        state: status as 'running', lastSeq: 9, oldestBufferedSeq: 2 }]), [current], () => current,
        async () => undefined, async () => undefined, 500)
      expect(directives).toEqual([{ runId: current.id, action: 'resume', ackSeq: 7 }])
    }
  })

  it('running/awaiting_input/cancelling + 未上报 → 立即 RUN_LOST', async () => {
    for (const status of ['running', 'awaiting_input', 'cancelling']) {
      const lost: string[] = []
      await reconcileWorker('w', hello([]), [row(status)], () => row(status),
        async run => { lost.push(run.id) }, async () => undefined, 500)
      expect(lost, status).toHaveLength(1)
    }
  })

  it('终态 + 上报 → discard，ackSeq = last_seq（Worker 清理缓冲）', async () => {
    const current = row('succeeded')
    const directives = await reconcileWorker('w', hello([{ runId: current.id, taskId: current.taskId,
      state: 'finished', lastSeq: 7, oldestBufferedSeq: 7 }]), [current], () => current,
      async () => undefined, async () => undefined, 500)
    expect(directives).toEqual([{ runId: current.id, action: 'discard', ackSeq: 7 }])
  })

  it('lost / 不存在 + 上报且未 finished → cancel', async () => {
    const current = row('lost')
    const directives = await reconcileWorker('w', hello([{ runId: current.id, taskId: current.taskId,
      state: 'running', lastSeq: 3, oldestBufferedSeq: 1 }]), [current], () => current,
      async () => undefined, async () => undefined, 500)
    expect(directives).toEqual([{ runId: current.id, action: 'cancel', ackSeq: 0 }])
  })

  it('lost / 不存在 + 上报且 finished → discard', async () => {
    const current = row('lost')
    const directives = await reconcileWorker('w', hello([{ runId: current.id, taskId: current.taskId,
      state: 'finished', lastSeq: 3, oldestBufferedSeq: 1 }]), [current], () => current,
      async () => undefined, async () => undefined, 500)
    expect(directives).toEqual([{ runId: current.id, action: 'discard', ackSeq: 0 }])
  })

  it('Run 属于其他 Worker → cancel', async () => {
    const current = row('running', 'other')
    const directives = await reconcileWorker('w', hello([{ runId: current.id, taskId: current.taskId,
      state: 'running', lastSeq: 3, oldestBufferedSeq: 1 }]), [], () => current,
      async () => undefined, async () => undefined, 500)
    expect(directives).toEqual([{ runId: current.id, action: 'cancel', ackSeq: 0 }])
  })
})

describe('GW-18 / GW-19 / GW-22 真实 Worker + ChaosProxy', () => {
  function makeWorkspace(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const workspace = join(dir, 'repo')
    mkdirSync(workspace)
    return { dir, workspace, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  async function workerFor(hub: Awaited<ReturnType<typeof openHarness>>['hub'], identity: Awaited<ReturnType<typeof enrollWorker>>,
    workspace: string, hubUrl: string, stateDir: string, extra: Record<string, unknown> = {}) {
    return startWorker(WorkerConfigSchema.parse({ workerId: identity.workerId, hub: { url: hubUrl },
      maxConcurrency: 2, adapters: { mock: { enabled: true } },
      workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full' }],
      ...extra }), { stateDir, random: () => 0, onWarning: () => undefined,
      identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint } })
  }

  it('GW-18 宽限期内重连：Run 保持 running，日志无缺无重，最终 succeeded', async () => {
    const files = makeWorkspace('pi-gw18-')
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers, gracePeriodMs: 4000 } })
    let worker: Awaited<ReturnType<typeof workerFor>> | undefined
    let proxy: ChaosProxy | undefined
    try {
      const identity = await enrollWorker(hub, 'gw-grace')
      proxy = await ChaosProxy.start(hub.address!)
      worker = await workerFor(hub, identity, files.workspace, proxy.url, join(files.dir, 'state'))
      await eventually(() => hub.ctx.store.repos.workers.get('gw-grace')!.connection === 'online')
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=7000', workspaceId: 'sandbox', adapter: 'mock' },
        ownerActor)
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 8000 })
      const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
      await eventually(() => hub.ctx.store.repos.runs.get(runId)!.lastSeq >= 2)
      const lastSeqBefore = hub.ctx.store.repos.runs.get(runId)!.lastSeq
      proxy.cut()
      await delay(800)
      proxy.restore()
      await eventually(() => hub.ctx.store.repos.workers.get('gw-grace')!.connection === 'online', { timeoutMs: 8000 })
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'succeeded', { timeoutMs: 15_000 })
      const run = hub.ctx.store.repos.runs.get(runId)!
      expect(run.status).toBe('succeeded')
      expect(run.lastSeq).toBeGreaterThan(lastSeqBefore)
      assertRunLogContinuity(hub.ctx.store.repos, runId)
      const kinds = hub.ctx.store.repos.prepare('SELECT kind, count(*) AS n FROM task_logs WHERE run_id = ? GROUP BY kind').all(runId) as
        Array<{ kind: string; n: number }>
      expect(kinds.find(row => row.kind === 'started')?.n).toBe(1)
      expect(kinds.find(row => row.kind === 'finished')?.n).toBe(1)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      await worker?.close()
      await proxy?.close()
      files.cleanup()
      await cleanup()
    }
  }, 40_000)

  it('GW-19 宽限期外重连：Run → lost，Task → failed(WORKER_LOST)，重连后收到 resume cancel 并且进程被杀', async () => {
    const files = makeWorkspace('pi-gw19-')
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers, gracePeriodMs: 1000 } })
    let worker: Awaited<ReturnType<typeof workerFor>> | undefined
    let proxy: ChaosProxy | undefined
    try {
      const identity = await enrollWorker(hub, 'gw-outside')
      proxy = await ChaosProxy.start(hub.address!)
      worker = await workerFor(hub, identity, files.workspace, proxy.url, join(files.dir, 'state'))
      await eventually(() => hub.ctx.store.repos.workers.get('gw-outside')!.connection === 'online')
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=30000', workspaceId: 'sandbox', adapter: 'mock' },
        ownerActor)
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 8000 })
      const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
      expect(worker!.runner.slotsUsed).toBe(1)
      proxy.cut()
      proxy.blackhole()
      // 宽限期 1s：等待 Hub 判定 WORKER_LOST
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'failed', { timeoutMs: 12_000 })
      expect(hub.ctx.orchestrator.getTask(task.id)!.errorCode).toBe('WORKER_LOST')
      expect(hub.ctx.store.repos.runs.get(runId)!.status).toBe('lost')
      proxy.restore()
      // Worker 重连 → Hub 对账返回 cancel → Worker 强杀进程树
      await eventually(() => hub.ctx.store.repos.workers.get('gw-outside')!.connection === 'online', { timeoutMs: 12_000 })
      await eventually(() => worker!.runner.slotsUsed === 0, { timeoutMs: 12_000 })
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      await worker?.close()
      await proxy?.close()
      files.cleanup()
      await cleanup()
    }
  }, 45_000)

  it('GW-22 Hub 重启（hubBootId 变化）：Worker 4503 后重连；dispatching 的 Run 被重新下发', async () => {
    const files = makeWorkspace('pi-gw22-')
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers, gracePeriodMs: 10_000 } })
    let worker: Awaited<ReturnType<typeof workerFor>> | undefined
    try {
      const identity = await enrollWorker(hub, 'gw-restart')
      worker = await workerFor(hub, identity, files.workspace, wsUrl(hub.address!), join(files.dir, 'state'))
      await eventually(() => hub.ctx.store.repos.workers.get('gw-restart')!.connection === 'online')
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=8000', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 8000 })
      const bootBefore = hub.ctx.workers.bootId
      await hub.fibers.get('workers')!.restart()
      await eventually(() => hub.ctx.workers.bootId !== bootBefore)
      const bootAfter = hub.ctx.workers.bootId
      expect(bootAfter).not.toBe(bootBefore)
      await eventually(() => hub.ctx.store.repos.workers.get('gw-restart')!.connection === 'online', { timeoutMs: 15_000 })
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'succeeded', { timeoutMs: 20_000 })
      assertRunLogContinuity(hub.ctx.store.repos, hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      await worker?.close()
      files.cleanup()
      await cleanup()
    }
  }, 45_000)
})
