import { createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from 'cordis'
import { WebSocket, WebSocketServer } from 'ws'
import type { RawData } from 'ws'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { Lru, TokenBucket, ulid } from '@agent-hub/common'
import { CAPABILITY_HEADER, parseCapabilityHeader, negotiateCapabilities, Envelope, WorkerToHubFrame, WorkerId, WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import type { Actor, HubCommand, HubToWorkerFrame, WorkerHeartbeat, WorkerHello, WorkerView } from '@agent-hub/protocol'
import type { WorkerGateway, WorkerInboundHandler } from '../../services/workers.js'
import type { WorkerRow } from '../../services/store.js'
import { HubError } from '../../services/errors.js'
import { guardAsync } from '../../kernel/safe.js'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'
import { auditLogs, inputRequests, taskRuns, workers } from '../store-sqlite/schema.js'
import { CommandOutbox } from './command-outbox.js'
import { RunInbox } from './run-inbox.js'

import { activeRunStatuses } from '../../services/workers.js'
const knownWorkerFrameTypes = new Set(['worker.hello', 'worker.heartbeat', 'worker.state', 'worker.bye', 'cmd.ack', 'run.events', 'run.gap'])
export interface GatewayConfig {
  capabilities: string[]
  path: string; heartbeatIntervalMs: number; heartbeatTimeoutMs: number; gracePeriodMs: number
  handshakeTimeoutMs: number; maxFrameBytes: number; maxInFlightBytes: number; ackIntervalMs: number
  cmdAckTimeoutMs: number; maxResends: number; redactionPatterns: string[]
  rateLimits: { upgradesPerMinute: number; maxUnauthenticated: number; framesPerSecond: number; bytesPerSecond: number }
}
interface Connection {
  offered: string[] | undefined
  capabilities: string[]
  ws: WebSocket
  workerId: string
  ip: string
  nonce: string
  openedAt: number
  lastFrame: number
  pingAt: number
  rtt: number | null
  hello: WorkerHello | undefined
  epoch: number
  welcomed: boolean
  heartbeat: WorkerHeartbeat | undefined
  frames: TokenBucket
  bytes: TokenBucket
  processing: Promise<unknown>
  queuedBytes: number
  stale: Lru<string, true>
  resends: Lru<string, number>
  acks: Map<string, number>
  withheld: Set<string>
  lastAck: number
}
type Failure = { times: number[]; blockedUntil: number }
type Payload<T> = T extends HubToWorkerFrame ? Pick<T, 'type' | 'payload'> : never

export class WorkerGatewayWs extends Service implements WorkerGateway {
  static inject = ['http', 'store', 'clock']
  static Config = HubConfigSchema.shape.workers
  startedAt = 0
  bootId = ''
  private readonly sockets = new Set<Connection>()
  private readonly connected = new Map<string, Connection>()
  private readonly outboxes = new Map<string, CommandOutbox>()
  private inbound: WorkerInboundHandler | undefined
  private stopping = false
  private badFrames = 0
  private upgrades!: Lru<string, TokenBucket>
  private ipFailures!: Lru<string, Failure>
  private idFailures!: Lru<string, Failure>
  private inbox!: RunInbox
  constructor(ctx: Context, private config: GatewayConfig) { super(ctx, 'workers') }
  get gracePeriodMs() { return this.config.gracePeriodMs }
  [Service.init]() {
    this.startedAt = this.ctx.clock.now()
    this.bootId = ulid(this.startedAt)
    this.ctx.store.tx(db => {
      db.update(workers).set({ connection: 'offline', disconnectedAt: this.startedAt }).where(inArray(workers.connection, ['online', 'suspect'])).run()
      db.prepare("INSERT INTO meta VALUES ('hub_boot_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.bootId)
    })
    this.upgrades = new Lru(10_000, 120_000, this.ctx.clock)
    this.ipFailures = new Lru(10_000, 3_600_000, this.ctx.clock)
    this.idFailures = new Lru(10_000, 3_600_000, this.ctx.clock)
    this.inbox = new RunInbox(id => this.ctx.store.repos.runs.get(id))
    const server = new WebSocketServer({ noServer: true, maxPayload: this.config.maxFrameBytes, perMessageDeflate: false })
    this.ctx.effect(() => () => new Promise<void>(resolve => server.close(() => resolve())), 'workers:wss')
    this.ctx.effect(() => this.ctx.http.upgrade(this.config.path, (req, sock, head) => this.upgrade(server, req, sock, head)), 'workers:upgrade')
    this.ctx.effect(() => this.ctx.clock.setInterval(() => this.sweep(), 100), 'workers:sweep')
    this.ctx.effect(() => async () => {
      this.stopping = true
      this.inbound = undefined
      for (const outbox of this.outboxes.values()) outbox.clear()
      const waits = [...this.sockets].map(conn => new Promise<void>(resolve => {
        if (conn.ws.readyState === WebSocket.CLOSED) { resolve(); return }
        const timeout = setTimeout(() => conn.ws.terminate(), 1000)
        conn.ws.once('close', () => { clearTimeout(timeout); resolve() })
        conn.ws.close(4503, 'hub shutting down')
      }))
      await Promise.all(waits)
    }, 'workers:close-all')
    onHotUpdate<GatewayConfig>(this.ctx, ['heartbeatIntervalMs', 'heartbeatTimeoutMs', 'gracePeriodMs', 'ackIntervalMs',
      'cmdAckTimeoutMs', 'maxResends', 'capabilities', 'redactionPatterns', 'rateLimits'], next => {
      if (JSON.stringify(this.config.rateLimits) !== JSON.stringify(next.rateLimits)) {
        this.upgrades.clear()
        for (const conn of this.sockets) Object.assign(conn, this.buckets(next))
      }
      this.config = next
    })
  }
  private upgrade(server: WebSocketServer, req: IncomingMessage, sock: Duplex, head: Buffer) {
    if (!this.ctx.http.workerTransportAllowed(req)) {
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const ip = this.ctx.http.clientIp(req)
    const id = WorkerId.safeParse(req.headers['x-worker-id'])
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim())
    const fail = (status: string) => sock.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n')
    let rate = this.upgrades.get(ip)
    if (!rate) { rate = new TokenBucket(this.config.rateLimits.upgradesPerMinute / 60, this.config.rateLimits.upgradesPerMinute, this.ctx.clock); this.upgrades.set(ip, rate) }
    if (!rate.take() || (this.ipFailures.get(ip)?.blockedUntil ?? 0) > this.ctx.clock.now() ||
        (id.success && (this.idFailures.get(id.data)?.blockedUntil ?? 0) > this.ctx.clock.now())) return void fail('429 Too Many Requests')
    if (!id.success || protocols?.length !== 1 || protocols[0] !== WORKER_SUBPROTOCOL) return void fail('400 Bad Request')
    if (this.sockets.size - this.connected.size >= this.config.rateLimits.maxUnauthenticated) return void fail('503 Service Unavailable')
    server.handleUpgrade(req, sock, head, ws => this.open(ws, id.data, ip, parseCapabilityHeader(req.headers[CAPABILITY_HEADER])))
  }
  private buckets(config: GatewayConfig) {
    const { framesPerSecond, bytesPerSecond } = config.rateLimits
    return { frames: new TokenBucket(framesPerSecond, framesPerSecond, this.ctx.clock),
      bytes: new TokenBucket(bytesPerSecond, bytesPerSecond, this.ctx.clock) }
  }
  private open(ws: WebSocket, workerId: string, ip: string, offered: string[] | undefined) {
    const now = this.ctx.clock.now()
    const conn: Connection = { ws, workerId, ip, offered, capabilities: [], nonce: randomBytes(32).toString('base64url'), openedAt: now, lastFrame: now,
      pingAt: now, rtt: null, hello: undefined, epoch: 0, welcomed: false, heartbeat: undefined, queuedBytes: 0,
      processing: Promise.resolve(), ...this.buckets(this.config), acks: new Map(), withheld: new Set(), lastAck: now,
      stale: new Lru(1024, Infinity, this.ctx.clock), resends: new Lru(1024, 2000, this.ctx.clock) }
    this.sockets.add(conn)
    ws.on('error', () => ws.terminate())
    ws.on('close', code => {
      void guardAsync(this.ctx, Promise.resolve().then(() => this.closed(conn, String(code))), 'worker socket close')
    })
    ws.on('pong', () => { conn.rtt = this.ctx.clock.now() - conn.pingAt })
    ws.on('message', (data, binary) => this.message(conn, data, binary))
    this.emitFrame(conn, { type: 'hub.challenge', payload: { nonce: conn.nonce, hubBootId: this.bootId, serverTime: now, protocolVersions: [1] } })
  }
  private message(conn: Connection, data: RawData, binary: boolean) {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (binary || (!conn.hello && raw.length > 16 * 1024)) return conn.ws.close(4400, 'bad frame')
    if (conn.hello && (!conn.frames.take() || !conn.bytes.take(Math.max(1, raw.length)) || conn.queuedBytes + raw.length > 8 << 20)) {
      this.emitFrame(conn, { type: 'hub.reject', payload: { code: 'RATE_LIMITED', message: 'rate limited', retryAfterMs: 2000 } })
      return conn.ws.close(4429, 'rate limited')
    }
    let json: unknown
    try { json = JSON.parse(raw.toString()) } catch { return conn.ws.close(4400, 'bad frame') }
    if (!conn.hello && typeof json === 'object' && json && 'v' in json && json.v !== 1) {
      return this.reject(conn, 4426, 'UNSUPPORTED_VERSION')
    }
    const env = Envelope.safeParse(json)
    if (!env.success) { this.badFrames++; return conn.ws.close(4400, 'bad frame') }
    if (conn.hello && !knownWorkerFrameTypes.has(env.data.type)) {
      conn.lastFrame = this.ctx.clock.now()
      this.ctx.logger('workers').warn('Ignoring unknown worker frame type %s from %s', env.data.type, conn.workerId)
      return
    }
    const frame = WorkerToHubFrame.safeParse(json)
    if (!frame.success) { this.badFrames++; return conn.ws.close(4400, 'bad frame') }
    if (!conn.hello) {
      if (frame.data.type !== 'worker.hello') return conn.ws.close(4400, 'hello required')
      this.authenticate(conn, frame.data.payload)
      return
    }
    if (frame.data.type === 'worker.hello') return conn.ws.close(4400, 'unexpected hello')
    conn.lastFrame = this.ctx.clock.now()
    conn.queuedBytes += raw.length
    conn.processing = conn.processing.then(async () => {
      if (!conn.welcomed || this.connected.get(conn.workerId) !== conn || conn.ws.readyState !== WebSocket.OPEN) return
      await this.receive(conn, frame.data)
    }).catch(() => { conn.ws.close(4500, 'worker frame rejected') }).finally(() => { conn.queuedBytes -= raw.length })
  }
  private reject(conn: Connection, close: number, code: 'AUTH_FAILED' | 'WORKER_REVOKED' | 'UNSUPPORTED_VERSION') {
    this.emitFrame(conn, { type: 'hub.reject', payload: { code, message: code } })
    conn.ws.close(close, code)
  }
  private recordFailure(conn: Connection) {
    const now = this.ctx.clock.now()
    const add = (cache: Lru<string, Failure>, key: string, window: number, limit: number, cooldown: number) => {
      const times = [...(cache.get(key)?.times ?? []).filter(at => now - at < window), now].slice(-limit)
      cache.set(key, { times, blockedUntil: times.length >= limit ? now + cooldown : 0 })
    }
    add(this.ipFailures, conn.ip, 900_000, 5, 1_800_000)
    add(this.idFailures, conn.workerId, 3_600_000, 10, 900_000)
  }
  private authenticate(conn: Connection, hello: WorkerHello) {
    const worker = this.row(conn.workerId)
    if (worker?.status === 'revoked') return this.reject(conn, 4403, 'WORKER_REVOKED')
    const nonce = conn.nonce
    conn.nonce = ''
    let valid = false
    if (worker && nonce && hello.auth.workerId === worker.id) {
      try {
        const actual = Buffer.from(hello.auth.keyFingerprint), expected = Buffer.from(worker.keyFingerprint)
        const key = createPublicKey({ key: Buffer.from(worker.publicKey, 'base64'), type: 'spki', format: 'der' })
        const signed = Buffer.from(['agent-hub/worker-auth/v1', worker.id, nonce, hello.auth.clientNonce, this.bootId].join('\n'))
        valid = actual.length === expected.length && timingSafeEqual(actual, expected) &&
          verify(null, signed, key, Buffer.from(hello.auth.signature, 'base64url'))
      } catch { valid = false }
    }
    if (!worker || !valid) { this.recordFailure(conn); return this.reject(conn, 4401, 'AUTH_FAILED') }
    conn.capabilities = negotiateCapabilities(conn.offered ?? [], this.config.capabilities)
    conn.hello = hello
    const now = this.ctx.clock.now()
    conn.epoch = worker.connectionEpoch + 1
    this.ctx.store.tx(db => db.update(workers).set({ protocolCapsJson: conn.offered === undefined ? null : conn.capabilities, connectionEpoch: conn.epoch, hostname: hello.agent.hostname,
      os: hello.agent.os, arch: hello.agent.arch, agentVersion: hello.agent.version, lastIp: conn.ip,
      maxConcurrency: hello.maxConcurrency, capabilitiesJson: hello.adapters, workspacesJson: hello.workspaces,
      ...((worker.drainSource !== 'hub') && { drain: hello.drain, drainSource: hello.drain ? 'worker' : null }),
      lastSeenAt: now, connectedAt: now, updatedAt: now, connection: 'offline',
    }).where(eq(workers.id, worker.id)).run())
    const previous = this.connected.get(worker.id)
    this.connected.set(worker.id, conn)
    this.outboxes.get(worker.id)?.disconnected()
    previous?.ws.close(4409, 'superseded')
    this.startWelcome(conn)
  }
  private startWelcome(conn: Connection) {
    const handler = this.inbound
    if (!handler || !conn.hello || conn.welcomed) return
    const hello = conn.hello
    conn.processing = conn.processing.then(async () => {
      if (conn.welcomed || this.connected.get(conn.workerId) !== conn || handler !== this.inbound) return
      const resume = await handler.reconcile(conn.workerId, hello)
      if (conn.ws.readyState !== WebSocket.OPEN || this.connected.get(conn.workerId) !== conn || handler !== this.inbound) return
      const now = this.ctx.clock.now()
      const worker = this.row(conn.workerId)!
      this.emitFrame(conn, { type: 'hub.welcome', payload: { sessionId: ulid(now), connectionEpoch: conn.epoch, serverTime: now,
        ...(conn.offered !== undefined && { capabilities: conn.capabilities }),
        heartbeatIntervalMs: this.config.heartbeatIntervalMs, heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
        ackIntervalMs: this.config.ackIntervalMs, maxFrameBytes: this.config.maxFrameBytes, maxInFlightBytes: this.config.maxInFlightBytes,
        maxLogEntryBytes: 16 * 1024, resume, drain: worker.drainSource === 'hub' && worker.drain,
        redactionPatterns: this.config.redactionPatterns } })
      conn.welcomed = true
      conn.lastFrame = now
      this.update(conn.workerId, { connection: 'online', lastSeenAt: now, connectedAt: now })
      this.ctx.emit('worker/connected', conn.workerId, conn.epoch)
      this.pump(conn, true)
    }).catch(() => { conn.ws.close(4500, 'reconciliation failed') })
  }
  private async receive(conn: Connection, frame: WorkerToHubFrame) {
    const handler = this.inbound
    switch (frame.type) {
      case 'run.events':
      case 'run.gap': {
        const runId = frame.payload.runId
        const hold = () => {
          if (conn.withheld.size < 128) conn.withheld.add(runId)
        }
        if (!handler) { hold(); return }
        const result = await this.inbox.receive(conn.workerId, frame.payload, handler)
        if (this.connected.get(conn.workerId) !== conn) return
        if (handler !== this.inbound) { hold(); return }
        if (result.fromSeq !== undefined && conn.resends.get(runId) !== result.fromSeq) {
          conn.resends.set(runId, result.fromSeq)
          this.emitFrame(conn, { type: 'run.resend', payload: { runId, fromSeq: result.fromSeq } })
        }
        if (result.stale && !conn.stale.has(runId)) {
          conn.stale.set(runId, true)
          const ts = this.ctx.clock.now()
          void guardAsync(this.ctx, this.send(conn.workerId, { v: 1, id: ulid(ts), ts, type: 'run.cancel',
            payload: { runId, reason: 'stale_run', force: true, graceMs: 0 } }), 'stale run cancellation')
        }
        if ('ackSeq' in result && result.ackSeq !== undefined) {
          conn.acks.set(frame.payload.runId, result.ackSeq)
          if (conn.acks.size >= 64) this.ack(conn)
        }
        break
      }
      case 'cmd.ack': {
        if (!handler) return
        const command = this.outboxes.get(conn.workerId)?.ack(frame.payload)
        if (command) handler.onCommandAck(conn.workerId, command, frame.payload)
        break
      }
      case 'worker.heartbeat': {
        conn.heartbeat = frame.payload
        const row = this.row(conn.workerId)!
        const adapters = (row.capabilitiesJson as WorkerView['adapters'] | null ?? []).map(adapter => ({
          ...adapter, status: frame.payload.adapters[adapter.id] ?? adapter.status,
        }))
        const projects = frame.payload.projects
        const workspaces = projects && (row.workspacesJson as WorkerView['workspaces'] | null ?? []).map(ws => ({ ...ws, projects: projects[ws.id] ?? [] }))
        this.update(conn.workerId, { lastSeenAt: conn.lastFrame, connection: 'online', capabilitiesJson: adapters, ...(workspaces && { workspacesJson: workspaces }) })
        const quotas = frame.payload.quotas
        if (quotas) this.ctx.store.tx(db => {
          db.prepare('DELETE FROM adapter_quota WHERE worker_id = ?').run(conn.workerId)
          const insert = db.prepare('INSERT INTO adapter_quota (worker_id, adapter, quota_json, updated_at) VALUES (?, ?, ?, ?)')
          for (const quota of quotas) insert.run(conn.workerId, quota.adapter, JSON.stringify(quota), conn.lastFrame)
        })
        this.emitFrame(conn, { type: 'hub.heartbeat_ack', payload: { serverTime: this.ctx.clock.now() } })
        break
      }
      case 'worker.state': {
        const row = this.row(conn.workerId)
        if (row?.drainSource !== 'hub') this.update(conn.workerId, { drain: frame.payload.drain, drainSource: frame.payload.drain ? 'worker' : null })
        break
      }
      case 'worker.bye': conn.ws.close(1000, 'worker bye'); break
    }
  }
  private ack(conn: Connection) {
    if (!conn.acks.size || !this.inbound) return
    this.emitFrame(conn, { type: 'run.ack', payload: { acks: [...conn.acks].map(([runId, ackSeq]) => ({ runId, ackSeq })) } })
    conn.acks.clear()
    conn.lastAck = this.ctx.clock.now()
  }
  private sweep() {
    const now = this.ctx.clock.now()
    for (const conn of this.sockets) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue
      if (!conn.hello) {
        if (now - conn.openedAt >= this.config.handshakeTimeoutMs) conn.ws.close(4408, 'handshake timeout')
        continue
      }
      if (!conn.welcomed) continue
      if (now - conn.lastFrame >= this.config.heartbeatTimeoutMs * 1.5) { conn.ws.close(4408, 'heartbeat timeout'); continue }
      if (now - conn.lastFrame >= this.config.heartbeatTimeoutMs && this.row(conn.workerId)?.connection === 'online') {
        this.update(conn.workerId, { connection: 'suspect' })
      }
      if (now - conn.pingAt >= 15_000) { conn.pingAt = now; conn.ws.ping() }
      if (now - conn.lastAck >= this.config.ackIntervalMs) this.ack(conn)
      this.pump(conn)
    }
  }
  private closed(conn: Connection, reason: string) {
    this.sockets.delete(conn)
    if (this.connected.get(conn.workerId) !== conn) return
    this.connected.delete(conn.workerId)
    if (this.stopping) return
    this.outboxes.get(conn.workerId)?.disconnected()
    const now = this.ctx.clock.now()
    this.update(conn.workerId, { connection: 'offline', disconnectedAt: now })
    if (reason !== '4403') this.inbound?.onWorkerOffline(conn.workerId, now)
    this.ctx.emit('worker/disconnected', conn.workerId, reason)
  }
  private emitFrame(conn: Connection, frame: Payload<HubToWorkerFrame>) {
    if (conn.ws.readyState !== WebSocket.OPEN) return
    const ts = this.ctx.clock.now()
    conn.ws.send(JSON.stringify({ v: 1, id: ulid(ts), ts, ...frame }))
  }
  private row(id: string) { return this.ctx.store.repos.workers.get(id) }
  private update(id: string, patch: Partial<WorkerRow>, actor?: Actor, action?: string) {
    const previous = this.get(id)
    this.ctx.store.tx(db => {
      db.update(workers).set({ ...patch, updatedAt: this.ctx.clock.now() }).where(eq(workers.id, id)).run()
      if (actor && action) db.insert(auditLogs).values({ ts: this.ctx.clock.now(), actorType: actor.type,
        actorId: actor.id, channel: actor.channel, action, targetType: 'worker', targetId: id }).run()
    })
    const next = this.get(id)
    if (next) this.ctx.emit('worker/updated', next, previous ?? null)
  }
  private view(row: WorkerRow): WorkerView {
    const conn = this.connected.get(row.id)
    const hb = conn?.heartbeat
    const active = this.ctx.store.repos.select({ id: taskRuns.id }).from(taskRuns)
      .where(and(eq(taskRuns.workerId, row.id), inArray(taskRuns.status, activeRunStatuses))).all().map(run => run.id)
    return { id: row.id, displayName: row.displayName, status: row.status, drain: row.drain, drainSource: row.drainSource,
      connection: row.connection, hostname: row.hostname, os: row.os, arch: row.arch, agentVersion: row.agentVersion,
      maxConcurrency: row.maxConcurrency, slotsUsed: Math.max(active.length, hb?.slotsUsed ?? 0), rttMs: conn?.rtt ?? null,
      load: hb?.load ?? null, adapters: row.capabilitiesJson as WorkerView['adapters'] | null ?? [],
      workspaces: row.workspacesJson as WorkerView['workspaces'] | null ?? [], activeRunIds: active,
      graceUntil: row.connection === 'offline' && row.disconnectedAt !== null && active.length ?
        Math.max(row.disconnectedAt, this.startedAt) + this.gracePeriodMs : null,
      bufferedBytes: hb?.bufferedBytes ?? 0, droppedLogBytesTotal: hb?.droppedLogBytesTotal ?? 0,
      ...(row.protocolCapsJson && { protocolCapabilities: row.protocolCapsJson }),
      connectedAt: row.connectedAt, lastSeenAt: row.lastSeenAt }
  }
  metrics() { return { workerConnections: this.connected.size, workerBadFrames: this.badFrames } }
  list() { return this.ctx.store.repos.workers.list().map(row => this.view(row)) }
  get(id: string) { const row = this.row(id); return row && this.view(row) }
  capabilities(id: string) {
    const conn = this.connected.get(id)
    return conn?.welcomed && conn.ws.readyState === WebSocket.OPEN && this.isOnline(id) ? conn.capabilities : []
  }
  isOnline(id: string) { return this.row(id)?.connection === 'online' }
  send(id: string, command: HubCommand) {
    let outbox = this.outboxes.get(id)
    if (!outbox) { outbox = new CommandOutbox(); this.outboxes.set(id, outbox) }
    const result = outbox.enqueue(command)
    const conn = this.connected.get(id)
    if (conn) this.pump(conn)
    return result
  }
  private pump(conn: Connection, reconnected = false) {
    if (!conn.welcomed || !this.inbound || conn.ws.readyState !== WebSocket.OPEN) return
    const outbox = this.outboxes.get(conn.workerId)
    if (!outbox) return
    if (reconnected) outbox.drop(command => {
      if (command.type === 'run.dispatch') return this.ctx.store.repos.runs.get(command.payload.runId)?.status !== 'dispatching'
      if (command.type === 'run.cancel' && command.payload.reason !== 'stale_run') {
        return this.ctx.store.repos.runs.get(command.payload.runId)?.status !== 'cancelling'
      }
      if (command.type === 'run.input') {
        return !this.ctx.store.repos.select({ id: inputRequests.id }).from(inputRequests)
          .where(and(eq(inputRequests.id, command.payload.requestId), eq(inputRequests.status, 'answered'))).get()
      }
      return false
    })
    outbox.pump((command, attempt) => {
      if (command.type === 'run.dispatch' && attempt > 1) {
        this.ctx.store.tx(db => db.update(taskRuns).set({ dispatchCount: sql`max(1, ${taskRuns.dispatchCount} + 1)` })
          .where(and(eq(taskRuns.id, command.payload.runId), eq(taskRuns.status, 'dispatching'))).run())
      }
      conn.ws.send(JSON.stringify(command))
    }, this.ctx.clock.now(), this.config.cmdAckTimeoutMs, this.config.maxResends)
  }
  async setDrain(id: string, drain: boolean, actor: Actor) {
    if (!this.row(id)) throw new HubError('WORKER_NOT_FOUND', 404)
    this.update(id, { drain, drainSource: drain ? 'hub' : null }, actor, 'worker.drain')
    const ts = this.ctx.clock.now()
    if (this.isOnline(id)) void guardAsync(this.ctx, this.send(id, { v: 1, id: ulid(ts), ts, type: 'worker.drain', payload: { drain } }), 'worker.drain')
  }
  async revoke(id: string, actor: Actor) {
    if (!this.row(id)) throw new HubError('WORKER_NOT_FOUND', 404)
    const now = this.ctx.clock.now()
    this.update(id, { status: 'revoked', revokedAt: now, connection: 'offline', disconnectedAt: now }, actor, 'worker.revoke')
    this.outboxes.get(id)?.clear()
    this.connected.get(id)?.ws.close(4403, 'revoked')
    this.inbound?.onWorkerOffline(id, now, true)
  }
  setInboundHandler(handler: WorkerInboundHandler) {
    if (this.inbound) throw new Error('Worker inbound handler already registered')
    this.inbound = handler
    for (const conn of this.connected.values()) {
      if (conn.welcomed) {
        const ids = new Set([...(this.get(conn.workerId)?.activeRunIds ?? []), ...conn.withheld])
        conn.withheld.clear()
        for (const runId of ids) {
          const run = this.ctx.store.repos.runs.get(runId)
          if (run?.workerId === conn.workerId && run.status !== 'lost' && run.status !== 'refused' &&
              !activeRunStatuses.some(status => status === run.status)) {
            conn.acks.set(runId, run.lastSeq)
            if (conn.acks.size >= 64) this.ack(conn)
          } else this.emitFrame(conn, { type: 'run.resend', payload: { runId, fromSeq: (run?.lastSeq ?? 0) + 1 } })
        }
      } else this.startWelcome(conn)
    }
    return () => { if (this.inbound === handler) this.inbound = undefined }
  }
}
