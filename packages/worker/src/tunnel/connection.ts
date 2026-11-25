import { randomBytes, sign } from 'node:crypto'
import { freemem, hostname, totalmem } from 'node:os'
import { WebSocket } from 'ws'
import type { RawData } from 'ws'
import { backoff, ulid } from '@agent-hub/common'
import type { Clock } from '@agent-hub/common'
import { FrameId, HubToWorkerFrame, MIN_WORKER_WINDOW_BYTES, WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import type { HubChallenge, HubWelcome, WorkerHeartbeat, WorkerHello, WorkerToHubFrame } from '@agent-hub/protocol'
import type { WorkerConfig } from '../config/schema.js'
import { workspaceDeclarations } from '../config/load.js'
import type { WorkerIdentity } from '../identity.js'
import type { RunManager } from '../runner/run-manager.js'
import type { AdapterRegistry } from '../adapters/registry.js'
import { ClockOffset } from './clock-offset.js'
import { Commands } from './commands.js'

type Payload<T> = T extends WorkerToHubFrame ? Pick<T, 'type' | 'payload'> : never
export interface TunnelOptions {
  onStop?: (code: number) => void
  onWarning?: (message: string) => void
  random?: () => number
}

export class WorkerTunnel {
  private ws: WebSocket | undefined
  private retryAt = 0
  private attempt = 0
  private requestedClose = false
  private configReconnect = false
  private retryAfterMs = 0
  private welcomed = false
  private challengeSeen = false
  private openedAt = 0
  private lastReceive = 0
  private lastHeartbeat = 0
  private lastFlush = 0
  private heartbeatMs = 10_000
  private heartbeatTimeoutMs = 30_000
  private lastHubBootId: string | undefined
  private readonly offset = new ClockOffset()
  private readonly commands: Commands
  private stopTick?: () => void
  constructor(private config: WorkerConfig, private readonly identity: WorkerIdentity, private readonly runs: RunManager,
    private readonly adapters: AdapterRegistry, private readonly clock: Clock, private readonly options: TunnelOptions = {}) {
    this.commands = new Commands(clock, runs, adapters, () => this.offset.toHubTime(this.clock.now()),
      ack => { this.send({ type: 'cmd.ack', payload: ack }) }, () => this.heartbeat())
  }
  get online() { return this.welcomed }
  start() {
    if (this.stopTick) return
    this.stopTick = this.clock.setInterval(() => this.tick(), 100)
    this.connect()
  }
  update(config: WorkerConfig) {
    this.config = config
    this.reconnect()
  }
  reconnect() {
    this.configReconnect = true
    this.ws?.close(1001, 'reconnect')
  }
  private connect() {
    if (this.ws || this.requestedClose) return
    const now = this.clock.monotonic()
    this.openedAt = now
    this.challengeSeen = false
    this.retryAfterMs = 0
    this.offset.reset()
    const ws = new WebSocket(this.config.hub.url, WORKER_SUBPROTOCOL, {
      headers: { 'X-Worker-Id': this.config.workerId, ...(this.config.harness.enabled && { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' }) }, maxPayload: 1 << 20, perMessageDeflate: false, handshakeTimeout: 5000,
    })
    this.ws = ws
    ws.on('error', () => { /* close owns reconnection */ })
    ws.on('unexpected-response', (_req, response) => {
      const retryAfter = Number(response.headers['retry-after'])
      if (response.statusCode === 429) this.retryAfterMs = retryAfter > 0 ? retryAfter * 1000 : 60_000
      response.resume()
      ws.terminate()
    })
    ws.on('close', code => this.closed(ws, code))
    ws.on('message', (raw, binary) => {
      if (this.ws !== ws) return
      try { this.receive(ws, raw, binary) }
      catch { ws.close(4400, 'bad frame') }
    })
  }
  private tick() {
    const now = this.clock.monotonic()
    if (!this.ws && now >= this.retryAt) this.connect()
    if (this.ws && !this.welcomed && now - this.openedAt >= 5000) this.ws.terminate()
    if (!this.welcomed) return
    if (now - this.lastReceive >= this.heartbeatTimeoutMs * 1.5) { this.ws?.close(4408, 'heartbeat timeout'); return }
    if (now - this.lastHeartbeat >= this.heartbeatMs) this.heartbeat()
    if (now - this.lastFlush >= this.config.tunnel.flushIntervalMs) { this.lastFlush = now; this.runs.outbox.flush() }
  }
  private receive(ws: WebSocket, raw: RawData, binary: boolean) {
    if (binary) { ws.close(4400, 'binary frame'); return }
    const data = JSON.parse((Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString()) as unknown
    const frame = HubToWorkerFrame.safeParse(data)
    if (!frame.success) {
      if (this.welcomed && data && typeof data === 'object' && 'type' in data && typeof data.type === 'string' &&
        ['run.dispatch', 'run.cancel', 'run.input', 'worker.drain', 'worker.probe'].includes(data.type) &&
        'id' in data && FrameId.safeParse(data.id).success) {
        this.send({ type: 'cmd.ack', payload: { refId: data.id as string, ok: false, error: { code: 'INVALID', message: 'Invalid command' } } })
        return
      }
      ws.close(4400, 'bad frame')
      return
    }
    this.lastReceive = this.clock.monotonic()
    switch (frame.data.type) {
      case 'hub.challenge':
        if (this.challengeSeen || this.welcomed) ws.close(4400, 'unexpected challenge')
        else this.hello(frame.data.payload)
        break
      case 'hub.welcome':
        if (!this.challengeSeen || this.welcomed) ws.close(4400, 'unexpected welcome')
        else this.welcome(frame.data.payload)
        break
      case 'hub.reject':
        this.retryAfterMs = frame.data.payload.retryAfterMs ?? 0
        break
      case 'hub.heartbeat_ack':
        if (this.welcomed) {
          const now = this.clock.now()
          this.offset.observe(frame.data.payload.serverTime, now, now - (this.clock.monotonic() - this.lastHeartbeat))
        }
        break
      case 'run.ack':
        if (!this.welcomed) { ws.close(4400, 'welcome required'); break }
        for (const ack of frame.data.payload.acks) this.runs.outbox.ack(ack.runId, ack.ackSeq)
        this.runs.outbox.flush()
        break
      case 'run.resend':
        if (!this.welcomed) { ws.close(4400, 'welcome required'); break }
        this.runs.outbox.resend(frame.data.payload.runId, frame.data.payload.fromSeq)
        break
      default:
        if (this.welcomed) this.commands.handle(frame.data)
        else ws.close(4400, 'welcome required')
    }
  }
  private hello(challenge: HubChallenge) {
    if (!challenge.protocolVersions.includes(1)) { this.ws?.close(4426, 'unsupported version'); return }
    this.challengeSeen = true
    this.offset.observe(challenge.serverTime, this.clock.now())
    const clientNonce = randomBytes(16).toString('base64url')
    const signed = Buffer.from(['agent-hub/worker-auth/v1', this.config.workerId, challenge.nonce, clientNonce, challenge.hubBootId].join('\n'))
    const agent: WorkerHello['agent'] = { version: '0.1.0', hostname: hostname(), os: process.platform as WorkerHello['agent']['os'],
      arch: process.arch, nodeVersion: process.version, pid: process.pid }
    this.send({ type: 'worker.hello', payload: { auth: { workerId: this.config.workerId, clientNonce, keyFingerprint: this.identity.fingerprint,
      signature: sign(null, signed, this.identity.privateKey).toString('base64url') }, agent, maxConcurrency: this.config.maxConcurrency,
      adapters: this.adapters.capabilities(), workspaces: workspaceDeclarations(this.config), runs: this.runs.report(),
      drain: this.runs.localDrain, ...(this.lastHubBootId && { lastHubBootId: this.lastHubBootId }),
    } })
    this.lastHubBootId = challenge.hubBootId
  }
  private welcome(welcome: HubWelcome) {
    if (Math.min(welcome.maxFrameBytes, welcome.maxInFlightBytes) < MIN_WORKER_WINDOW_BYTES) {
      this.options.onWarning?.('Legacy Hub window below 64 KiB; verification details may be shortened')
    }
    this.offset.observe(welcome.serverTime, this.clock.now())
    this.welcomed = true
    this.attempt = 0
    this.heartbeatMs = welcome.heartbeatIntervalMs
    this.heartbeatTimeoutMs = welcome.heartbeatTimeoutMs
    this.runs.hubDrain = welcome.drain
    this.runs.maxLogEntryBytes = welcome.maxLogEntryBytes
    this.runs.setRedactionPatterns(welcome.redactionPatterns)
    for (const directive of welcome.resume) {
      if (directive.action !== 'resume') this.runs.discard(directive.runId, directive.action === 'cancel')
      else this.runs.outbox.ack(directive.runId, directive.ackSeq)
    }
    this.runs.outbox.attach(frame => {
      if ((this.ws?.bufferedAmount ?? Infinity) > 8 << 20) return false
      if (frame.type === 'run.events') this.runs.checkpoint(frame.payload.runId, frame.payload.events.at(-1)!.seq)
      return this.send(frame)
    }, welcome.maxFrameBytes, welcome.maxInFlightBytes, welcome.capabilities ?? [])
    this.runs.outbox.flush()
    this.heartbeat()
  }
  private heartbeat() {
    if (!this.welcomed) return
    this.lastHeartbeat = this.clock.monotonic()
    const adapters: WorkerHeartbeat['adapters'] = Object.fromEntries(this.adapters.capabilities().map(item => [item.id, item.status]))
    this.send({ type: 'worker.heartbeat', payload: { activeRuns: this.runs.report().filter(run => run.state !== 'finished')
      .map(({ runId, state, lastSeq }) => ({ runId, state, lastSeq })), slotsUsed: this.runs.slotsUsed,
    load: { memFreeMb: Math.floor(freemem() / 1048576), memTotalMb: Math.floor(totalmem() / 1048576) },
    bufferedBytes: this.runs.outbox.bufferedBytes, droppedLogBytesTotal: this.runs.outbox.droppedLogBytesTotal, adapters } })
  }
  private send(frame: Payload<WorkerToHubFrame>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    const ts = this.clock.now()
    this.ws.send(JSON.stringify({ ...frame, ts, id: ulid(ts), v: 1 }))
    return true
  }
  state(drain: boolean, reason: string) { this.send({ type: 'worker.state', payload: { drain, reason } }) }
  async stop() {
    this.requestedClose = true
    this.stopTick?.()
    this.send({ type: 'worker.bye', payload: { reason: 'shutdown', runningRuns: this.runs.activeIds() } })
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => ws.terminate(), 1000)
      ws.once('close', () => { clearTimeout(timer); resolve() })
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      else ws.close(1000, 'shutdown')
    })
  }
  private closed(ws: WebSocket, code: number) {
    if (this.ws !== ws) return
    this.ws = undefined
    this.welcomed = false
    this.runs.outbox.detach()
    if (this.requestedClose) return
    if (code === 1000 || code === 4403 || code === 4426) {
      this.requestedClose = true
      this.stopTick?.()
      if (code !== 1000) this.options.onWarning?.(code === 4403 ? 'Worker identity revoked' : 'Worker protocol upgrade required')
      this.options.onStop?.(code === 1000 ? 0 : 1)
      return
    }
    if (code === 4401 || code === 4409 || code === 1009) this.options.onWarning?.(
      code === 4401 ? 'Worker authentication failed. Enroll again.' : code === 4409 ? 'Worker identity superseded' : 'Worker frame exceeds negotiated limit')
    const random = this.options.random ?? Math.random
    const delay = this.configReconnect ? 0 : code === 4401 || code === 4409 ? 300_000 :
      code === 4503 ? Math.floor(2000 + random() * 3000) : this.retryAfterMs || (code === 4429 ? 60_000 :
        backoff(this.attempt++, { random }))
    this.configReconnect = false
    this.retryAt = this.clock.monotonic() + delay
  }
}
