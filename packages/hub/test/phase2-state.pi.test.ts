/**
 * Pi 独立验收 · Phase 2 门禁：SM-13 / SM-14 / SM-15 / SM-16（状态机集成）
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FakeClock, taskId } from '@agent-hub/common'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { assertInvariants, delay, enrollWorker, eventually, FakeWorker, openHarness, ownerActor, seedRun, wsUrl } from './pi/harness.js'

it('SM-13 并发审批 50 次：恰好 1 次成功迁移，version +1，只产生 1 个 Run', async () => {
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true },
    workers: { ackIntervalMs: 20, cmdAckTimeoutMs: 2000 } })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'sm13' })
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'concurrent approve', workspaceId: 'sandbox', adapter: 'mock' },
      { type: 'requester', id: 'requester-1', channel: 'api' })
    expect(task.status).toBe('awaiting_approval')
    const versionBefore = task.version
    const results = await Promise.allSettled(Array.from({ length: 50 }, () =>
      hub.ctx.orchestrator.approve(task.id, ownerActor)))
    const fulfilled = results.filter(result => result.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    for (const rejected of results.filter(result => result.status === 'rejected')) {
      const error = (rejected as PromiseRejectedResult).reason as { code?: string }
      expect(['INVALID_TRANSITION', 'VERSION_CONFLICT']).toContain(error.code)
    }
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.status).toBe('queued')
    expect(detail.version).toBe(versionBefore + 1)
    const dispatch = await worker.waitFor('run.dispatch', 5000)
    await worker.ackCommand(dispatch)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running')
    expect(hub.ctx.store.repos.runs.forTask(task.id)).toHaveLength(1)
    expect(hub.ctx.store.repos.runs.forTask(task.id)[0]!.attempt).toBe(1)
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('SM-14 并发 cancel + RUN_SUCCEEDED：终态为 succeeded 或 cancelled 之一，INV 全部成立', async () => {
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true }, workers: { gracePeriodMs: 1000 } })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'sm14' })
    expect(worker.welcome).toBeTruthy()
    const seed = seedRun(hub, { workerId: 'sm14', taskStatus: 'running', runStatus: 'running' })
    const finished = { runId: seed.runId, taskId: seed.taskId, events: [{ seq: 1, ts: 1, kind: 'finished' as const,
      status: 'succeeded' as const, exitCode: 0, signal: null, summary: 'done', durationMs: 1 }] }
    const [cancelResult] = await Promise.allSettled([
      hub.ctx.orchestrator.cancel(seed.taskId, ownerActor),
      hub.ctx.orchestrator.onRunEvents('sm14', finished),
    ])
    // cancel 可能因竞态失败（不再是从 running），但绝不抛出意外错误
    if (cancelResult.status === 'rejected') {
      expect(['INVALID_TRANSITION', 'VERSION_CONFLICT']).toContain((cancelResult.reason as { code?: string }).code)
    }
    const detail = hub.ctx.orchestrator.getTask(seed.taskId)!
    expect(['succeeded', 'cancelled']).toContain(detail.status)
    const run = hub.ctx.store.repos.runs.get(seed.runId)!
    if (detail.status === 'succeeded') expect(run.status).toBe('succeeded')
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('SM-15 Hub 重启后从 DB 重建审批超时定时器', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sm15-'))
  const clock = new FakeClock(1_000)
  const config = { storage: { path: join(dir, 'hub.sqlite') }, orchestrator: { tasks: { approvalTimeoutMs: 2000 } } }
  try {
    const first_ = await openHarness(config, { clock, listen: false })
    const first = await first_.hub.ctx.orchestrator.createTask({ prompt: 'pending one', workspaceId: 'sandbox' },
      { type: 'requester', id: 'r1', channel: 'api' })
    const second = await first_.hub.ctx.orchestrator.createTask({ prompt: 'pending two', workspaceId: 'sandbox' },
      { type: 'requester', id: 'r2', channel: 'api' })
    expect(first.status).toBe('awaiting_approval')
    expect(second.status).toBe('awaiting_approval')
    await first_.cleanup()
    clock.advance(1_000)
    const reopened = await openHarness(config, { clock, listen: false })
    try {
      clock.advance(999)
      await delay(20)
      expect(reopened.hub.ctx.orchestrator.getTask(first.id)!.status).toBe('awaiting_approval')
      clock.advance(2)
      await eventually(() => reopened.hub.ctx.orchestrator.getTask(first.id)!.status === 'cancelled')
      await eventually(() => reopened.hub.ctx.orchestrator.getTask(second.id)!.status === 'cancelled')
      const detail = reopened.hub.ctx.orchestrator.getTask(first.id)!
      expect(detail.version).toBe(first.version + 1)
      // 定时器不会重复触发
      clock.advance(10_000)
      await delay(20)
      expect(reopened.hub.ctx.orchestrator.getTask(first.id)!.version).toBe(first.version + 1)
      assertInvariants(reopened.hub.ctx.store.repos)
    } finally { await reopened.cleanup() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('SM-16 mock need-input 输入超时 → awaiting_input → cancelling → cancelled(INPUT_TIMEOUT) 且进程被杀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-sm16-'))
  mkdirSync(join(dir, 'repo'))
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true },
    storage: { path: join(dir, 'hub.sqlite') }, orchestrator: { tasks: { inputTimeoutMs: 1500, approvalTimeoutMs: 60_000 } } })
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined
  try {
    const identity = await enrollWorker(hub, 'sm16')
    worker = await startWorker(WorkerConfigSchema.parse({ workerId: 'sm16', hub: { url: wsUrl(hub.address!) },
      adapters: { mock: { enabled: true } },
      workspaces: [{ id: 'sandbox', label: 'Sandbox', path: join(dir, 'repo'), allowedAdapters: ['mock'], maxProfile: 'full' }],
    }), { stateDir: join(dir, 'state'), random: () => 0, onWarning: () => undefined,
      identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint } })
    await eventually(() => hub.ctx.store.repos.workers.get('sm16')!.connection === 'online')
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: need-input', workspaceId: 'sandbox', adapter: 'mock' },
      ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'awaiting_input', { timeoutMs: 8000 })
    expect(hub.ctx.orchestrator.getTask(task.id)!.inputRequest?.requestId).toBeTruthy()
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'cancelled', { timeoutMs: 12_000 })
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.errorCode).toBe('INPUT_TIMEOUT')
    expect(detail.runs[0]!.status).toBe('cancelled')
    expect(detail.runs[0]!.errorCode).toBe('INPUT_TIMEOUT')
    // 进程被终止
    await eventually(() => worker!.runner.slotsUsed === 0, { timeoutMs: 8000 })
    const input = hub.ctx.store.repos.prepare('SELECT status FROM input_requests WHERE task_id = ?').all(task.id) as { status: string }[]
    expect(input.map(row => row.status)).toEqual(['expired'])
    assertInvariants(hub.ctx.store.repos)
  } finally {
    await worker?.close()
    await cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}, 45_000)

void taskId
