/**
 * Pi 独立验收 · Phase 6 公共基础设施
 *
 * 提供 DB-9 / DB-10 / PERF / SOAK 系列用例所需的工具：
 *  - `seedRun`：在 Repos 或 TestHub 上播种一条 Task + Run（可选百万行日志）
 *  - `observeSlices`：包装 Repos 观察每次 `DELETE ... LIMIT` 的 changes 与 incremental_vacuum 次数
 *  - `stats` / `slopePerMinute` / `rssMiB` / `mib` / `dayMs`：指标与统计
 *  - `recordMetrics`：统一的 `[metrics] <id> {json}` 输出（CI 日志可解析）
 *  - `PanelClient`：带到达时间戳的面板 WebSocket 客户端（用于扇出延迟统计）
 */
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { DASHBOARD_SUBPROTOCOL, DashServerFrame } from '@agent-hub/protocol'
import type { DashClientFrame, Topic } from '@agent-hub/protocol'
import { ulid } from '@agent-hub/common'
import type { TestHub } from '../../src/app.js'
import type { Repos } from '../../src/services/store.js'

export const dayMs = 86_400_000
export const mib = 1024 * 1024

/** 当前进程 RSS（MiB）。 */
export function rssMiB() { return process.memoryUsage().rss / mib }

/** 统一的指标输出：[metrics] <id> {"k":v} */
export function recordMetrics(id: string, data: Record<string, unknown>) {
  console.info('[metrics] ' + id + ' ' + JSON.stringify(data))
}

export interface Stats { count: number; min: number; p50: number; p95: number; p99: number; max: number }

/** 分位数（最近秩法，无需插值）：用于 p50 / p95 / p99 门禁。 */
export function stats(values: readonly number[]): Stats {
  if (!values.length) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))]!
  return { count: sorted.length, min: sorted[0]!, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]! }
}

/** 最小二乘斜率换算成「每分钟变化量」，用于 RSS 增长趋势（SOAK）。 */
export function slopePerMinute(samples: ReadonlyArray<{ at: number; value: number }>) {
  if (samples.length < 2) return 0
  const origin = samples[0]!.at
  const xs = samples.map(sample => (sample.at - origin) / 60_000)
  const ys = samples.map(sample => sample.value)
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index++) {
    numerator += (xs[index]! - meanX) * (ys[index]! - meanY)
    denominator += (xs[index]! - meanX) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}

// ───────────────────────────── seedRun ─────────────────────────────

export interface SeedRunOptions {
  id?: string
  workerId?: string
  taskStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'running' | 'queued' | 'dispatching'
  runStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'running' | 'dispatching'
  ageDays?: number
  now?: number
  logs?: number
  profile?: 'readonly' | 'edit' | 'full'
}

const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled'])

/**
 * 播种一条 Task + Run（+ 可选日志行）。`target` 既可以是事务内的 `Repos`，
 * 也可以是 `TestHub`（自动取 `ctx.store.repos`）。返回可用于日志注入的标识。
 */
export function seedRun(target: Repos | TestHub, options: SeedRunOptions) {
  const repos: Repos = 'ctx' in target ? target.ctx.store.repos : target
  const now = options.now ?? Date.now()
  const at = now - (options.ageDays ?? 0) * dayMs
  const base = options.id ?? 'pi-seed-' + ulid(now).slice(-8).toLowerCase()
  const taskId = base
  const runIdValue = base + '-run'
  const workerId = options.workerId ?? 'pi-seed-worker'
  const profile = options.profile ?? 'edit'
  const finished = terminal.has(options.runStatus) ? at : null
  repos.prepare(`INSERT INTO workers(id,display_name,public_key,key_fingerprint,created_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(workerId, workerId, 'pi-public-key', 'pi-fingerprint', at, at)
  repos.tasks.insert({
    id: taskId, status: options.taskStatus, version: 1, source: 'dashboard', originJson: { source: 'dashboard' },
    requesterType: 'owner', requesterId: 'dashboard:owner', title: 'seed ' + taskId, prompt: 'seed prompt',
    workspaceId: 'sandbox', profile, timeoutMs: 1_800_000, maxAttempts: 3, attemptCount: 1, runSeq: 1,
    policyDecisionJson: { ruleId: null, decision: 'auto_approve' },
    currentRunId: finished === null ? runIdValue : null,
    createdAt: at, updatedAt: at, queuedAt: at, startedAt: finished === null ? at : null,
    approvalDeadlineAt: null, ...(finished !== null && { finishedAt: finished }),
  })
  repos.prepare(`INSERT INTO task_runs (id, task_id, run_seq, attempt, worker_id, adapter, workspace_id, profile, status,
    dispatched_at, not_after, last_seq, started_at, finished_at, logs_purged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(runIdValue, taskId, 1, 1, workerId, 'mock', 'sandbox', profile,
    options.runStatus, at, at + 40_000, options.logs ?? 0, finished === null ? at : at, finished)
  const total = options.logs ?? 0
  if (total > 0) {
    const insert = repos.prepare('INSERT INTO task_logs(run_id, seq, ts, kind, stream, text, bytes) VALUES (?,?,?,?,?,?,?)')
    repos.prepare('SAVEPOINT pi_seed_logs').run()
    try {
      for (let seq = 1; seq <= total; seq++) insert.run(runIdValue, seq, at, 'log', 'stdout', 'x', 1)
      repos.prepare('RELEASE pi_seed_logs').run()
    } catch (error) {
      repos.prepare('ROLLBACK TO pi_seed_logs').run()
      repos.prepare('RELEASE pi_seed_logs').run()
      throw error
    }
  }
  return { taskId, runId: runIdValue, workerId }
}

// ───────────────────────────── observeSlices ─────────────────────────────

export interface SliceObservation {
  /** 每次 `DELETE FROM task_logs ...` 实际删除的行数（按执行顺序）。 */
  logDeletes: number[]
  /** `PRAGMA incremental_vacuum(...)` 的调用次数。 */
  readonly vacuumCalls: number
  /** 恢复原始 prepare / pragma。 */
  restore(): void
}

/**
 * 就地包装 Repos 的 `prepare` / `pragma`，观察保留策略的分片删除与增量回收。
 * `Repos` 是普通对象（`openStore` 里 `Object.assign`），事务闭包持有同一引用，
 * 因此在测试期间替换属性即可覆盖 `store.tx()`、`cleanup()` 与 retention 插件的全部调用。
 */
export function observeSlices(repos: Repos): SliceObservation {
  const logDeletes: number[] = []
  let vacuumCalls = 0
  const originalPrepare = repos.prepare
  const originalPragma = repos.pragma
  repos.prepare = ((source: string) => {
    const statement = originalPrepare(source)
    if (!/DELETE\s+FROM\s+task_logs\b/iu.test(source)) return statement
    const run = statement.run.bind(statement)
    statement.run = ((...args: unknown[]) => {
      const result = run(...args) as { changes: number }
      logDeletes.push(result.changes)
      return result
    }) as typeof statement.run
    return statement
  }) as Repos['prepare']
  repos.pragma = ((source: string, options?: unknown) => {
    if (/^\s*incremental_vacuum\b/iu.test(source)) vacuumCalls++
    return originalPragma(source, options as never)
  }) as Repos['pragma']
  return {
    logDeletes,
    get vacuumCalls() { return vacuumCalls },
    restore() { repos.prepare = originalPrepare; repos.pragma = originalPragma },
  }
}

// ───────────────────────────── PanelClient ─────────────────────────────

export type RecordedFrame = { frame: DashServerFrame & { type?: string; data?: unknown }; at: number }

/** 面板 WebSocket 客户端：记录每个服务端帧的到达时间，用于扇出/去抖延迟统计。 */
export class PanelClient {
  readonly frames: RecordedFrame[] = []
  closeCode: number | undefined
  closeReason = ''
  private helloed = false

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data as ArrayBuffer).toString()
      const at = performance.now()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      const result = DashServerFrame.safeParse(parsed)
      if (result.success) this.frames.push({ frame: result.data as RecordedFrame['frame'], at })
    })
    ws.on('close', (code: number, reason: Buffer) => { this.closeCode = code; this.closeReason = reason.toString() })
    ws.on('error', () => undefined)
  }

  static async open(address: string, token: string, origin?: string): Promise<PanelClient> {
    const url = address.replace(/^http/, 'ws') + '/ws/dashboard'
    const ws = new WebSocket(url, DASHBOARD_SUBPROTOCOL as unknown as string, {
      origin, headers: { authorization: 'Bearer ' + token }, perMessageDeflate: false,
    })
    const client = new PanelClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('unexpected-response', (_request, response) => reject(new Error('upgrade rejected: ' + response.statusCode)))
      ws.once('error', error => reject(error))
    })
    return client
  }

  send(frame: DashClientFrame) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)) }

  /** 首次调用发送 hello 并等待 welcome，随后订阅给定主题。 */
  async subscribe(topics: Topic[]) {
    if (!this.helloed) {
      this.send({ t: 'hello' })
      await this.wait(frame => frame.t === 'welcome', 10_000, 'welcome')
      this.helloed = true
    }
    this.send({ t: 'subscribe', topics })
  }

  /** 等待任一已到达帧满足条件；超时抛出带上下文的错误。 */
  async wait(predicate: (frame: RecordedFrame['frame']) => boolean, timeoutMs = 5000, label = 'frame') {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const found = this.frames.find(entry => predicate(entry.frame))
      if (found) return found
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('timed out waiting for ' + label + ' | saw=' + this.frames.map(entry => entry.frame.t).join(','))
  }

  terminate() { this.ws.terminate() }

  async close(code = 1000) {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>(resolve => this.ws.once('close', () => resolve()))
    this.ws.close(code)
    await closed
  }
}
