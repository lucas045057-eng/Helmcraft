/**
 * Pi 独立验收 · Phase 6 · SOAK-1-accelerated（加速高密度浸泡）
 *
 * 完整 24 h 浸泡需在预发环境执行（见验收报告）；本用例在交互式验收窗口内做 60 s 加速版本：
 *  - 真实 Worker（进程内）+ 真实 mock-cli 子进程，混合 success / fail / cancel / slow 任务；
 *  - 一次真实断网（ChaosProxy down/up，RST + 拒绝新连接）在运行中任务期间恢复；
 *  - 一次 Hub 重启（同一 DB + 同一端口），Worker 自动重连并继续接单；
 *  - 量化 RSS 趋势、孤儿进程数、卡死活动任务数，并以 assertInvariants 收尾。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTestHub } from '../src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { startWorker } from '../../worker/src/app.js'
import { assertInvariants, ChaosProxy, enrollWorker, eventually, delay } from './pi/harness.js'
import { recordMetrics, rssMiB, slopePerMinute } from './pi/phase6.js'

const terminal = ['succeeded', 'rejected', 'failed', 'timed_out', 'cancelled', 'refused', 'lost']
const workerId = 'pi-soak'
const workspaceOwner = workerId

function lingeringMockProcesses(): number {
  try {
    if (process.platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*mock-cli*' -and $_.ParentProcessId -eq ${process.pid} }; @($p).Count`
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      return Number(out.trim()) || 0
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 30_000 })
    return out.split('\n').filter(line => {
      const fields = line.trim().split(/\s+/)
      return fields.length > 2 && /mock-cli/.test(line) && fields[1] === String(process.pid)
    }).length
  } catch { return 0 }
}

it('SOAK-1-accelerated 60s 高密度混合浸泡（含断网重连 + Hub 重启）：RSS 平稳、0 孤儿、0 卡死、INV 全通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-soak-'))
  const workspace = join(dir, 'repo')
  mkdirSync(workspace)
  const dbPath = join(dir, 'hub.sqlite')
  const base = {
    server: { host: '127.0.0.1', port: 0, allowInsecureWorker: true },
    storage: { path: dbPath },
    workers: { heartbeatIntervalMs: 2000, heartbeatTimeoutMs: 12_000, gracePeriodMs: 15_000 },
    orchestrator: { scheduler: { tickMs: 100 }, limits: { maxActivePerRequester: 10, requesterTasksPerHour: 10_000 } },
  } as const
  let hub = await createTestHub(base as never, {})
  const port = Number(new URL(hub.address!).port)
  const proxy = await ChaosProxy.start(hub.address!)
  const identity = await enrollWorker(hub, workerId)
  const warnings: string[] = []
  const worker = await startWorker(WorkerConfigSchema.parse({
    workerId, hub: { url: proxy.url }, maxConcurrency: 2, shutdown: { drainTimeoutMs: 0 },
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2 }],
  }), {
    stateDir: join(dir, 'state'), random: () => 0, onWarning: text => warnings.push(text),
    identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint },
  })
  const samples: Array<{ at: number; value: number }> = []
  const startedAt = Date.now()
  const sampler = setInterval(() => samples.push({ at: Date.now(), value: rssMiB() }), 2000)
  const counts: Record<string, number> = { success: 0, fail: 0, cancel: 0, slow: 0 }
  let disconnects = 0
  let restarts = 0

  const online = () => hub.ctx.store.repos.workers.get(workerId)?.connection === 'online'
  const status = (id: string) => hub.ctx.orchestrator.getTask(id)?.status
  const waitStatus = (id: string, expected: string, timeoutMs = 30_000) =>
    eventually(() => status(id) === expected, { timeoutMs, label: id + ' → ' + expected })

  const restartHub = async () => {
    await hub.close()
    hub = await createTestHub({ ...base, server: { ...base.server, port } } as never, {})
    await eventually(online, { timeoutMs: 30_000, label: 'worker reconnected after hub restart' })
    restarts += 1
  }

  try {
    await eventually(online, { timeoutMs: 30_000, label: 'worker online' })

    const runScenario = async (kind: keyof typeof counts) => {
      const prompt = kind === 'success' ? '#scenario: success n=3'
        : kind === 'fail' ? '#scenario: fail code=2'
          : kind === 'slow' ? '#scenario: slow ms=2500'
            : '#scenario: slow ms=45000'
      const task = await hub.ctx.orchestrator.createTask({ prompt, workspaceId: 'sandbox', adapter: 'mock' } as never,
        { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as never)
      if (kind === 'success' || kind === 'slow') await waitStatus(task.id, 'succeeded')
      else if (kind === 'fail') await waitStatus(task.id, 'failed')
      else {
        await waitStatus(task.id, 'running')
        await hub.ctx.orchestrator.cancel(task.id, { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as never, {})
        await waitStatus(task.id, 'cancelled')
      }
      counts[kind] += 1
    }

    // 运行中断网 + 恢复：任务在宽限期内不被判定丢失。
    const disconnectDuringRun = async () => {
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=6000', workspaceId: 'sandbox', adapter: 'mock' } as never,
        { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as never)
      await waitStatus(task.id, 'running')
      proxy.down()
      await delay(2500)
      proxy.up()
      await eventually(online, { timeoutMs: 30_000, label: 'worker reconnected' })
      await waitStatus(task.id, 'succeeded', 40_000)
      disconnects += 1
    }

    const deadline = Date.now() + 50_000
    const order: Array<keyof typeof counts> = ['success', 'fail', 'cancel', 'slow']
    let round = 0
    while (Date.now() < deadline) {
      await runScenario(order[round % order.length]!)
      round += 1
      if (round === 5) await disconnectDuringRun()
      if (round === 11) await restartHub()
      samples.push({ at: Date.now(), value: rssMiB() })
    }

    // 收尾：等待所有活动任务进入终态（无卡死）；再补一次 Hub 重启后的可用性检查。
    await eventually(() => hub.ctx.store.repos.prepare(`SELECT count(*) FROM tasks WHERE status NOT IN (${terminal.map(value => "'" + value + "'").join(',')})`)
      .pluck().get() === 0, { timeoutMs: 40_000, label: 'no active tasks' })
    await eventually(() => worker.runner.slotsUsed === 0, { timeoutMs: 20_000, label: 'worker slots drained' })
    // 孤儿进程：等待最多 15 s 让 Job Object 收尾。
    let orphanCount = lingeringMockProcesses()
    const orphanDeadline = Date.now() + 15_000
    while (orphanCount > 0 && Date.now() < orphanDeadline) { await delay(500); orphanCount = lingeringMockProcesses() }

    const db = hub.ctx.store.repos
    const tasks = db.prepare('SELECT status, count(*) AS n FROM tasks GROUP BY status').all() as Array<{ status: string; n: number }>
    const activeTasks = tasks.filter(row => !terminal.includes(row.status))
    const activeRuns = db.prepare("SELECT count(*) FROM task_runs WHERE status IN ('dispatching','running','awaiting_input','cancelling')").pluck().get() as number
    const stuck = db.prepare(`SELECT count(*) FROM tasks WHERE status IN ('running','cancelling','dispatching','awaiting_input')
      AND coalesce(started_at, created_at) < ?`).pluck().get(Date.now() - 120_000) as number
    expect(activeTasks).toEqual([])
    expect(activeRuns).toBe(0)
    expect(stuck).toBe(0)
    assertInvariants(db)

    const values = samples.map(sample => sample.value)
    const trend = slopePerMinute(samples)
    const peak = Math.max(...values)
    const baseline = values[0]!
    const growth = peak - baseline
    const durationSeconds = (Date.now() - startedAt) / 1000
    recordMetrics('SOAK-1-accelerated', { durationSeconds: Math.round(durationSeconds), rounds: round,
      tasks: counts, disconnects, restarts, rssBaselineMiB: Number(baseline.toFixed(1)), rssPeakMiB: Number(peak.toFixed(1)),
      rssLastMiB: Number(values.at(-1)!.toFixed(1)), rssSlopeMiBPerMinute: Number(trend.toFixed(2)), orphans: orphanCount,
      activeTasks: activeTasks.length, activeRuns, stuck, warnings: warnings.length })
    console.info('[SOAK-1-accelerated] %ss · %d 轮（%s）· 断网 %d 次 · 重启 %d 次（samples=%d）', Math.round(durationSeconds), round,
      JSON.stringify(counts), disconnects, restarts, samples.length)
    console.info('[SOAK-1-accelerated] RSS baseline=%s MiB peak=%s MiB last=%s MiB Δpeak=%s MiB slope=%s MiB/min | 孤儿=%d | 卡死=%d | INV=ok',
      baseline.toFixed(1), peak.toFixed(1), values.at(-1)!.toFixed(1), growth.toFixed(1), trend.toFixed(2), orphanCount, stuck)

    expect(orphanCount).toBe(0)
    expect(peak).toBeLessThan(512)
    expect(growth).toBeLessThan(128)
    expect(trend).toBeLessThan(20)
    expect(counts.success).toBeGreaterThan(0)
    expect(counts.fail).toBeGreaterThan(0)
    expect(counts.cancel).toBeGreaterThan(0)
    expect(restarts).toBe(1)
    expect(disconnects).toBe(1)
  } finally {
    clearInterval(sampler)
    await worker.close().catch(() => undefined)
    await proxy.close()
    await hub.close().catch(() => undefined)
    void workspaceOwner
    rmSync(dir, { recursive: true, force: true })
  }
}, 180_000)
