/**
 * Pi 独立验收 · Phase 2 门禁：E2E-1 ~ E2E-8（真实 Hub + 真实 Worker + mock-cli）
 * E2E-7 使用独立 Hub 子进程；其余在进程内组装真实插件 + 真实 Worker 进程。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertInvariants, assertRunLogContinuity, ChaosProxy, delay, enrollWorker, eventually, openHarness,
  ownerActor, wsUrl } from './pi/harness.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

function files(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(dir, 'repo')
  mkdirSync(workspace)
  return { dir, workspace, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function workerFor(hub: Awaited<ReturnType<typeof openHarness>>['hub'], workerId: string,
  workspace: string, stateDir: string, hubUrl?: string, extra: Record<string, unknown> = {}) {
  const identity = await enrollWorker(hub, workerId)
  const worker = await startWorker(WorkerConfigSchema.parse({
    workerId, hub: { url: hubUrl ?? wsUrl(hub.address!) }, maxConcurrency: 2,
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full' }],
    ...extra,
  }), { stateDir, random: () => 0, onWarning: () => undefined,
    identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint },
  })
  await eventually(() => hub.ctx.store.repos.workers.get(workerId)?.connection === 'online', { timeoutMs: 10_000 })
  return worker
}

it('E2E-1 建任务 → mock success：succeeded，日志完整，summary 正确，INV 成立', async () => {
  const fs = files('pi-e2e1-')
  const { hub, cleanup } = await openHarness()
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  try {
    worker = await workerFor(hub, 'e2e1', fs.workspace, join(fs.dir, 'state'))
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: success n=5', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'succeeded', { timeoutMs: 15_000 })
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.resultSummary).toBe('Mock response 5')
    const runId = detail.runs[0]!.id
    const logs = hub.ctx.store.repos.prepare('SELECT kind FROM task_logs WHERE run_id = ? ORDER BY seq').all(runId) as Array<{ kind: string }>
    expect(logs.filter(row => row.kind === 'started')).toHaveLength(1)
    expect(logs.at(-1)!.kind).toBe('finished')
    assertRunLogContinuity(hub.ctx.store.repos, runId)
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); fs.cleanup(); await cleanup() }
}, 60_000)

it('E2E-2 mock fail → failed(NONZERO_EXIT) → retry → 第二个 Run succeeded', async () => {
  const fs = files('pi-e2e2-')
  const { hub, cleanup } = await openHarness()
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  try {
    worker = await workerFor(hub, 'e2e2', fs.workspace, join(fs.dir, 'state'))
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: fail code=2', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'failed', { timeoutMs: 15_000 })
    expect(hub.ctx.orchestrator.getTask(task.id)!.errorCode).toBe('NONZERO_EXIT')
    await hub.ctx.orchestrator.retry(task.id, ownerActor, { overrides: { prompt: '#scenario: success n=2' } })
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'succeeded', { timeoutMs: 15_000 })
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.runs).toHaveLength(2)
    expect(detail.runs[0]!.status).toBe('succeeded')
    expect(detail.resultSummary).toBe('Mock response 2')
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); fs.cleanup(); await cleanup() }
}, 60_000)

it('E2E-3 取消运行中任务：cancelled，无残留进程', async () => {
  const fs = files('pi-e2e3-')
  const { hub, cleanup } = await openHarness()
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  try {
    worker = await workerFor(hub, 'e2e3', fs.workspace, join(fs.dir, 'state'))
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=60000', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 15_000 })
    const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
    const pid = hub.ctx.store.repos.runs.get(runId)!.pid!
    expect(pid).toBeGreaterThan(0)
    await hub.ctx.orchestrator.cancel(task.id, ownerActor, {})
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'cancelled', { timeoutMs: 20_000 })
    await eventually(() => { try { process.kill(pid, 0); return false } catch { return true } }, { timeoutMs: 15_000 })
    expect(worker.runner.slotsUsed).toBe(0)
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); fs.cleanup(); await cleanup() }
}, 90_000)

it('E2E-4 超时：timed_out', async () => {
  const fs = files('pi-e2e4-')
  const { hub, cleanup } = await openHarness()
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  try {
    worker = await workerFor(hub, 'e2e4', fs.workspace, join(fs.dir, 'state'))
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=180000', workspaceId: 'sandbox',
      adapter: 'mock', timeoutMs: 60_000 }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'timed_out', { timeoutMs: 90_000 })
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.status).toBe('timed_out')
    expect(detail.runs[0]!.errorCode).toBe('TIMEOUT')
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); fs.cleanup(); await cleanup() }
}, 150_000)

it('E2E-5 宽限期内断网（ChaosProxy cut）：succeeded，日志无缺无重', async () => {
  const fs = files('pi-e2e5-')
  const { hub, cleanup } = await openHarness({ workers: { gracePeriodMs: 10_000 } })
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  let proxy: ChaosProxy | undefined
  try {
    proxy = await ChaosProxy.start(hub.address!)
    worker = await workerFor(hub, 'e2e5', fs.workspace, join(fs.dir, 'state'), proxy.url)
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=9000', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 15_000 })
    const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
    await eventually(() => hub.ctx.store.repos.runs.get(runId)!.lastSeq >= 2)
    proxy.cut()
    await delay(1500)
    proxy.cut()
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'succeeded', { timeoutMs: 30_000 })
    assertRunLogContinuity(hub.ctx.store.repos, runId)
    const counts = hub.ctx.store.repos.prepare('SELECT kind, count(*) AS n FROM task_logs WHERE run_id = ? GROUP BY kind').all(runId) as
      Array<{ kind: string; n: number }>
    expect(counts.find(row => row.kind === 'started')?.n).toBe(1)
    expect(counts.find(row => row.kind === 'finished')?.n).toBe(1)
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); await proxy?.close(); fs.cleanup(); await cleanup() }
}, 90_000)

it('E2E-6 宽限期外断网：failed(WORKER_LOST)，Worker 恢复后进程被杀', async () => {
  const fs = files('pi-e2e6-')
  const { hub, cleanup } = await openHarness({ workers: { gracePeriodMs: 1000 } })
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  let proxy: ChaosProxy | undefined
  try {
    proxy = await ChaosProxy.start(hub.address!)
    worker = await workerFor(hub, 'e2e6', fs.workspace, join(fs.dir, 'state'), proxy.url)
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=60000', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running', { timeoutMs: 15_000 })
    const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
    const pid = hub.ctx.store.repos.runs.get(runId)!.pid!
    proxy.cut()
    proxy.blackhole()
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'failed', { timeoutMs: 20_000 })
    expect(hub.ctx.orchestrator.getTask(task.id)!.errorCode).toBe('WORKER_LOST')
    proxy.restore()
    await eventually(() => hub.ctx.store.repos.workers.get('e2e6')?.connection === 'online', { timeoutMs: 25_000 })
    await eventually(() => worker!.runner.slotsUsed === 0, { timeoutMs: 20_000 })
    await eventually(() => { try { process.kill(pid, 0); return false } catch { return true } }, { timeoutMs: 15_000 })
    assertInvariants(hub.ctx.store.repos)
  } finally { await worker?.close(); await proxy?.close(); fs.cleanup(); await cleanup() }
}, 120_000)

it('E2E-8 两个 Worker：一个满载一个空闲 → 派给空闲者；drain 一个后全部派给另一个', async () => {
  const fs = files('pi-e2e8-')
  const { hub, cleanup } = await openHarness()
  let busy: Awaited<ReturnType<typeof workerFor>> | undefined
  let idle: Awaited<ReturnType<typeof workerFor>> | undefined
  try {
    busy = await workerFor(hub, 'e2e8-a', fs.workspace, join(fs.dir, 'a'), undefined, { maxConcurrency: 1 })
    idle = await workerFor(hub, 'e2e8-b', fs.workspace, join(fs.dir, 'b'), undefined, { maxConcurrency: 2 })
    // 占满 a
    const blocker = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=20000', workspaceId: 'sandbox',
      adapter: 'mock', requiredWorkerId: 'e2e8-a' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(blocker.id)!.status === 'running', { timeoutMs: 15_000 })
    const second = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: success', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(second.id)!.workerId === 'e2e8-b', { timeoutMs: 15_000 })
    // drain b → 后续任务派给 a
    await hub.ctx.workers.setDrain('e2e8-b', true, ownerActor)
    await hub.ctx.orchestrator.cancel(blocker.id, ownerActor, {})
    await eventually(() => hub.ctx.orchestrator.getTask(blocker.id)!.status === 'cancelled', { timeoutMs: 20_000 })
    const third = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: success', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
    await eventually(() => hub.ctx.orchestrator.getTask(third.id)!.workerId === 'e2e8-a', { timeoutMs: 20_000 })
    await eventually(() => hub.ctx.orchestrator.getTask(third.id)!.status === 'succeeded', { timeoutMs: 20_000 })
    assertInvariants(hub.ctx.store.repos)
  } finally { await busy?.close(); await idle?.close(); fs.cleanup(); await cleanup() }
}, 120_000)
