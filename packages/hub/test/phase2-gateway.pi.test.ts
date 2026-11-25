/**
 * Pi 独立验收 · Phase 2 门禁：GW-1 ~ GW-16
 * 对照 docs/specs/03-protocol-hub-worker.md §3 §4 §5 §6 §7 §8。
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FakeClock, ulid } from '@agent-hub/common'
import { WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import type { WorkerHello } from '@agent-hub/protocol'
import { CommandOutbox, CommandTimeoutError } from '../src/plugins/worker-gateway-ws/command-outbox.js'
import { assertInvariants, assertRunLogContinuity, delay, enrollWorker, eventually, FakeWorker, newIdentity,
  openHarness, ownerActor, seedRun } from './pi/harness.js'

const config = {
  server: { port: 0, allowInsecureWorker: true },
  workers: { handshakeTimeoutMs: 5000, ackIntervalMs: 50, cmdAckTimeoutMs: 1000, maxResends: 3, gracePeriodMs: 2000 },
}

function signedHello(identity: ReturnType<typeof newIdentity>, challenge: { nonce: string; hubBootId: string },
  overrides: Partial<WorkerHello['auth']> = {}, clientNonce = randomBytes(16).toString('base64url')): WorkerHello {
  const auth = { workerId: identity.workerId, clientNonce, keyFingerprint: identity.fingerprint, signature: '', ...overrides }
  const signed = Buffer.from(['agent-hub/worker-auth/v1', identity.workerId, challenge.nonce, auth.clientNonce,
    challenge.hubBootId].join('\n'))
  auth.signature = sign(null, signed, identity.privateKey).toString('base64url')
  return { auth, agent: { version: '0.1.0-pi', hostname: 'pi', os: process.platform as 'win32' | 'linux' | 'darwin',
    arch: process.arch, nodeVersion: process.version, pid: process.pid }, maxConcurrency: 2,
  adapters: [{ id: 'mock', status: 'ready', features: { resume: true, liveInput: true, structuredOutput: true } }],
  workspaces: [{ id: 'sandbox', label: 'Sandbox', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false }],
  runs: [], drain: false }
}

describe('GW-1 / GW-2 / GW-3 握手', () => {
  it('GW-1 正常握手：challenge → 签名 hello → welcome，connection_epoch +1', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const identity = await enrollWorker(hub, 'gw-ok')
      const first = await FakeWorker.connect(hub, { workerId: 'gw-ok', identity })
      expect(first.welcome).toMatchObject({ connectionEpoch: 1 })
      expect(hub.ctx.store.repos.workers.get('gw-ok')!.connectionEpoch).toBe(1)
      expect(hub.ctx.workers.isOnline('gw-ok')).toBe(true)
      const second = await FakeWorker.connect(hub, { workerId: 'gw-ok', identity })
      expect(second.welcome).toMatchObject({ connectionEpoch: 2 })
      expect(hub.ctx.store.repos.workers.get('gw-ok')!.connectionEpoch).toBe(2)
      first.terminate()
      second.terminate()
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it.each([
    ['错误签名', (identity: ReturnType<typeof newIdentity>, challenge: { nonce: string; hubBootId: string }) => {
      const hello = signedHello(identity, challenge)
      hello.auth.signature = sign(null, Buffer.from('wrong-message'), identity.privateKey).toString('base64url')
      return hello
    }],
    ['错误 nonce', (identity: ReturnType<typeof newIdentity>, challenge: { nonce: string; hubBootId: string }) =>
      signedHello(identity, { nonce: randomBytes(32).toString('base64url'), hubBootId: challenge.hubBootId })],
    ['错误 hubBootId', (identity: ReturnType<typeof newIdentity>, challenge: { nonce: string; hubBootId: string }) =>
      signedHello(identity, { nonce: challenge.nonce, hubBootId: ulid(1) })],
    ['指纹不符', (identity: ReturnType<typeof newIdentity>, challenge: { nonce: string; hubBootId: string }) =>
      signedHello(identity, challenge, { keyFingerprint: createHash('sha256').update('other').digest('base64url').slice(0, 16) })],
  ])('GW-2 %s：hub.reject AUTH_FAILED + 4401', async (_label, tamper) => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const identity = await enrollWorker(hub, 'gw-bad')
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-bad', identity, manualHello: true })
      const hello = tamper(identity, worker.challenge!)
      const closed = worker.waitClose()
      worker.sendHelloRaw(hello)
      expect(await closed).toBe(4401)
      expect(worker.frames.some(frame => frame.type === 'hub.reject'
        && (frame.payload as { code?: string })?.code === 'AUTH_FAILED')).toBe(true)
      expect(hub.ctx.store.repos.workers.get('gw-bad')!.connectionEpoch).toBe(0)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-3 未注册 workerId → 4401；已吊销 → 4403', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const unknown = newIdentity('gw-unknown')
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-unknown', identity: unknown, manualHello: true })
      const closed = worker.waitClose()
      worker.sendHelloRaw(signedHello(unknown, worker.challenge!))
      expect(await closed).toBe(4401)

      const revoked = await enrollWorker(hub, 'gw-revoked')
      await hub.ctx.workers.revoke('gw-revoked', ownerActor)
      const rejected = await FakeWorker.connect(hub, { workerId: 'gw-revoked', identity: revoked, manualHello: true })
      const revokedClosed = rejected.waitClose()
      rejected.sendHelloRaw(signedHello(revoked, rejected.challenge!))
      expect(await revokedClosed).toBe(4403)
      expect(rejected.frames.some(frame => (frame.payload as { code?: string })?.code === 'WORKER_REVOKED')).toBe(true)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-4 握手超时（不发 hello）→ 5s 后 4408', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const idleIdentity = await enrollWorker(hub, 'gw-idle')
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-idle', identity: idleIdentity, manualHello: true })
      const closed = worker.waitClose()
      clock.advance(4_999)
      await delay(50)
      expect(worker.closeCode).toBeUndefined()
      clock.advance(2)
      expect(await closed).toBe(4408)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-5 鉴权前 > 16 KiB 帧 → 断开（4400）', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const bigIdentity = await enrollWorker(hub, 'gw-big')
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-big', identity: bigIdentity, manualHello: true })
      const closed = worker.waitClose()
      worker.sendRaw('{"v":1,"id":"' + 'A'.repeat(20) + '","ts":1,"type":"worker.hello","payload":{}}' + ' '.repeat(17 * 1024))
      expect(await closed).toBe(4400)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-6 重放上一个连接的 hello 帧 → 4401', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const identity = await enrollWorker(hub, 'gw-replay')
      const first = await FakeWorker.connect(hub, { workerId: 'gw-replay', identity })
      expect(first.welcome).toBeTruthy()
      const helloFrame = first.sentRaw.find(text => text.includes('worker.hello'))!
      expect(helloFrame).toBeTruthy()
      first.terminate()

      const replay = await FakeWorker.connect(hub, { workerId: 'gw-replay', identity, manualHello: true })
      const closed = replay.waitClose()
      replay.sendRaw(helloFrame)
      expect(await closed).toBe(4401)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-7 同一 workerId 第二个连接：旧连接 4409，新连接正常，旧连接后续帧被忽略', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const identity = await enrollWorker(hub, 'gw-dupe')
      const first = await FakeWorker.connect(hub, { workerId: 'gw-dupe', identity })
      const seed = seedRun(hub, { workerId: 'gw-dupe' })
      const oldClosed = first.waitClose()
      const second = await FakeWorker.connect(hub, { workerId: 'gw-dupe', identity })
      expect(second.welcome).toBeTruthy()
      expect(await oldClosed).toBe(4409)
      // 旧连接在关闭前发出的帧不应被持久化
      first.events(seed.runId, seed.taskId, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'from-old' }])
      await delay(100)
      second.events(seed.runId, seed.taskId, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'from-new' }])
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 1)
      const logs = hub.ctx.store.repos.prepare('SELECT text FROM task_logs WHERE run_id = ?').all(seed.runId) as { text: string }[]
      expect(logs).toEqual([{ text: 'from-new' }])
      expect(hub.ctx.store.repos.workers.get('gw-dupe')!.connectionEpoch).toBe(2)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-8 同 IP 连续 5 次认证失败 → 第 6 次 HTTP 429；30 min 后恢复', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const identity = await enrollWorker(hub, 'gw-brute')
      for (let attempt = 0; attempt < 5; attempt++) {
        const worker = await FakeWorker.connect(hub, { workerId: 'gw-brute', identity, manualHello: true })
        const hello = signedHello(identity, worker.challenge!)
        hello.auth.signature = sign(null, Buffer.from('nope'), identity.privateKey).toString('base64url')
        const closed = worker.waitClose()
        worker.sendHelloRaw(hello)
        expect(await closed).toBe(4401)
      }
      const blocked = await FakeWorker.connect(hub, { workerId: 'gw-brute', identity, connect: false })
      const status = await new Promise<string>(resolve => {
        blocked.ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
        blocked.ws.on('error', () => undefined)
        blocked.ws.on('open', () => resolve('open'))
      })
      expect(status).toBe('429')
      blocked.terminate()
      clock.advance(1_800_000)
      const recovered = await FakeWorker.connect(hub, { workerId: 'gw-brute', identity })
      expect(recovered.welcome).toBeTruthy()
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-9 未认证连接数上限（默认 64）→ 第 65 个被拒', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers,
      rateLimits: { upgradesPerMinute: 1000, maxUnauthenticated: 64, framesPerSecond: 200, bytesPerSecond: 8 << 20 } } }, { clock })
    try {
      const userId = 'gw-flood-auth'
      const identity = await enrollWorker(hub, userId)
      const sockets = []
      for (let index = 0; index < 64; index++) sockets.push(await FakeWorker.connect(hub, { workerId: userId, identity, manualHello: true }))
      expect(hub.ctx.workers.metrics().workerConnections).toBe(0)
      const extra = await FakeWorker.connect(hub, { workerId: userId, identity, manualHello: true, connect: false })
      const status = await new Promise<string>(resolve => {
        extra.ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)))
        extra.ws.on('error', () => undefined)
        extra.ws.on('open', () => resolve('open'))
      })
      expect(status).toBe('503')
      extra.terminate()
      for (const socket of sockets) socket.terminate()
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('GW-10 ~ GW-14 运行事件与确认语义', () => {
  it('GW-10 seq 重复帧：不重复写库，回 ack', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-dup' })
      const seed = seedRun(hub, { workerId: 'gw-dup' })
      worker.events(seed.runId, seed.taskId, [1, 2, 3].map(seq => ({ seq, ts: seq, kind: 'log', stream: 'stdout', text: 'line' + seq })))
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 3)
      worker.events(seed.runId, seed.taskId, [2, 3].map(seq => ({ seq, ts: seq, kind: 'log', stream: 'stdout', text: 'line' + seq })))
      const ack = await worker.waitFor('run.ack', frame => (frame.payload as { acks: { runId: string; ackSeq: number }[] })
        .acks.some(entry => entry.runId === seed.runId && entry.ackSeq === 3))
      expect(ack).toBeTruthy()
      const rows = hub.ctx.store.repos.prepare('SELECT seq FROM task_logs WHERE run_id = ? ORDER BY seq').all(seed.runId)
      expect(rows).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }])
      assertRunLogContinuity(hub.ctx.store.repos, seed.runId)
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-11 seq 缺口（1-10 → 15-20）：只持久化 1-10，发 run.resend{fromSeq:11}，补发后全部有序', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-gap' })
      const seed = seedRun(hub, { workerId: 'gw-gap' })
      const line = (seq: number) => ({ seq, ts: seq, kind: 'log' as const, stream: 'stdout' as const, text: 'l' + seq })
      worker.events(seed.runId, seed.taskId, Array.from({ length: 10 }, (_, i) => line(i + 1)))
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 10)
      worker.events(seed.runId, seed.taskId, Array.from({ length: 6 }, (_, i) => line(i + 15)))
      const resend = await worker.waitFor('run.resend', 3000, frame => (frame.payload as { runId?: string }).runId === seed.runId)
      expect(resend.payload).toEqual({ runId: seed.runId, fromSeq: 11 })
      expect(hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq).toBe(10)
      worker.events(seed.runId, seed.taskId, Array.from({ length: 10 }, (_, i) => line(i + 11)))
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 20)
      const seqs = (hub.ctx.store.repos.prepare('SELECT seq FROM task_logs WHERE run_id = ? ORDER BY seq').all(seed.runId) as { seq: number }[])
        .map(row => row.seq)
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      assertRunLogContinuity(hub.ctx.store.repos, seed.runId)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-12 run.gap：写入一行 kind=gap，last_seq 推进到 toSeq，INV-7 区间连续', async () => {
    const { hub, cleanup } = await openHarness(config)
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-rungap' })
      const seed = seedRun(hub, { workerId: 'gw-rungap' })
      worker.send('run.gap', { runId: seed.runId, fromSeq: 1, toSeq: 5 })
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 5)
      const rows = hub.ctx.store.repos.prepare('SELECT seq, kind, data_json AS dataJson FROM task_logs WHERE run_id = ?').all(seed.runId) as
        Array<{ seq: number; kind: string; dataJson: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.kind).toBe('gap')
      expect(JSON.parse(rows[0]!.dataJson)).toMatchObject({ toSeq: 5 })
      assertRunLogContinuity(hub.ctx.store.repos, seed.runId)
      worker.events(seed.runId, seed.taskId, [{ seq: 6, ts: 6, kind: 'log', stream: 'stdout', text: 'after' }])
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 6)
      assertRunLogContinuity(hub.ctx.store.repos, seed.runId)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-13 ack 时机：提交事务前注入延迟 → ack 必须在提交之后才发出', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers, ackIntervalMs: 10 } }, { clock })
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-ack' })
      const seed = seedRun(hub, { workerId: 'gw-ack' })
      const ingest = hub.ctx.store.ingest as unknown as { enqueue: (...args: unknown[]) => Promise<unknown> }
      const original = ingest.enqueue.bind(ingest)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      ingest.enqueue = async (...args: unknown[]) => { await gate; return original(...args) }
      worker.events(seed.runId, seed.taskId, [
        { seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'one' },
        { seq: 2, ts: 2, kind: 'log', stream: 'stdout', text: 'two' },
      ])
      await delay(50)
      clock.advance(100)
      await delay(100)
      // 事务尚未提交：不应出现 ack，且数据库无日志行
      expect(worker.frames.filter(frame => frame.type === 'run.ack')).toHaveLength(0)
      expect(hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq).toBe(0)
      release()
      await delay(20)
      clock.advance(100)
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 2)
      await delay(20)
      clock.advance(150)
      const ack = await worker.waitFor('run.ack', 3000, frame => (frame.payload as { acks: { runId: string; ackSeq: number }[] })
        .acks.some(entry => entry.runId === seed.runId && entry.ackSeq === 2))
      expect(ack).toBeTruthy()
      const rows = hub.ctx.store.repos.prepare('SELECT seq FROM task_logs WHERE run_id = ? ORDER BY seq').all(seed.runId)
      expect(rows).toEqual([{ seq: 1 }, { seq: 2 }])
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-14 处理器未注册时收到 run.events：不 ack；注册后重发并持久化', async () => {
    const clock = new FakeClock(1_000)
    const { hub, cleanup } = await openHarness(config, { clock })
    try {
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-hold' })
      const seed = seedRun(hub, { workerId: 'gw-hold' })
      const orchestrator = hub.ctx.orchestrator
      const handler = {
        onRunEvents: orchestrator.onRunEvents.bind(orchestrator),
        onRunGap: orchestrator.onRunGap.bind(orchestrator),
        onCommandAck: orchestrator.onCommandAck.bind(orchestrator),
        reconcile: orchestrator.reconcile.bind(orchestrator),
        onWorkerOffline: orchestrator.onWorkerOffline.bind(orchestrator),
      }
      // 模拟「orchestrator 重启中」网关可见的状态：inbound 已解绑（见 WorkerGatewayWs.setInboundHandler 的 effect）。
      const raw = (hub.ctx.workers as unknown as Record<symbol, { inbound?: unknown }>)[Symbol.for('cordis.original')]!
      raw.inbound = undefined
      worker.events(seed.runId, seed.taskId, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'held' }])
      await delay(50)
      clock.advance(100)
      await delay(100)
      expect(worker.frames.filter(frame => frame.type === 'run.ack')).toHaveLength(0)
      expect(hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq).toBe(0)
      hub.ctx.workers.setInboundHandler(handler)
      const resend = await worker.waitFor('run.resend', 3000, frame => (frame.payload as { runId?: string }).runId === seed.runId)
      expect((resend.payload as { fromSeq: number }).fromSeq).toBe(1)
      worker.events(seed.runId, seed.taskId, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'held' }])
      await delay(50)
      clock.advance(100)
      await eventually(() => hub.ctx.store.repos.runs.get(seed.runId)!.lastSeq === 1)
      await delay(20)
      clock.advance(150)
      await worker.waitFor('run.ack', 3000, frame => (frame.payload as { acks: { runId: string; ackSeq: number }[] })
        .acks.some(entry => entry.runId === seed.runId && entry.ackSeq === 1))
      assertRunLogContinuity(hub.ctx.store.repos, seed.runId)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })
})

describe('GW-15 / GW-16 命令可靠传输', () => {
  it('GW-15 dispatch 至少一次：断网重连后同 runId 重发，Run 只有一条', async () => {
    const { hub, cleanup } = await openHarness({ ...config, workers: { ...config.workers, gracePeriodMs: 5000 } })
    try {
      const identity = await enrollWorker(hub, 'gw-once')
      const worker = await FakeWorker.connect(hub, { workerId: 'gw-once', identity })
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'dispatch me', workspaceId: 'sandbox', adapter: 'mock' }, ownerActor)
      const first = await worker.waitFor('run.dispatch', 5000)
      const run = first.payload as { runId: string; taskId: string }
      expect(run.taskId).toBe(task.id)
      // 不 ack，直接断开
      worker.terminate()
      await eventually(() => hub.ctx.store.repos.workers.get('gw-once')!.connection === 'offline')
      await delay(100)
      const again = await FakeWorker.connect(hub, { workerId: 'gw-once', identity })
      const resent = await again.waitFor('run.dispatch', 5000, frame => (frame.payload as { runId: string }).runId === run.runId)
      expect(resent.id).toBe(first.id)
      const runs = hub.ctx.store.repos.runs.forTask(task.id)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.status).toBe('dispatching')
      await again.ackCommand(resent)
      await eventually(() => hub.ctx.orchestrator.getTask(task.id)!.status === 'running')
      assertInvariants(hub.ctx.store.repos)
      assertInvariants(hub.ctx.store.repos)
    } finally { await cleanup() }
  })

  it('GW-16 cmd ack 超时重发上限：初次 + 3 次重发后 reject（DISPATCH_LOST 路径）', async () => {
    const outbox = new CommandOutbox()
    const sent: string[] = []
    const command = { v: 1 as const, id: ulid(1_000), ts: 1_000, type: 'worker.drain' as const, payload: { drain: true } }
    const pending = outbox.enqueue(command).then(() => undefined, (error: unknown) => error)
    let now = 0
    for (let round = 0; round < 5; round++) {
      outbox.pump(entry => sent.push(entry.id), now, 1_000, 3)
      now += 1_000
      await delay(1)
    }
    expect(sent).toHaveLength(4)
    expect(await pending).toBeInstanceOf(CommandTimeoutError)
    expect(new Set(sent).size).toBe(1)
  })
})

void WORKER_SUBPROTOCOL
void generateKeyPairSync
