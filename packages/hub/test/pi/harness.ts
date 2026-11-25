/**
 * Pi 独立验收测试基础设施（pi-test-matrix §0）
 *
 * 提供：TestHub 工厂、Worker 身份注册、FakeWorkerClient（裸协议收发）、
 * ChaosProxy（cut / blackhole / delay / throttle）、assertInvariants / assertLogInvariants。
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { runId, taskId, ulid } from '@agent-hub/common'
import { WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import type { AdapterCapability, RunEvent, RunResumeState, WorkerHello, WorkspaceDecl } from '@agent-hub/protocol'
import { createTestHub } from '../../src/app.js'
import type { TestHub } from '../../src/app.js'
import type { Repos } from '../../src/services/store.js'
import { activeRunStatuses } from '../../src/services/workers.js'

export { once }

export interface WorkerIdentity {
  workerId: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  der: Buffer
  publicKey: string
  fingerprint: string
}

export function newIdentity(workerId: string): WorkerIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { workerId, privateKey, der, publicKey: der.toString('base64'),
    fingerprint: createHash('sha256').update(der).digest('base64url').slice(0, 16) }
}

export async function enrollWorker(hub: TestHub, workerId: string, identity = newIdentity(workerId)) {
  const { token } = hub.ctx.auth.createEnrollToken({ type: 'owner', id: 'owner', channel: 'dashboard' }, workerId)
  hub.ctx.auth.enroll({ token, workerId, publicKey: identity.publicKey, hostname: 'pi-host',
    os: process.platform as 'win32' | 'linux' | 'darwin' }, '127.0.0.1')
  return identity
}

export function tmpDir(prefix = 'pi-hub-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function openHarness(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const dir = tmpDir()
  // 逐段合并：storage/server 的局部覆盖不能丢掉临时目录路径（否则回落到仓库内 data/hub.sqlite）。
  const { storage: storageOverride, server: serverOverride, ...rest } = config
  const merged = {
    server: { port: 0, allowInsecureWorker: true, ...(serverOverride as object | undefined) },
    storage: { path: join(dir, 'hub.sqlite'), ...(storageOverride as object | undefined) },
    ...rest,
  }
  const hub = await createTestHub(merged as never, options as never)
  const cleanup = async () => {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, hub, cleanup, url: hub.address! }
}

export function wsUrl(address: string, path = '/ws/worker'): string {
  const url = new URL(path, address)
  url.protocol = 'ws:'
  return url.href
}

// ───────────────────────────── FakeWorkerClient ─────────────────────────────

export interface FakeWorkerOptions {
  workerId: string
  identity?: WorkerIdentity
  adapters?: AdapterCapability[]
  workspaces?: WorkspaceDecl[]
  maxConcurrency?: number
  runs?: RunResumeState[]
  drain?: boolean
  subprotocol?: string | string[] | null
  headers?: Record<string, string>
  hubPath?: string
  connect?: boolean
  /** 跳过 hello 的自动发送，便于测试握手细节。 */
  manualHello?: boolean
}

export const defaultAdapters: AdapterCapability[] = [
  { id: 'mock', status: 'ready', version: '0.1.0', features: { resume: true, liveInput: true, structuredOutput: true } },
]
export const defaultWorkspaces: WorkspaceDecl[] = [
  { id: 'sandbox', label: 'Sandbox', allowedAdapters: ['mock', 'claude-code', 'codex'], maxProfile: 'full',
    maxConcurrent: 2, isGitRepo: false },
  { id: 'backend', label: 'Backend', allowedAdapters: ['mock'], maxProfile: 'edit', maxConcurrent: 1, isGitRepo: true },
]

type Frame = Record<string, unknown> & { type: string; payload?: unknown }

export class FakeWorker {
  readonly frames: Frame[] = []
  readonly raw: string[] = []
  readonly sentRaw: string[] = []
  challenge: { nonce: string; hubBootId: string; serverTime: number; protocolVersions: number[] } | undefined
  welcome: Record<string, unknown> | undefined
  closeCode: number | undefined
  closeReason: string | undefined
  handshakeSentAt: number | undefined
  private waiters: Array<{ test: (frame: Frame) => boolean; resolve: (frame: Frame) => void; reject: (error: unknown) => void }> = []
  private closeWaiters: Array<(code: number) => void> = []
  private constructor(readonly ws: WebSocket, readonly identity: WorkerIdentity,
    private readonly helloPayload: () => WorkerHello, private readonly clock: () => number) {
    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data as ArrayBuffer).toString()
      this.raw.push(text)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return }
      if (!parsed || typeof parsed !== 'object') return
      const frame = parsed as Frame
      this.frames.push(frame)
      if (frame.type === 'hub.challenge') this.challenge = frame.payload as typeof this.challenge
      if (frame.type === 'hub.welcome') this.welcome = frame.payload as Record<string, unknown>
      for (const waiter of [...this.waiters]) {
        if (!waiter.test(frame)) continue
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(frame)
      }
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.closeCode = code
      this.closeReason = reason.toString()
      const text = JSON.stringify({ closed: true })
      void text
      for (const waiter of [...this.waiters]) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.reject(new Error('socket closed ' + code + ' ' + reason.toString()))
      }
      for (const resolve of this.closeWaiters.splice(0)) resolve(code)
    })
    ws.on('error', () => undefined)
  }

  static async connect(hub: TestHub, options: FakeWorkerOptions): Promise<FakeWorker> {
    const identity = options.identity ?? (await enrollWorker(hub, options.workerId))
    const subprotocol = options.subprotocol === null ? undefined : (options.subprotocol ?? WORKER_SUBPROTOCOL)
    const ws = new WebSocket(wsUrl(hub.address!, options.hubPath ?? '/ws/worker'), subprotocol as string,
      { headers: { 'X-Worker-Id': options.workerId, ...options.headers }, maxPayload: 8 << 20, perMessageDeflate: false,
        handshakeTimeout: 5000 })
    const payload: WorkerHello = {
      auth: { workerId: options.workerId, clientNonce: randomBytes(16).toString('base64url'),
        keyFingerprint: identity.fingerprint, signature: '' },
      agent: { version: '0.1.0-pi', hostname: 'pi-host', os: process.platform as 'win32' | 'linux' | 'darwin',
        arch: process.arch, nodeVersion: process.version, pid: process.pid },
      maxConcurrency: options.maxConcurrency ?? 2,
      adapters: options.adapters ?? defaultAdapters,
      workspaces: options.workspaces ?? defaultWorkspaces,
      runs: options.runs ?? [],
      drain: options.drain ?? false,
    }
    const worker = new FakeWorker(ws, identity, () => payload, () => hub.ctx.clock.now())
    if (options.connect === false) return worker
    await once(ws, 'open')
    const challenge = await worker.waitFor('hub.challenge')
    worker.challenge = challenge.payload as typeof worker.challenge
    if (!options.manualHello) await worker.authenticate()
    return worker
  }

  /** 用服务器下发的 nonce 计算签名并发送 hello；返回 welcome 帧。 */
  async authenticate(): Promise<Frame> {
    if (!this.challenge) throw new Error('no challenge yet')
    const hello = this.helloPayload()
    const nonce = this.challenge.nonce
    const clientNonce = hello.auth.clientNonce
    const signed = Buffer.from(['agent-hub/worker-auth/v1', hello.auth.workerId, nonce, clientNonce,
      this.challenge.hubBootId].join('\n'))
    hello.auth.signature = sign(null, signed, this.identity.privateKey).toString('base64url')
    this.handshakeSentAt = this.clock()
    this.send('worker.hello', hello)
    return this.waitFor('hub.welcome', 5000)
  }

  /** 用任意签名/nonce 构造 hello（负例）。 */
  sendHelloRaw(hello: WorkerHello) {
    this.handshakeSentAt = this.clock()
    this.send('worker.hello', hello)
  }

  hello(): WorkerHello { return this.helloPayload() }

  envelope(type: string, payload?: unknown): Record<string, unknown> {
    const ts = this.clock()
    return { v: 1, id: ulid(ts + this.frames.length), ts, type, payload: payload ?? {} }
  }

  sendFrame(frame: Record<string, unknown> | string) {
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
    this.sentRaw.push(text)
    this.ws.send(text)
  }

  sendRaw(text: string) { this.ws.send(text) }

  send(type: string, payload?: unknown) {
    this.sendFrame(this.envelope(type, payload))
  }

  sendBytes(bytes: Buffer) { this.ws.send(bytes) }

  waitFor(type: string, timeoutOrPredicate: number | ((frame: Frame) => boolean) = 3000, predicate?: (frame: Frame) => boolean) {
    const timeoutMs = typeof timeoutOrPredicate === 'number' ? timeoutOrPredicate : 3000
    const test = (typeof timeoutOrPredicate === 'function' ? timeoutOrPredicate : predicate) ?? (() => true)
    const existing = this.frames.find(frame => frame.type === type && test(frame))
    if (existing) return Promise.resolve(existing)
    return new Promise<Frame>((resolve, reject) => {
      const waiter = { test: (frame: Frame) => frame.type === type && test(frame), resolve, reject }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for ' + type + '; saw ' + this.frames.map(frame => String(frame.type)).join(',')))
      }, timeoutMs)
      const original = waiter.resolve
      waiter.resolve = (frame: Frame) => { clearTimeout(timer); original(frame) }
    })
  }

  count(type: string) { return this.frames.filter(frame => frame.type === type).length }

  waitClose(timeoutMs = 5000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode)
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs)
      this.closeWaiters.push(code => { clearTimeout(timer); resolve(code) })
    })
  }

  async heartbeat(overrides: Partial<Record<string, unknown>> = {}) {
    this.send('worker.heartbeat', { activeRuns: [], slotsUsed: 0, load: { memFreeMb: 1024, memTotalMb: 8192 },
      adapters: { mock: 'ready' }, bufferedBytes: 0, droppedLogBytesTotal: 0, ...overrides })
  }

  async ackCommand(frame: Frame, overrides: Record<string, unknown> = {}) {
    this.send('cmd.ack', { refId: frame.id, ok: true, ...overrides })
  }

  events(runId: string, taskId: string, events: Array<Record<string, unknown>>) {
    this.send('run.events', { runId, taskId, events })
  }

  close(code = 1000) { try { this.ws.close(code) } catch { /* ignore */ } }
  terminate() { this.ws.terminate() }
}

/** 生成连续 seq 的运行事件。 */
export function runEvents(from: number, items: Array<Omit<RunEvent, 'seq' | 'ts'> & Record<string, unknown>>, ts = 1_000) {
  return items.map((item, index) => ({ seq: from + index, ts: ts + from + index, ...item }))
}

// ───────────────────────────── ChaosProxy ─────────────────────────────

interface Pair { client: Socket; upstream: Socket; clientQueue: Buffer[]; upstreamQueue: Buffer[]; timer?: NodeJS.Timeout }

/**
 * Worker ↔ Hub 之间的进程内 TCP 代理。
 * cut()       立即 RST 双向连接（下一次 connect 仍可正常通过）
 * blackhole() 静默丢包（保持连接，模拟半开）
 * delay(ms)   转发延迟
 * throttle(bps) 双向限速（字节/秒）
 */
export class ChaosProxy {
  readonly server: Server
  mode: 'pass' | 'blackhole' = 'pass'
  delayMs = 0
  bytesPerSec = 0
  port = 0
  /** 为 true 时拒绝新连接（模拟 Worker 侧网络/进程完全不可达）。 */
  refusing = false
  private pairs = new Set<Pair>()
  private closed = false
  private constructor(private readonly targetHost: string, private readonly targetPort: number) {
    this.server = createServer(socket => this.accept(socket))
    this.server.on('error', () => undefined)
  }

  static async start(address: string): Promise<ChaosProxy> {
    const target = new URL(address)
    const proxy = new ChaosProxy(target.hostname, Number(target.port) || 80)
    await new Promise<void>(resolve => proxy.server.listen(0, '127.0.0.1', () => resolve()))
    proxy.port = (proxy.server.address() as { port: number }).port
    return proxy
  }

  get address() { return 'http://127.0.0.1:' + this.port }
  get url() { return 'ws://127.0.0.1:' + this.port + '/ws/worker' }

  private accept(client: Socket) {
    if (this.closed || this.refusing) { client.destroy(); return }
    const upstream = connect(this.targetPort, this.targetHost)
    upstream.setNoDelay(true)
    client.setNoDelay(true)
    const pair: Pair = { client, upstream, clientQueue: [], upstreamQueue: [] }
    this.pairs.add(pair)
    const teardown = () => {
      if (!this.pairs.delete(pair)) return
      if (pair.timer) clearInterval(pair.timer)
      client.destroy(); upstream.destroy()
    }
    client.on('error', teardown)
    upstream.on('error', teardown)
    client.on('close', teardown)
    upstream.on('close', teardown)
    client.on('data', chunk => this.forward(pair, 'up', chunk))
    upstream.on('data', chunk => this.forward(pair, 'down', chunk))
    if (this.bytesPerSec > 0) pair.timer = setInterval(() => this.drain(pair), 20)
  }

  private queue(pair: Pair, direction: 'up' | 'down', chunk: Buffer) {
    (direction === 'up' ? pair.clientQueue : pair.upstreamQueue).push(chunk)
  }

  private forward(pair: Pair, direction: 'up' | 'down', chunk: Buffer) {
    if (this.mode === 'blackhole') return
    if (this.bytesPerSec > 0) { this.queue(pair, direction, chunk); return }
    if (this.delayMs > 0) { setTimeout(() => this.write(pair, direction, chunk), this.delayMs); return }
    this.write(pair, direction, chunk)
  }

  private write(pair: Pair, direction: 'up' | 'down', chunk: Buffer) {
    if (this.mode === 'blackhole') return
    const socket = direction === 'up' ? pair.upstream : pair.client
    if (socket.destroyed) return
    socket.write(chunk)
  }

  private drain(pair: Pair) {
    const budget = Math.max(1, Math.floor(this.bytesPerSec * 0.02))
    for (const direction of ['up', 'down'] as const) {
      const queue = direction === 'up' ? pair.clientQueue : pair.upstreamQueue
      let remaining = budget
      while (queue.length && remaining > 0) {
        const chunk = queue[0]!
        if (chunk.length <= remaining) { queue.shift(); remaining -= chunk.length; this.write(pair, direction, chunk) }
        else { queue[0] = chunk.subarray(remaining); this.write(pair, direction, chunk.subarray(0, remaining)); remaining = 0 }
      }
    }
  }

  /** 立即断开当前所有连接（模拟 RST）。 */
  cut() {
    for (const pair of [...this.pairs]) {
      this.pairs.delete(pair)
      if (pair.timer) clearInterval(pair.timer)
      pair.client.destroy()
      pair.upstream.destroy()
    }
  }

  blackhole() { this.mode = 'blackhole'; this.delayMs = 0 }

  /** 彻底断网：立刻 RST 所有连接，并拒绝新连接，直到 `up()`。 */
  down() {
    this.refusing = true
    this.cut()
  }

  up() {
    this.refusing = false
    this.mode = 'pass'
  }
  restore() {
    this.mode = 'pass'
    this.delayMs = 0
    this.bytesPerSec = 0
    for (const pair of this.pairs) {
      if (pair.timer) { clearInterval(pair.timer); delete pair.timer }
      for (const direction of ['up', 'down'] as const) {
        const queue = direction === 'up' ? pair.clientQueue : pair.upstreamQueue
        while (queue.length) this.write(pair, direction, queue.shift()!)
      }
    }
  }
  delay(ms: number) { this.delayMs = ms }
  throttle(bytesPerSec: number) {
    this.bytesPerSec = bytesPerSec
    if (!this.pairs.size || bytesPerSec <= 0) return
    for (const pair of this.pairs) {
      if (!pair.timer) pair.timer = setInterval(() => this.drain(pair), 20)
    }
  }

  async close() {
    this.closed = true
    this.cut()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}

// ───────────────────────────── 不变量断言 ─────────────────────────────

const active = new Set<string>(activeRunStatuses)

export interface InvariantReport { checked: string[] }

/** 断言 02 §7 INV-1 ~ INV-8 与日志区间连续性（INV-7）。 */
export function assertInvariants(db: Repos): InvariantReport {
  const rows = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[]
  const report: InvariantReport = { checked: [] }
  const fail = (id: string, message: string): never => { throw new Error(id + ': ' + message) }

  const tasks = rows<{ id: string; status: string; version: number; current_run_id: string | null; attempt_count: number }>(
    'SELECT id, status, version, current_run_id, attempt_count FROM tasks')
  const runs = rows<{ id: string; task_id: string; status: string; worker_id: string; workspace_id: string; profile: string; last_seq: number }>(
    'SELECT id, task_id, status, worker_id, workspace_id, profile, last_seq FROM task_runs')
  const workers = rows<{ id: string; max_concurrency: number }>('SELECT id, max_concurrency FROM workers')
  const runsByTask = new Map<string, typeof runs>()
  for (const run of runs) {
    const list = runsByTask.get(run.task_id) ?? []
    list.push(run)
    runsByTask.set(run.task_id, list)
  }

  for (const task of tasks) {
    const taskRuns = runsByTask.get(task.id) ?? []
    const live = taskRuns.filter(run => active.has(run.status))
    // INV-1
    if (live.length > 1) fail('INV-1', 'task ' + task.id + ' has ' + live.length + ' non-terminal runs')
    // INV-2
    const isActive = active.has(task.status)
    if (isActive) {
      if (!task.current_run_id) fail('INV-2', 'active task ' + task.id + ' (' + task.status + ') has no current_run_id')
      const current = taskRuns.find(run => run.id === task.current_run_id)
      if (!current) fail('INV-2', 'task ' + task.id + ' current_run_id points to unknown run')
      if (!active.has(current!.status)) fail('INV-2', 'task ' + task.id + ' current run is terminal (' + current!.status + ')')
    } else if (task.current_run_id) {
      fail('INV-2', 'terminal/idle task ' + task.id + ' (' + task.status + ') still has current_run_id')
    }
    // INV-5 (structural part): version must be monotonic and >= 1
    if (!Number.isSafeInteger(task.version) || task.version < 1) fail('INV-5', 'task ' + task.id + ' has invalid version ' + task.version)
    // INV-8
    const counted = taskRuns.filter(run => run.status !== 'refused').length
    if (counted !== task.attempt_count) fail('INV-8', 'task ' + task.id + ' attempt_count=' + task.attempt_count + ' but non-refused runs=' + counted)
    // INV-6: no transition may be recorded after a terminal state
    if (task.status === 'succeeded' || task.status === 'rejected') {
      const auditRows = rows<{ id: number; to_status: string | null }>(
        'SELECT id, to_status FROM audit_logs WHERE target_type = ? AND target_id = ? ORDER BY id', 'task', task.id)
      const terminalAt = auditRows.map(row => row.to_status).lastIndexOf(task.status)
      for (const row of terminalAt >= 0 ? auditRows.slice(terminalAt + 1) : []) {
        if (row.to_status && row.to_status !== task.status) {
          fail('INV-6', 'terminal task ' + task.id + ' has later audit transition to ' + row.to_status)
        }
      }
    }
  }

  const workerSlots = new Map(workers.map(worker => [worker.id, worker.max_concurrency]))
  const perWorker = new Map<string, number>()
  const writeLock = new Map<string, number>()
  for (const run of runs) {
    if (!active.has(run.status)) continue
    perWorker.set(run.worker_id, (perWorker.get(run.worker_id) ?? 0) + 1)
    if (run.profile !== 'readonly') {
      const key = run.worker_id + '\0' + run.workspace_id
      writeLock.set(key, (writeLock.get(key) ?? 0) + 1)
    }
  }
  // INV-3
  for (const [workerId, count] of perWorker) {
    const limit = workerSlots.get(workerId)
    if (limit !== undefined && count > limit) fail('INV-3', 'worker ' + workerId + ' has ' + count + ' active runs > ' + limit)
  }
  // INV-4
  for (const [key, count] of writeLock) {
    if (count > 1) fail('INV-4', 'worker/workspace ' + key.replace('\0', '/') + ' has ' + count + ' write runs')
  }
  // INV-7
  for (const run of runs) assertRunLogContinuity(db, run.id, run.last_seq)

  report.checked = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7', 'INV-8']
  return report
}

export function assertRunLogContinuity(db: Repos, runId: string, lastSeq?: number) {
  const run = db.prepare('SELECT last_seq AS lastSeq, logs_purged_at AS logsPurgedAt FROM task_runs WHERE id = ?')
    .get(runId) as { lastSeq: number; logsPurgedAt: number | null } | undefined
  if (!run) throw new Error('INV-7: unknown run ' + runId)
  const expectedLast = lastSeq ?? run.lastSeq
  const logs = db.prepare('SELECT seq, kind, data_json AS dataJson FROM task_logs WHERE run_id = ? ORDER BY seq').all(runId) as
    Array<{ seq: number; kind: string; dataJson: string | null }>
  // 保留策略（07 §6）为已清理 Run 写入 logs_purged_at：此时日志按设计不存在，INV-7 不再适用。
  // 只校验“标记清理后确实没有残留日志”，避免合法清理被误判为 INVO 违规。
  if (run.logsPurgedAt !== null) {
    if (logs.length > 0) throw new Error('INV-7: run ' + runId + ' was purged but still has ' + logs.length + ' log rows')
    return
  }
  let cursor = 0
  for (const row of logs) {
    if (row.seq !== cursor + 1) throw new Error('INV-7: run ' + runId + ' seq ' + row.seq + ' after ' + cursor)
    if (row.kind === 'gap') {
      const data = JSON.parse(row.dataJson ?? '{}') as { toSeq?: number }
      if (!data.toSeq || data.toSeq < row.seq) throw new Error('INV-7: gap at ' + row.seq + ' has toSeq ' + data.toSeq)
      cursor = data.toSeq
    } else cursor = row.seq
  }
  if (cursor !== expectedLast) throw new Error('INV-7: run ' + runId + ' logs end at ' + cursor + ' but last_seq=' + expectedLast)
}

// ───────────────────────────── 便利函数 ─────────────────────────────

export const ownerActor = { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as const
export const systemActor = { type: 'system', id: 'hub', channel: 'system' } as const

export function delay(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)) }

export async function eventually<T>(fn: () => T | Promise<T>, options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}) {
  const timeout = options.timeoutMs ?? 5000
  const interval = options.intervalMs ?? 10
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeout) {
    try {
      const value = await fn()
      if (value) return value
      last = value
    } catch (error) { last = error }
    await delay(interval)
  }
  throw new Error('eventually timed out' + (options.label ? ': ' + options.label : '') + ' (last=' + String(last) + ')')
}

/** 直接插入 Task + Run 记录，供网关/状态机测试绕过调度器。 */
export function seedRun(hub: TestHub, options: {
  workerId: string
  taskId?: string
  runId?: string
  taskStatus?: 'dispatching' | 'running' | 'awaiting_approval' | 'queued' | 'awaiting_input' | 'cancelling'
  runStatus?: 'dispatching' | 'running' | 'awaiting_input' | 'cancelling' | 'succeeded' | 'lost' | 'refused'
  profile?: 'readonly' | 'edit' | 'full'
  workspaceId?: string
  lastSeq?: number
  attemptCount?: number
  maxAttempts?: number
  requesterType?: 'owner' | 'requester'
  requesterId?: string
}) {
  const now = hub.ctx.clock.now()
  const taskIdValue = options.taskId ?? taskId(now)
  const runIdValue = options.runId ?? runId(now)
  const taskStatus = options.taskStatus ?? 'dispatching'
  const runStatus = options.runStatus ?? 'dispatching'
  const profile = options.profile ?? 'readonly'
  const workspaceId = options.workspaceId ?? 'sandbox'
  const requesterType = options.requesterType ?? 'owner'
  hub.ctx.store.tx(db => {
    db.tasks.insert({ id: taskIdValue, status: taskStatus, version: 1, source: 'dashboard', originJson: { source: 'dashboard' },
      requesterType, requesterId: options.requesterId ?? (requesterType === 'owner' ? 'dashboard:owner' : 'requester-1'),
      title: 'seed', prompt: 'seed prompt', workspaceId, profile, timeoutMs: 600_000,
      maxAttempts: options.maxAttempts ?? 3, attemptCount: options.attemptCount ?? 1, runSeq: 1,
      policyDecisionJson: { ruleId: null, decision: 'auto_approve' }, currentRunId: runIdValue,
      createdAt: now, updatedAt: now, queuedAt: now, startedAt: taskStatus === 'dispatching' ? null : now,
      approvalDeadlineAt: taskStatus === 'awaiting_approval' ? now + 60_000 : null })
    db.prepare('INSERT INTO task_runs (id, task_id, run_seq, attempt, worker_id, adapter, workspace_id, profile, status, '
      + 'dispatched_at, not_after, last_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(runIdValue, taskIdValue, 1, 1, options.workerId, 'mock', workspaceId, profile, runStatus, now,
        now + 40_000, options.lastSeq ?? 0)
  })
  return { taskId: taskIdValue, runId: runIdValue }
}
