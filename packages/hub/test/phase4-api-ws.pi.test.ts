/**
 * Pi 独立验收 · Phase 4 WebSocket 门禁（API-6 ~ API-11）
 *
 * 用裸 `DashClientFrame`/`DashServerFrame` 客户端验证：
 * 快照与增量无竞态、断线续传（含越界与 bootId 变化）、日志跟随追赶+实时拼接、
 * 慢消费者背压、`task.updated` 合并节流。
 */
import { FakeClock } from '@agent-hub/common'
import { expect, it } from 'vitest'
import * as api from '@agent-hub/protocol'
import { enrollWorker, seedRun } from './pi/harness.js'
import { DashClient } from './pi/dash.js'
import type { EventFrame } from './pi/dash.js'
import { onlineWorker, openHarness, settings } from './pi/rest.js'

function assertStrictlyIncreasing(frames: EventFrame[], after: number) {
  let previous = after
  for (const frame of frames) {
    expect(frame.eventSeq).toBeGreaterThan(previous)
    previous = frame.eventSeq
  }
}

it('API-6 subscribe 后同一同步块内给出快照，随后增量且 eventSeq 严格递增', async () => {
  const clock = new FakeClock(10_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const worker = await onlineWorker(hub, 'pi-ws-worker', { drain: true })
  const view = hub.ctx.workers.get('pi-ws-worker')!
  const admin = hub.ctx.auth.createApiToken('pi-ws-6', ['read'])
  const client = await DashClient.open(url, { token: admin })
  try {
    // hello 与 subscribe 连续发送：订阅注册与快照读取必须在同一同步块内完成
    client.send({ t: 'hello' })
    client.send({ t: 'subscribe', topics: ['overview', 'workers', 'tasks'] })
    const welcome = await client.waitWelcome()
    const snapshot = await client.waitSnapshot()
    expect(welcome.resumed).toBe(false)
    expect(snapshot.eventSeq).toBe(welcome.eventSeq)
    expect(snapshot.workers.map(item => item.id)).toContain('pi-ws-worker')
    expect(api.Overview.safeParse(snapshot.overview).success).toBe(true)

    // 订阅之后产生 20 个增量事件：一个都不能丢
    for (let index = 0; index < 20; index++) hub.ctx.emit('worker/updated', { ...view, rttMs: index }, view)
    await client.waitForCount(frame => frame.t === 'event', 20, '20 worker events', 5000)

    const snapshotIndex = client.frames.findIndex(frame => frame.t === 'snapshot')
    const firstEventIndex = client.frames.findIndex(frame => frame.t === 'event')
    expect(firstEventIndex).toBeGreaterThan(snapshotIndex)
    const updates = client.events('worker.updated')
    expect(updates).toHaveLength(20)
    expect(updates.map(frame => (frame.data as { rttMs: number }).rttMs)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    assertStrictlyIncreasing(client.events(), snapshot.eventSeq)
    expect(client.events('overview.updated')).toHaveLength(0)
  } finally { client.terminate(); worker.terminate(); await cleanup() }
})

it('API-7 断线期间 100 个已订阅事件：重连 resumed=true 且恰好补发这些事件', async () => {
  const clock = new FakeClock(20_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const worker = await onlineWorker(hub, 'pi-resume-worker', { drain: true })
  const view = hub.ctx.workers.get('pi-resume-worker')!
  const read = hub.ctx.auth.createApiToken('pi-ws-7', ['read'])
  const first = await DashClient.open(url, { token: read })
  let second: DashClient | undefined
  try {
    first.send({ t: 'hello' })
    first.send({ t: 'subscribe', topics: ['workers'] })
    const welcome = await first.waitWelcome()
    const snapshot = await first.waitSnapshot()
    await first.close()

    // 100 个 workers 主题事件 + 25 个未订阅的 overview 主题事件
    for (let index = 0; index < 100; index++) {
      hub.ctx.emit('worker/updated', { ...view, rttMs: index + 1 }, view)
      if (index % 4 === 0) hub.ctx.emit('hub/status', { bootId: welcome.bootId, startedAt: clock.now(), version: '0.1.0',
        draining: false, restartRequired: false, configError: null, feishu: { state: 'disabled', since: clock.now() } })
    }

    second = await DashClient.open(url, { token: read })
    second.send({ t: 'hello', resume: { bootId: welcome.bootId, eventSeq: snapshot.eventSeq } })
    second.send({ t: 'subscribe', topics: ['workers'] })
    const resumed = await second.waitWelcome()
    expect(resumed.resumed).toBe(true)
    expect(resumed.eventSeq).toBe(snapshot.eventSeq + 125)
    await second.waitForCount(frame => frame.t === 'event', 100, '100 replayed worker events', 8000)
    // 续传期间不应再发快照（客户端应以 eventSeq 去重）
    await new Promise(resolve => setTimeout(resolve, 150))
    const replayed = second.events()
    expect(replayed).toHaveLength(100)
    expect(replayed.every(frame => frame.topic === 'workers' && frame.type === 'worker.updated')).toBe(true)
    expect(replayed.map(frame => (frame.data as { rttMs: number }).rttMs)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    assertStrictlyIncreasing(replayed, snapshot.eventSeq)
    expect(second.frames.some(frame => frame.t === 'snapshot')).toBe(false)
    expect(second.frames.some(frame => frame.t === 'resync')).toBe(false)
  } finally { first.terminate(); second?.terminate(); worker.terminate(); await cleanup() }
})

it('API-8 续传越界（> 10 000）与 bootId 变化均返回 resumed=false 并要求重新快照', async () => {
  const clock = new FakeClock(30_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const worker = await onlineWorker(hub, 'pi-window-worker', { drain: true })
  const view = hub.ctx.workers.get('pi-window-worker')!
  const read = hub.ctx.auth.createApiToken('pi-ws-8', ['read'])
  const base = await DashClient.open(url, { token: read })
  const overflow = await DashClient.open(url, { token: read })
  const changed = await DashClient.open(url, { token: read })
  try {
    base.send({ t: 'hello' })
    const welcome = await base.waitWelcome()
    for (let index = 0; index < 10_001; index++) hub.ctx.emit('worker/updated', { ...view, rttMs: index }, view)

    overflow.send({ t: 'hello', resume: { bootId: welcome.bootId, eventSeq: welcome.eventSeq } })
    overflow.send({ t: 'subscribe', topics: ['workers'] })
    const stale = await overflow.waitWelcome()
    expect(stale.resumed).toBe(false)
    expect(stale.eventSeq).toBe(welcome.eventSeq + 10_001)
    const snapshot = await overflow.waitSnapshot()
    expect(snapshot.eventSeq).toBe(stale.eventSeq)

    changed.send({ t: 'hello', resume: { bootId: 'previous-boot-identity', eventSeq: welcome.eventSeq } })
    changed.send({ t: 'subscribe', topics: ['workers'] })
    const otherBoot = await changed.waitWelcome()
    expect(otherBoot.resumed).toBe(false)
    expect(await changed.waitSnapshot()).toBeTruthy()
  } finally { base.terminate(); overflow.terminate(); changed.terminate(); worker.terminate(); await cleanup() }
})

it('API-9 日志 follow：追赶 + 实时拼接 seq 严格连续无重复无遗漏，最终与 DB 一致', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  await enrollWorker(hub, 'pi-follow-worker')
  const run = seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' })
  const read = hub.ctx.auth.createApiToken('pi-ws-9', ['read'])
  const client = await DashClient.open(url, { token: read })
  const persist = async (from: number, count: number) => {
    const events = Array.from({ length: count }, (_, index) => ({ seq: from + index, ts: hub.ctx.clock.now(),
      kind: 'log' as const, stream: 'stdout' as const, text: 'L' + (from + index) }))
    const job = hub.ctx.store.ingest.enqueue(run.runId, events)
    await hub.ctx.store.ingest.flush()
    await job
    hub.ctx.emit('run/events', run.runId, run.taskId, events)
  }
  try {
    await persist(1, 1200)
    client.send({ t: 'hello' })
    client.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
    // 追赶过程中持续写入（模拟 flood），验证追平后实时追加不丢不重
    for (let batch = 0; batch < 6; batch++) { await new Promise(resolve => setTimeout(resolve, 5)); await persist(1201 + batch * 100, 100) }
    await client.waitFor(() => client.logs().some(entry => entry.seq === 1800), 'catch-up 1800', 8000)
    for (let batch = 0; batch < 6; batch++) { await persist(1801 + batch * 100, 100); await new Promise(resolve => setTimeout(resolve, 5)) }
    await client.waitFor(() => client.logs().some(entry => entry.seq === 2400), 'live 2400', 8000)

    const received = client.logs().map(entry => entry.seq)
    expect(new Set(received).size).toBe(received.length)
    expect(received).toEqual(Array.from({ length: 2400 }, (_, index) => index + 1))
    const frames = client.logsFrames()
    expect(frames.some(frame => !frame.live)).toBe(true)
    expect(frames.some(frame => frame.live)).toBe(true)
    const stored = hub.ctx.store.repos.prepare('SELECT seq FROM task_logs WHERE run_id = ? ORDER BY seq').all(run.runId) as Array<{ seq: number }>
    expect(stored.map(row => row.seq)).toEqual(received)
    expect(client.frames.some(frame => frame.t === 'logs.reset')).toBe(false)

    // 超过 8 个 Run 的并发 follow → RATE_LIMITED
    client.send({ t: 'unfollow', runId: run.runId })
    const runs = [seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' }),
      seedRun(hub, { workerId: 'pi-follow-worker', taskStatus: 'running', runStatus: 'running' })]
    for (const item of runs) client.send({ t: 'follow', runId: item.runId, fromSeq: 0 })
    client.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
    const limited = await client.waitFor(frame => frame.t === 'error', 'rate limited', 5000)
    expect(limited).toMatchObject({ t: 'error', code: 'RATE_LIMITED' })

    // 不存在的 Run → logs.reset(run_not_found)
    client.send({ t: 'unfollow', runId: runs[0]!.runId })
    client.send({ t: 'follow', runId: 'run_00000000000000000000000000', fromSeq: 0 })
    const reset = await client.waitFor(frame => frame.t === 'logs.reset', 'run_not_found', 5000)
    expect(reset).toMatchObject({ t: 'logs.reset', reason: 'run_not_found', runId: 'run_00000000000000000000000000' })
  } finally { client.terminate(); await cleanup() }
})

it('API-10 慢消费者：logs.reset(slow_consumer) → resync(slow_consumer) 并关闭 4008，Hub 内存稳定', async () => {
  const clock = new FakeClock(50_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  await enrollWorker(hub, 'pi-slow-worker')
  const run = seedRun(hub, { workerId: 'pi-slow-worker', taskStatus: 'running', runStatus: 'running' })
  const read = hub.ctx.auth.createApiToken('pi-ws-10', ['read'])
  const client = await DashClient.open(url, { token: read })
  const before = process.memoryUsage().rss
  try {
    client.send({ t: 'hello' })
    client.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
    client.send({ t: 'ping', n: 7 })
    await client.waitFor(frame => frame.t === 'pong', 'pong')
    client.pause()
    const payload = 'x'.repeat(16_000)
    for (let base = 1; base <= 1000; base += 100) {
      hub.ctx.emit('run/events', run.runId, run.taskId, Array.from({ length: 100 }, (_, index) => ({
        kind: 'log' as const, stream: 'stdout' as const, seq: base + index, ts: clock.now(), text: payload })))
    }
    clock.advance(11_000)
    client.resume()
    expect(await client.waitClose()).toBe(4008)
    expect(client.frames.find(frame => frame.t === 'logs.reset')).toMatchObject({ t: 'logs.reset', runId: run.runId, reason: 'slow_consumer' })
    expect(client.frames.at(-1)).toMatchObject({ t: 'resync', reason: 'slow_consumer' })
    const growth = process.memoryUsage().rss - before
    expect(growth).toBeLessThan(200 * 1024 * 1024)
    // 背压清理后 Hub 仍可正常接受新的面板会话
    const healthy = await DashClient.open(url, { token: read })
    try {
      healthy.send({ t: 'hello' })
      healthy.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
      await healthy.waitFor(frame => frame.t === 'pong' || frame.t === 'logs' || frame.t === 'welcome', 'healthy session')
      expect(healthy.closeCode).toBeUndefined()
    } finally { healthy.terminate() }
  } finally { client.terminate(); await cleanup() }
})

it('API-11 同一任务 250ms 内 10 次更新：合并为 1~2 次 task.updated 且为最新 version', async () => {
  const clock = new FakeClock(60_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const reader = hub.ctx.auth.createApiToken('pi-ws-11', ['read'])
  const client = await DashClient.open(url, { token: reader })
  try {
    const task = await hub.ctx.orchestrator.createTask({ prompt: '合并节流', workspaceId: 'sandbox' }, { type: 'owner',
      id: 'dashboard:owner', channel: 'dashboard' })
    client.send({ t: 'hello' })
    client.send({ t: 'subscribe', topics: ['tasks'] })
    await client.waitSnapshot()
    const patch = hub.ctx.store.repos.prepare('UPDATE tasks SET version = ? WHERE id = ?')
    for (let version = 2; version <= 11; version++) {
      patch.run(version, task.id)
      hub.ctx.emit('task/transitioned', { task: { ...task, version }, from: 'awaiting_approval', to: 'queued',
        event: 'APPROVE', actor: { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } })
    }
    clock.advance(249)
    expect(client.events('task.updated')).toHaveLength(0)
    clock.advance(1)
    await client.waitForCount(frame => frame.t === 'event' && frame.type === 'task.updated', 1, 'coalesced update', 3000)
    clock.advance(1000)
    const updates = client.events('task.updated')
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates.length).toBeLessThanOrEqual(2)
    expect((updates.at(-1)!.data as { version: number }).version).toBe(11)
    expect(updates.at(-1)!.topic).toBe('tasks')
  } finally { client.terminate(); await cleanup() }
})

it('API-6 task:<id> 主题只推送该任务详情事件，订阅超 32 个主题返回 RATE_LIMITED', async () => {
  const clock = new FakeClock(70_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const reader = hub.ctx.auth.createApiToken('pi-ws-topic', ['read'])
  const client = await DashClient.open(url, { token: reader })
  try {
    const task = await hub.ctx.orchestrator.createTask({ prompt: '主题订阅', workspaceId: 'sandbox' },
      { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' })
    client.send({ t: 'hello' })
    await client.waitWelcome()
    client.send({ t: 'subscribe', topics: ['task:' + task.id] })
    const detail = await client.waitFor(frame => frame.t === 'event' && frame.type === 'task.detail', 'task.detail')
    expect(detail).toMatchObject({ t: 'event', topic: 'task:' + task.id })
    expect((detail.data as { id: string }).id).toBe(task.id)
    // 纯 task: 主题不应产生全局快照
    expect(client.frames.some(frame => frame.t === 'snapshot')).toBe(false)

    const topics = Array.from({ length: 32 }, (_, index) => 'task:tsk_' + String(index + 1).padStart(26, '0'))
    client.send({ t: 'subscribe', topics: topics as never })
    client.send({ t: 'subscribe', topics: ['overview'] })
    const limited = await client.waitFor(frame => frame.t === 'error', 'subscribe limit', 5000)
    expect(limited).toMatchObject({ t: 'error', code: 'RATE_LIMITED' })
  } finally { client.terminate(); await cleanup() }
})
