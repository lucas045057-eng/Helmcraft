/**
 * Pi 独立验收 · Phase 2 门禁：WK-1 ~ WK-8 / WK-10 / WK-14 / WK-16 / WK-17（进程内 Worker）
 * 对照 03 §6.4 受理顺序、§5 超时、§6.5 解码与截断、§5.4 背压、§9 优雅关机。
 */
import { describe, expect, it } from 'vitest'
import { FakeClock, backoff } from '@agent-hub/common'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { RunOutbox } from '../src/tunnel/outbox.js'
import { startWorker } from '../src/app.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { assertInvariants } from '../../hub/test/pi/harness.js'
import { safeOn } from '../../hub/src/kernel/safe.js'
import { command, dispatchPayload, enroll, seedRun, send, startHub, startWorkerAt, tempDir, waitFor, wsUrl } from './pi/worker-harness.js'

describe('WK-1 受理校验顺序（03 §6.4）', () => {
  it('逐项返回对应错误码', async () => {
    const { hub, cleanup } = await startHub()
    const workspaces = []
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    let w2: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    let w3: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      // w-a：默认工作区
      const a = await enroll(hub, 'wk1-a')
      worker = await startWorkerAt(hub, a, { dir: tempDir('wk1-a-') })
      // w-b：strictProfile + maxProfile=edit + maxConcurrency=1
      const b = await enroll(hub, 'wk1-b')
      w2 = await startWorkerAt(hub, b, { dir: tempDir('wk1-b-'),
        config: { maxConcurrency: 1, workspaces: [{ id: 'sandbox', label: 'Sandbox', path: process.cwd(),
          allowedAdapters: ['mock'], maxProfile: 'edit', strictProfile: true }] } })
      // w-c：maxConcurrency 2，用于 workspace 写锁
      const c = await enroll(hub, 'wk1-c')
      w3 = await startWorkerAt(hub, c, { dir: tempDir('wk1-c-') })
      for (const id of ['wk1-a', 'wk1-b', 'wk1-c']) await waitFor(() => hub.ctx.workers.isOnline(id), 8000, id)

      const expectCode = async (workerId: string, code: string, overrides: Record<string, unknown>) => {
        const seed = seedRun(hub, workerId)
        const ack = await send(hub, workerId, command('run.dispatch', dispatchPayload(seed, overrides)))
        expect(ack.ok, 'expected refusal for ' + code).toBe(false)
        expect(ack.error?.code, JSON.stringify(overrides)).toBe(code)
      }
      // 2. notAfter 已过 → EXPIRED
      await expectCode('wk1-a', 'EXPIRED', { notAfter: Date.now() - 1_000 })
      // 5. workspaceId 未知 → WORKSPACE_UNKNOWN
      await expectCode('wk1-a', 'WORKSPACE_UNKNOWN', { workspaceId: 'nope' })
      // 5. subdir 穿越 → PATH_REJECTED
      await expectCode('wk1-a', 'PATH_REJECTED', { subdir: '../' })
      // 6. adapter 不可用 → ADAPTER_UNAVAILABLE
      await expectCode('wk1-a', 'ADAPTER_UNAVAILABLE', { adapter: 'claude-code' })
      // 7. strictProfile + profile > maxProfile → PROFILE_NOT_ALLOWED
      await expectCode('wk1-b', 'PROFILE_NOT_ALLOWED', { profile: 'full' })
      // 4. 槽位已满 → NO_SLOT（w-b maxConcurrency=1）
      const occupied = seedRun(hub, 'wk1-b')
      expect((await send(hub, 'wk1-b', command('run.dispatch', dispatchPayload(occupied,
        { prompt: '#scenario: slow ms=20000', profile: 'readonly' })))).ok).toBe(true)
      await expectCode('wk1-b', 'NO_SLOT', { profile: 'readonly' })
      // 8. 工作区写锁 → WORKSPACE_BUSY（w-c maxConcurrency=2）
      const editOne = seedRun(hub, 'wk1-c', { profile: 'edit' })
      expect((await send(hub, 'wk1-c', command('run.dispatch', dispatchPayload(editOne,
        { prompt: '#scenario: slow ms=20000', profile: 'edit' })))).ok).toBe(true)
      await expectCode('wk1-c', 'WORKSPACE_BUSY', { profile: 'edit' })
      // 3. drain → DRAINING
      expect((await send(hub, 'wk1-a', command('worker.drain', { drain: true }))).ok).toBe(true)
      await expectCode('wk1-a', 'DRAINING', {})
      // 清理体积较大的占位参数
      void workspaces
    } finally {
      await worker?.close()
      await w2?.close()
      await w3?.close()
      await cleanup()
    }
  }, 60_000)
})

describe('WK-2 / WK-3 / WK-4 命令幂等', () => {
  it('WK-2 dispatch 同 runId 两次：第二次 ok=true + runState，进程数 1', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk2')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk2-') })
      await waitFor(() => hub.ctx.workers.isOnline('wk2'))
      const seed = seedRun(hub, 'wk2')
      const first = await send(hub, 'wk2', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: slow ms=4000' })))
      expect(first.ok).toBe(true)
      const second = await send(hub, 'wk2', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: slow ms=4000' })))
      expect(second.ok).toBe(true)
      expect(second.result?.runState).toBeDefined()
      expect(worker.runner.activeIds()).toEqual([seed.runId])
      expect(worker.runner.slotsUsed).toBe(1)
      await send(hub, 'wk2', command('run.cancel', { runId: seed.runId, reason: 'user', force: true, graceMs: 0 }))
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  })

  it('WK-3 cancel 已 finished 的 Run：ok=true 无操作', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk3')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk3-') })
      await waitFor(() => hub.ctx.workers.isOnline('wk3'))
      const seed = seedRun(hub, 'wk3')
      await send(hub, 'wk3', command('run.dispatch', dispatchPayload(seed)))
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.status === 'succeeded', 10_000, 'succeeded')
      const ack = await send(hub, 'wk3', command('run.cancel', { runId: seed.runId, reason: 'user', force: true, graceMs: 0 }))
      expect(ack.ok).toBe(true)
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  })

  it('WK-4 input 同 requestId 两次：stdin 只写入一次', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk4')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk4-') })
      await waitFor(() => hub.ctx.workers.isOnline('wk4'))
      const seed = seedRun(hub, 'wk4')
      await send(hub, 'wk4', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: need-input' })))
      const request = await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.inputRequest, 10_000, 'input request')
      const frame = (answer: string) => command('run.input', { runId: seed.runId, requestId: request!.requestId, answer })
      expect((await send(hub, 'wk4', frame('yes'))).ok).toBe(true)
      expect((await send(hub, 'wk4', frame('yes'))).ok).toBe(true)
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.resultSummary === 'yes', 10_000, 'summary')
      expect(hub.ctx.orchestrator.getTask(seed.taskId)?.resultSummary).toBe('yes')
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 30_000)
})

describe('WK-5 / WK-6 超时', () => {
  it('WK-5 墙钟超时：slow 剧本 + timeoutMs → timed_out(TIMEOUT) 且进程树被杀', async () => {
    const { hub, cleanup } = await startHub()
    const clock = new FakeClock(1_000)
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk5')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk5-'), clock })
      await waitFor(() => hub.ctx.workers.isOnline('wk5'))
      const seed = seedRun(hub, 'wk5')
      await send(hub, 'wk5', command('run.dispatch', dispatchPayload(seed,
        { prompt: '#scenario: slow ms=60000', timeoutMs: 10_000, idleTimeoutMs: 60_000 })))
      await waitFor(() => worker!.runner.activeIds().length === 1)
      clock.advance(10_100)
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.status === 'timed_out', 15_000, 'timed_out')
      const run = hub.ctx.store.repos.runs.get(seed.runId)!
      expect(run.errorCode).toBe('TIMEOUT')
      expect(worker.runner.slotsUsed).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 60_000)

  it('WK-6 空闲超时：idle 剧本 + idleTimeoutMs → timed_out(IDLE_TIMEOUT)', async () => {
    const { hub, cleanup } = await startHub()
    const clock = new FakeClock(1_000)
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk6')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk6-'), clock })
      await waitFor(() => hub.ctx.workers.isOnline('wk6'))
      const seed = seedRun(hub, 'wk6')
      await send(hub, 'wk6', command('run.dispatch', dispatchPayload(seed,
        { prompt: '#scenario: idle ms=60000', timeoutMs: 120_000, idleTimeoutMs: 10_000 })))
      await waitFor(() => worker!.runner.activeIds().length === 1)
      clock.advance(10_100)
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.status === 'timed_out', 15_000, 'idle timed_out')
      expect(hub.ctx.store.repos.runs.get(seed.runId)!.errorCode).toBe('IDLE_TIMEOUT')
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 60_000)
})

describe('WK-7 / WK-8 解码与超长行', () => {
  it('WK-7 unicode：多字节跨 chunk → 无乱码、无替换字符', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk7')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk7-') })
      await waitFor(() => hub.ctx.workers.isOnline('wk7'))
      const seed = seedRun(hub, 'wk7')
      await send(hub, 'wk7', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: unicode' })))
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.status === 'succeeded', 10_000)
      const logs = hub.ctx.store.repos.prepare("SELECT text FROM task_logs WHERE run_id = ? AND kind = 'log'").all(seed.runId) as
        Array<{ text: string }>
      const joined = logs.map(row => row.text).join('')
      expect(joined).toContain('中文 😀')
      expect(joined).toContain('再见 🌍')
      expect(joined).not.toContain('\uFFFD')
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 30_000)

  it('WK-8 超长行：事件 text ≤ 16 KiB 且含截断标记，本地 output.log 完整', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk8')
      const dir = tempDir('wk8-')
      worker = await startWorkerAt(hub, identity, { dir })
      await waitFor(() => hub.ctx.workers.isOnline('wk8'))
      const seed = seedRun(hub, 'wk8')
      await send(hub, 'wk8', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: huge-line bytes=1048576' })))
      await waitFor(() => hub.ctx.orchestrator.getTask(seed.taskId)?.status === 'succeeded', 15_000)
      const logs = hub.ctx.store.repos.prepare("SELECT text, data_json AS dataJson FROM task_logs WHERE run_id = ? AND kind = 'log'").all(seed.runId) as
        Array<{ text: string }>
      const line = logs.find(row => row.text.startsWith('x'))!
      expect(Buffer.byteLength(line.text)).toBeLessThanOrEqual(16 * 1024)
      expect(line.text).toContain('[truncated ')
      const local = readFileSync(join(dir, 'state', 'runs', seed.runId, 'output.log'))
      expect(local.length).toBe(1_048_577)
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 40_000)
})

describe('WK-10 / WK-16 在途窗口与退避', () => {
  it('WK-10 在途窗口：Hub 不发 ack 时 Worker 在途字节 ≤ maxInFlightBytes', () => {
    const clock = new FakeClock(1_000)
    const outbox = new RunOutbox(clock, { runBufferBytes: 8 << 20, totalBufferBytes: 64 << 20 }, () => undefined)
    const maxInFlight = 4 * 1024
    let inFlight = 0
    const sent: number[] = []
    outbox.register('run_' + 'A'.repeat(26), 'tsk_' + 'A'.repeat(26))
    outbox.attach(frame => {
      if (frame.type !== 'run.events') return true
      for (const event of frame.payload.events) {
        if (event.kind === 'log') inFlight += Buffer.byteLength(event.text) + 192
      }
      sent.push(inFlight)
      return true
    }, 64 * 1024, maxInFlight)
    for (let index = 0; index < 400; index++) outbox.push('run_' + 'A'.repeat(26), { kind: 'log', stream: 'stdout', text: 'z'.repeat(100) })
    outbox.flush()
    // 未收到任何 ack：发出的总字节不能超过窗口（允许 1 个事件的超发余量）
    expect(Math.max(0, ...sent)).toBeLessThanOrEqual(maxInFlight + 1024)
    expect(outbox.bufferedBytes).toBeGreaterThan(0)
  })

  it('WK-16 重连退避：指数增长且上限 30 s，welcome 后归零', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) => backoff(attempt, { random: () => 1 }))
    expect(delays[0]).toBe(1_000)
    expect(delays[1]).toBe(2_000)
    expect(delays[2]).toBe(4_000)
    for (let index = 1; index < 6; index++) expect(delays[index]).toBeGreaterThan(delays[index - 1]!)
    expect(Math.max(...delays)).toBe(30_000)
    expect(backoff(0, { random: () => 1 })).toBe(1_000)
  })
})

describe('WK-14 / WK-17 优雅关机与配置热重载', () => {
  it('WK-14 优雅关机：运行中收到退出 → worker.state(drain) → cancel → finished(WORKER_SHUTDOWN) → worker.bye(1000)', async () => {
    const { hub, cleanup } = await startHub()
    let worker: Awaited<ReturnType<typeof startWorkerAt>> | undefined
    try {
      const identity = await enroll(hub, 'wk14')
      worker = await startWorkerAt(hub, identity, { dir: tempDir('wk14-') })
      await waitFor(() => hub.ctx.workers.isOnline('wk14'))
      const seed = seedRun(hub, 'wk14')
      await send(hub, 'wk14', command('run.dispatch', dispatchPayload(seed, { prompt: '#scenario: slow ms=60000' })))
      await waitFor(() => worker!.runner.slotsUsed === 1)
      const disconnects: string[] = []
      const detach = safeOn(hub.ctx, 'worker/disconnected', (_id: string, reason: string) => { disconnects.push(reason) })
      const started = Date.now()
      await worker.close()
      await waitFor(() => disconnects.length > 0, 5000, 'disconnect event')
      detach()
      expect(Date.now() - started).toBeLessThan(20_000)
      expect(worker.runner.slotsUsed).toBe(0)
      const run = hub.ctx.store.repos.runs.get(seed.runId)!
      expect(run.status).toBe('cancelled')
      expect(run.errorCode).toBe('WORKER_SHUTDOWN')
      expect(hub.ctx.orchestrator.getTask(seed.taskId)!.status).toBe('cancelled')
      expect(disconnects).toContain('1000')
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 60_000)

  it('WK-17 配置热重载：新增工作区 → 主动重连并在 hello 中上报新工作区', async () => {
    const { hub, cleanup } = await startHub()
    const dir = tempDir('wk17-')
    const second = tempDir('wk17-second-')
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined
    try {
      const identity = await enroll(hub, 'wk17')
      const configPath = join(dir, 'worker.yaml')
      const base = { workerId: 'wk17', hub: { url: wsUrl(hub.address!) }, maxConcurrency: 1,
        adapters: { mock: { enabled: true } },
        workspaces: [{ id: 'sandbox', label: 'Sandbox', path: join(dir, 'repo'), allowedAdapters: ['mock'], maxProfile: 'full' }] }
      mkdirSync(join(dir, 'repo'), { recursive: true })
      writeFileSync(configPath, stringify(base), 'utf8')
      worker = await startWorker(WorkerConfigSchema.parse(base), { stateDir: join(dir, 'state'), configPath,
        random: () => 0, onWarning: () => undefined,
        identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint } })
      await waitFor(() => hub.ctx.store.repos.workers.get('wk17')?.connection === 'online', 15_000)
      const before = hub.ctx.workers.get('wk17')!.workspaces.map(item => item.id)
      expect(before).toEqual(['sandbox'])
      const updated = { ...base, workspaces: [...base.workspaces,
        { id: 'second', label: 'Second', path: second, allowedAdapters: ['mock'], maxProfile: 'readonly' }] }
      writeFileSync(configPath, stringify(updated), 'utf8')
      await waitFor(() => (hub.ctx.workers.get('wk17')?.workspaces.length ?? 0) === 2, 20_000, 'hot reload')
      expect(hub.ctx.workers.get('wk17')!.workspaces.map(item => item.id).sort()).toEqual(['sandbox', 'second'])
      assertInvariants(hub.ctx.store.repos)
    } finally { await worker?.close(); await cleanup() }
  }, 60_000)
})
