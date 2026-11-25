/**
 * Pi 独立验收 · Phase 6 · PERF-1 / PERF-2 / PERF-3 实测（真实 WS 环回，无网络节流）
 *
 * 与 Codex 的 `phase6-*.test.ts` 独立：全部指标在当前机器实测并打印，门禁值来自矩阵 §15。
 *  - PERF-1：单 Run 高速日志入库吞吐 ≥ 20 000 行/s；入库提交延迟与端到端（发送→ack）p95 < 500 ms。
 *  - PERF-2：4 Worker × 4 并发 flood，Hub 进程 RSS 峰值 < 512 MiB，面板 WS 期间可用。
 *  - PERF-3：100 个面板 WS 客户端订阅 tasks，事件扇出 p95 < 200 ms。
 */
import { expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { Topic } from '@agent-hub/protocol'
import { DashClient } from './pi/dash.js'
import { eventually, FakeWorker, openHarness, ownerActor, delay, seedRun } from './pi/harness.js'
import { ORIGIN } from './pi/rest.js'
import { PanelClient, recordMetrics, rssMiB, stats } from './pi/phase6.js'

const unrestricted = { framesPerSecond: 100_000, bytesPerSecond: 1 << 30, upgradesPerMinute: 10_000, maxUnauthenticated: 64 }

it('PERF-1 单 Run 高速日志入库：持久化吞吐 ≥ 20 000 行/s，端到端延迟 p95 < 500 ms', async () => {
  const { hub, cleanup } = await openHarness({
    dashboard: { allowedOrigins: [ORIGIN] },
    storage: { ingest: { batchMs: 20, batchRows: 500 } },
    workers: { ackIntervalMs: 1, rateLimits: unrestricted },
  })
  const worker = await FakeWorker.connect(hub, { workerId: 'pi-perf1', maxConcurrency: 1 })
  const seed = seedRun(hub, { workerId: 'pi-perf1', taskStatus: 'running', runStatus: 'running' })
  const store = hub.ctx.store
  try {
    // 观测 Hub 侧事务提交（enqueue resolve = 事务已提交）的完成时刻 + 提交耗时。
    const ingest = store.ingest as unknown as { enqueue: (...args: unknown[]) => Promise<{ lastSeq: number }> }
    const original = ingest.enqueue.bind(ingest)
    const commits: Array<{ at: number; lastSeq: number; ms: number }> = []
    ingest.enqueue = (...args: unknown[]) => {
      const start = performance.now()
      const job = original(...args)
      void job.then(value => commits.push({ at: performance.now(), lastSeq: value.lastSeq, ms: performance.now() - start }),
        () => undefined)
      return job
    }
    // 观测 Hub → Worker 的 run.ack 到达时间（反映 ack 批处理节流，不参与门禁）。
    const acks: Array<{ at: number; seq: number }> = []
    worker.ws.on('message', (data: unknown) => {
      const raw = Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString() : Buffer.from(data as ArrayBuffer).toString()
      if (!raw.includes('"run.ack"')) return
      const frame = JSON.parse(raw) as { type: string; payload: { acks: Array<{ runId: string; ackSeq: number }> } }
      const entry = frame.payload.acks.find(item => item.runId === seed.runId)
      if (entry) acks.push({ at: performance.now(), seq: entry.ackSeq })
    })

    const line = (seq: number) => ({ seq, ts: 1_000 + seq, kind: 'log' as const, stream: 'stdout' as const,
      text: 'row-' + seq + '-' + 'x'.repeat(24) })

    // ① 吞吐：一次性突发 50 × 500 行（与 Worker 满窗发送等价）。
    //    取“第 1 帧提交 → 第 50 帧提交”的区间作为稳态吞吐（排除连接/首帧预热），共 49 × 500 行。
    const frames = 50
    const perFrame = 500
    const burstTotal = frames * perFrame // 25 000 行
    const burstStart = performance.now()
    for (let index = 0; index < frames; index++) {
      const from = index * perFrame + 1
      worker.events(seed.runId, seed.taskId, Array.from({ length: perFrame }, (_, offset) => line(from + offset)))
    }
    await eventually(() => store.repos.runs.get(seed.runId)!.lastSeq === burstTotal, { timeoutMs: 30_000, label: 'burst persisted' })
    await eventually(() => commits.some(entry => entry.lastSeq >= burstTotal), { timeoutMs: 10_000, label: 'burst commit' })
    const lastBurst = commits.find(entry => entry.lastSeq >= burstTotal)!
    const firstCommit = commits[0]!
    const sustainedRows = (frames - 1) * perFrame
    const sustainedSeconds = (lastBurst.at - firstCommit.at) / 1000
    const rowsPerSecond = sustainedRows / sustainedSeconds
    const wallSeconds = (lastBurst.at - burstStart) / 1000
    const wallRowsPerSecond = burstTotal / wallSeconds
    expect(store.repos.prepare('SELECT count(*) FROM task_logs WHERE run_id = ?').pluck().get(seed.runId + '') as number).toBe(burstTotal)

    // ② 端到端延迟：可持续发送节奇（5000 行/s = 仅达实测容量 1/4）下的“发送 → 已提交”。
    const paced = 20
    const pacedLatency: number[] = []
    for (let index = 0; index < paced; index++) {
      const from = burstTotal + index * perFrame + 1
      const expected = from + perFrame - 1
      const sentAt = performance.now()
      worker.events(seed.runId, seed.taskId, Array.from({ length: perFrame }, (_, offset) => line(from + offset)))
      await eventually(() => commits.some(entry => entry.lastSeq >= expected), { timeoutMs: 10_000, label: 'paced ' + index })
      pacedLatency.push(commits.find(entry => entry.lastSeq >= expected)!.at - sentAt)
      await delay(Math.max(0, 100 - (performance.now() - sentAt)))
    }
    const total = burstTotal + paced * perFrame
    expect(store.repos.prepare('SELECT count(*) FROM task_logs WHERE run_id = ?').pluck().get(seed.runId + '') as number).toBe(total)

    const commit = stats(commits.map(entry => entry.ms))
    const endToEnd = stats(pacedLatency)
    const ackLatency = acks.length > 1 ? stats(acks.slice(1).map((entry, index) => entry.at - acks[index]!.at)) : stats([0])
    console.info('[PERF-1] burst %d 行：稳态 %s rows/s（第1帧→末帧）、含预热 %s rows/s（发送→末帧，%sms）；入库提交延迟 p50=%sms p95=%sms max=%sms',
      burstTotal, rowsPerSecond.toFixed(0), wallRowsPerSecond.toFixed(0), (wallSeconds * 1000).toFixed(0),
      commit.p50.toFixed(2), commit.p95.toFixed(2), commit.max.toFixed(2))
    console.info('[PERF-1] 端到端(send→persisted, 5000 行/s 可持续节奇) p50=%sms p95=%sms max=%sms (gate < 500)；ack 间隔 p50=%sms (仅观测)',
      endToEnd.p50.toFixed(1), endToEnd.p95.toFixed(1), endToEnd.max.toFixed(1), ackLatency.p50.toFixed(1))
    // 门禁：Hub 持久化 ≥ 20 000 行/s（当前实现实测约 18.4k，见验收报告 P1）
    recordMetrics('PERF-1', { burstRows: burstTotal, sustainedRowsPerSecond: Math.round(rowsPerSecond),
      wallRowsPerSecond: Math.round(wallRowsPerSecond), commitP50Ms: Number(commit.p50.toFixed(2)),
      commitP95Ms: Number(commit.p95.toFixed(2)), e2eP50Ms: Number(endToEnd.p50.toFixed(1)),
      e2eP95Ms: Number(endToEnd.p95.toFixed(1)), e2eMaxMs: Number(endToEnd.max.toFixed(1)),
      ackIntervalP50Ms: Number(ackLatency.p50.toFixed(1)) })
    expect(rowsPerSecond).toBeGreaterThanOrEqual(20_000)
    expect(endToEnd.p95).toBeLessThan(500)
    expect(commit.p95).toBeLessThan(500)
  } finally {
    worker.terminate()
    await cleanup()
  }
}, 90_000)

it('PERF-2 4 Worker × 4 并发 flood：Hub RSS 峰值 < 512 MiB 且面板 WS 期间保持可用', async () => {
  const concurrency = 4
  const workers = ['pi-p2a', 'pi-p2b', 'pi-p2c', 'pi-p2d']
  const { hub, cleanup, url } = await openHarness({
    dashboard: { allowedOrigins: [ORIGIN] },
    storage: { ingest: { batchMs: 20, batchRows: 500 } },
    workers: { ackIntervalMs: 1, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 120_000, rateLimits: unrestricted },
    orchestrator: { scheduler: { tickMs: 50 } },
  })
  const store = hub.ctx.store
  const clients: FakeWorker[] = []
  const panel = await DashClient.open(url, { token: hub.ctx.auth.createApiToken('pi-perf2-panel', ['read']) })
  const samples: number[] = []
  const baseline = rssMiB()
  const sampler = setInterval(() => samples.push(rssMiB()), 20)
  let peak = baseline
  try {
    panel.send({ t: 'hello' })
    panel.send({ t: 'subscribe', topics: ['overview', 'workers', 'tasks'] })
    await panel.waitSnapshot()

    for (const workerId of workers) {
      clients.push(await FakeWorker.connect(hub, { workerId, maxConcurrency: concurrency, workspaces: [
        { id: 'sandbox', label: 'Sandbox', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: concurrency, isGitRepo: false },
      ] }))
    }
    const created = []
    for (const workerId of workers) {
      for (let slot = 0; slot < concurrency; slot++) {
        created.push(await hub.ctx.orchestrator.createTask({
          prompt: 'flood ' + workerId + ' ' + slot, workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly',
          requiredWorkerId: workerId,
        } as never, ownerActor))
      }
    }
    await eventually(() => clients.every(worker => worker.frames.filter(frame => frame.type === 'run.dispatch').length === concurrency),
      { timeoutMs: 20_000, label: '16 dispatches' })

    // 受理 16 个 Run（cmd.ack + started），准备 flood。
    const runs = new Map<string, string>()
    for (const worker of clients) {
      for (const frame of worker.frames.filter(frame => frame.type === 'run.dispatch')) {
        const payload = frame.payload as { runId: string; taskId: string }
        runs.set(payload.runId, payload.taskId)
        worker.ackCommand(frame)
      }
    }
    await eventually(() => store.repos.prepare("SELECT count(*) FROM task_runs WHERE status='running'").pluck().get() === 16,
      { timeoutMs: 20_000, label: '16 running runs' })

    // 每个 Worker 的 4 个 Run 轮流推 250 行/帧：单 Worker 25 000 行，合计 100 000 行。
    const rounds = 25
    const perFrame = 250
    const perRun = rounds * perFrame
    const byWorker = new Map<string, Array<{ runId: string; taskId: string }>>()
    for (const worker of clients) {
      const entries = worker.frames.filter(frame => frame.type === 'run.dispatch')
        .map(frame => frame.payload as { runId: string; taskId: string })
      byWorker.set(worker.identity.workerId, entries)
      for (const entry of entries) {
        worker.events(entry.runId, entry.taskId, [{ seq: 1, ts: 1, kind: 'started', pid: 1, adapter: 'mock',
          effectiveProfile: 'readonly', commandSummary: 'mock' }])
      }
    }
    await eventually(() => [...runs.keys()].every(runId => store.repos.runs.get(runId)!.lastSeq === 1), { timeoutMs: 20_000 })

    let panelPings = 0
    for (let round = 0; round < rounds; round++) {
      for (const worker of clients) {
        for (const entry of byWorker.get(worker.identity.workerId)!) {
          const from = round * perFrame + 2
          worker.events(entry.runId, entry.taskId, Array.from({ length: perFrame }, (_, offset) => {
            const seq = from + offset
            return { seq, ts: 1_000 + seq, kind: 'log' as const, stream: 'stdout' as const, text: 'flood-' + seq + '-' + 'y'.repeat(40) }
          }))
        }
      }
      // 期间面板必须可用：每 5 轮 ping 一次并要求 pong。
      if (round % 5 === 0) {
        panel.send({ t: 'ping', n: round })
        await panel.waitFor(frame => frame.t === 'pong' && frame.n === round, 'pong during flood', 2000)
        panelPings += 1
      }
      const expected = (round + 1) * perFrame + 1
      await eventually(() => [...runs.keys()].every(runId => store.repos.runs.get(runId)!.lastSeq >= expected),
        { timeoutMs: 20_000, label: 'round ' + round })
      peak = Math.max(peak, rssMiB())
    }
    const persisted = store.repos.prepare('SELECT count(*) FROM task_logs').pluck().get() as number
    expect(persisted).toBe(16 * (perRun + 1))
    for (const runId of runs.keys()) expect(store.repos.runs.get(runId)!.lastSeq).toBe(perRun + 1)

    // 面板在压测期间仍能收到增量事件（workers/task 主题）。
    const events = panel.events()
    expect(events.length).toBeGreaterThan(0)
    expect(panelPings).toBe(5)
    peak = Math.max(peak, ...samples, rssMiB())
    const peakStats = stats(samples.length ? samples : [peak])
    console.info('[PERF-2] rows=%d runs=16 workers=4×4 | RSS baseline=%s MiB peak=%s MiB (sampled p95=%s) | panel events=%d pings=%d',
      persisted, baseline.toFixed(1), peak.toFixed(1), peakStats.p95.toFixed(1), events.length, panelPings)
    recordMetrics('PERF-2', { rows: persisted, runs: 16, workers: '4×4', rssBaselineMiB: Number(baseline.toFixed(1)),
      rssPeakMiB: Number(peak.toFixed(1)), rssSampledP95MiB: Number(peakStats.p95.toFixed(1)),
      panelEvents: events.length, panelPings })
    expect(peak).toBeLessThan(512)
    expect(panel.closeCode).toBeUndefined()
  } finally {
    clearInterval(sampler)
    panel.terminate()
    for (const worker of clients) worker.terminate()
    await cleanup()
  }
}, 180_000)

it('PERF-3 100 个面板 WS 客户端订阅 tasks：事件扇出 p95 < 200 ms', async () => {
  const { hub, cleanup, url } = await openHarness({
    dashboard: { allowedOrigins: [ORIGIN] },
    orchestrator: { scheduler: { tickMs: 100 } },
  })
  const panels: PanelClient[] = []
  try {
    // 每条连接上限 5（按凭据哈希），100 客户端 = 20 个只读 API Token。
    const tokens = Array.from({ length: 20 }, (_, index) => hub.ctx.auth.createApiToken('pi-perf3-' + index, ['read']))
    for (const token of tokens) {
      for (let slot = 0; slot < 5; slot++) panels.push(await PanelClient.open(url, token, ORIGIN))
    }
    expect(panels).toHaveLength(100)
    for (const panel of panels) await panel.subscribe(['tasks'] as Topic[])
    for (const panel of panels) await panel.wait(frame => frame.t === 'snapshot', 10_000, 'snapshot')

    const rounds = 8
    const latencies: number[] = []
    const spreads: number[] = []
    const ids: string[] = []
    for (let round = 0; round < rounds; round++) {
      const startedAt = performance.now()
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'perf3 round ' + round, workspaceId: 'sandbox' } as never, ownerActor)
      ids.push(task.id)
      await eventually(() => panels.every(panel => panel.frames.some(entry => entry.frame.t === 'event' &&
        entry.frame.type === 'task.created' && (entry.frame.data as { id: string }).id === task.id)),
      { timeoutMs: 5000, label: 'fanout round ' + round })
      const arrivals = panels.map(panel => panel.frames.find(entry => entry.frame.t === 'event' &&
        entry.frame.type === 'task.created' && (entry.frame.data as { id: string }).id === task.id)!.at)
      for (const at of arrivals) latencies.push(at - startedAt)
      spreads.push(Math.max(...arrivals) - Math.min(...arrivals))
    }
    const created = stats(latencies)
    const spread = stats(spreads)
    expect(created.p95).toBeLessThan(200)
    expect(spread.p95).toBeLessThan(200)
    expect(latencies.every(value => value >= 0)).toBe(true)

    // 合并节流的 task.updated：设计上 250 ms 去抖，这里记录“触发→100 客户端全部收到”的真实分布。
    const cancelled = ids.at(-1)!
    const triggerAt = performance.now()
    await hub.ctx.orchestrator.cancel(cancelled, ownerActor, {})
    await eventually(() => panels.every(panel => panel.frames.some(entry => entry.frame.t === 'event' &&
      entry.frame.type === 'task.updated' && (entry.frame.data as { id: string }).id === cancelled &&
      (entry.frame.data as { status: string }).status === 'cancelled')), { timeoutMs: 5000, label: 'coalesced update fanout' })
    const updateArrivals = panels.map(panel => panel.frames.find(entry => entry.frame.t === 'event' &&
      entry.frame.type === 'task.updated' && (entry.frame.data as { id: string }).id === cancelled)!.at)
    const updated = stats(updateArrivals.map(at => at - triggerAt))
    const updateSpread = stats([Math.max(...updateArrivals) - Math.min(...updateArrivals)])
    console.info('[PERF-3] task.created fanout over %d clients × %d rounds: p50=%sms p95=%sms max=%sms | 客户端间离散 p95=%sms',
      panels.length, rounds, created.p50.toFixed(1), created.p95.toFixed(1), created.max.toFixed(1), spread.p95.toFixed(1))
    console.info('[PERF-3] task.updated(250ms 去抖) 触发→100 客户端: p50=%sms p95=%sms max=%sms | 离散=%sms',
      updated.p50.toFixed(1), updated.p95.toFixed(1), updated.max.toFixed(1), updateSpread.max.toFixed(1))
    recordMetrics('PERF-3', { clients: panels.length, rounds, createdP50Ms: Number(created.p50.toFixed(1)),
      createdP95Ms: Number(created.p95.toFixed(1)), createdMaxMs: Number(created.max.toFixed(1)),
      spreadP95Ms: Number(spread.p95.toFixed(1)), updatedP50Ms: Number(updated.p50.toFixed(1)),
      updatedP95Ms: Number(updated.p95.toFixed(1)), updatedMaxMs: Number(updated.max.toFixed(1)),
      updateSpreadMs: Number(updateSpread.max.toFixed(1)) })
    // 去抖 + 25 ms 调度粒度：上界 400 ms（04 §5 合并节流设计值 250 ms）。
    expect(updated.max).toBeLessThan(400)
    expect(updateSpread.max).toBeLessThan(200)

    // 面板会话未因扇出被限流/关闭。
    expect(panels.every(panel => panel.closeCode === undefined)).toBe(true)
    for (const [index, panel] of panels.entries()) {
      expect(panel.frames.filter(entry => entry.frame.t === 'event' && entry.frame.type === 'task.created')).toHaveLength(rounds)
      if (index % 25 === 0) await delay(0)
    }
  } finally {
    for (const panel of panels) panel.terminate()
    await cleanup()
  }
}, 120_000)
