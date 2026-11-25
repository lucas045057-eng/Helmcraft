import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { inArray } from 'drizzle-orm'
import type { Context } from 'cordis'
import { WebSocket, WebSocketServer } from 'ws'
import { DASHBOARD_SUBPROTOCOL, DashboardCloseCode, DashClientFrame, TaskSummary } from '@agent-hub/protocol'
import type { DashEventFrame, DashServerFrame, Overview, TaskView, Topic } from '@agent-hub/protocol'
import { guardAsync, safeOn } from '../../kernel/safe.js'
import { activeRunStatuses } from '../../services/workers.js'
import { sha256 } from '../auth/index.js'
import { taskView } from '../orchestrator/views.js'
import { tasks } from '../store-sqlite/schema.js'
import { LogFollows } from './log-follow.js'

const capacity = 10_000
const queueLimit = 2 << 20
const socketLimit = 4 << 20
const codes = DashboardCloseCode
type EventInput<T = DashEventFrame> = T extends DashEventFrame ? Omit<T, 't' | 'eventSeq'> : never
type Queued = { text: string; bytes: number; overview: boolean; done: (sent: boolean) => void }
type Credential = { hash: string; verify: () => boolean }

class DashboardSocket {
  readonly topics = new Set<Topic>()
  readonly follows: LogFollows
  readonly deferredTopics = new Set<Topic>()
  hello = false
  replaying = false
  resumeAfter: number | undefined
  lastFrame: number
  lastPing: number
  pressureAt: number | undefined
  private lostEvents = false
  private queue: Queued[] = []
  private queuedBytes = 0
  private closing = false

  constructor(private ctx: Context, readonly ws: WebSocket, readonly credential: Credential) {
    this.lastFrame = this.lastPing = ctx.clock.monotonic()
    this.follows = new LogFollows(ctx, frame => this.send(frame), () => this.checkPressure())
  }

  send(frame: DashServerFrame): Promise<boolean> {
    if (this.ws.readyState !== WebSocket.OPEN || this.closing) return Promise.resolve(false)
    const text = JSON.stringify(frame)
    if (frame.t === 'logs.reset' || frame.t === 'resync' || (frame.t === 'event' && frame.type === 'system.status' &&
        frame.data.draining)) {
      this.ws.send(text, () => {})
      return Promise.resolve(true)
    }
    const bytes = Buffer.byteLength(text)
    if (frame.t === 'logs' && this.checkPressure(this.queuedBytes + bytes + this.follows.bytes)) return Promise.resolve(false)
    const overview = frame.t === 'event' && frame.type === 'overview.updated'
    return new Promise(resolve => {
      const entry = { text, bytes, overview, done: resolve }
      if (!this.queue.length && this.ws.bufferedAmount <= socketLimit) {
        this.write(entry)
      } else {
        if (overview) {
          const prior = this.queue.findIndex(item => item.overview)
          if (prior >= 0) {
            const [replaced] = this.queue.splice(prior, 1)
            this.queuedBytes -= replaced!.bytes
            replaced!.done(false)
          }
        }
        if (this.queuedBytes + bytes > queueLimit) {
          this.lostEvents = true
          this.checkPressure(this.queuedBytes + bytes)
          resolve(false)
          return
        }
        this.queue.push(entry)
        this.queuedBytes += bytes
      }
      this.checkPressure()
    })
  }

  private write(item: Queued) {
    this.ws.send(item.text, error => {
      item.done(!error)
      if (error) this.close(codes.TIMEOUT, 'send_failed')
      else this.pump()
    })
  }

  private pump() {
    if (this.closing || this.ws.readyState !== WebSocket.OPEN) return
    while (this.queue.length && this.ws.bufferedAmount <= socketLimit) {
      const item = this.queue.shift()!
      this.queuedBytes -= item.bytes
      this.write(item)
    }
    this.checkPressure()
  }

  checkPressure(queuedBytes = this.queuedBytes + this.follows.bytes): boolean {
    if (this.closing) return true
    const now = this.ctx.clock.monotonic()
    if (this.ws.bufferedAmount > socketLimit || queuedBytes > queueLimit) {
      if (this.pressureAt === undefined) {
        this.pressureAt = now
        this.follows.reset('slow_consumer')
      } else if (now - this.pressureAt >= 10_000) this.resync()
      return true
    }
    if (this.pressureAt !== undefined) {
      this.pressureAt = undefined
      if (this.lostEvents) this.resync()
    }
    return this.closing
  }

  private resync() {
    void this.send({ t: 'resync', reason: 'slow_consumer' })
    this.close(codes.TIMEOUT, 'slow_consumer')
  }

  close(code: number, reason: string) {
    this.dispose()
    this.ws.close(code, reason)
  }

  dispose() {
    this.closing = true
    this.follows.reset()
    for (const item of this.queue) item.done(false)
    this.queue = []
    this.queuedBytes = 0
  }

  heartbeat(now: number) {
    if (this.closing || this.ws.readyState !== WebSocket.OPEN) return
    this.checkPressure()
    if (this.closing) return
    if (now - this.lastFrame >= 60_000) this.close(codes.TIMEOUT, 'heartbeat_timeout')
    else if (now - this.lastPing >= 30_000) {
      if (!this.credential.verify()) return this.close(codes.SESSION_EXPIRED, 'session_expired')
      this.lastPing = now
      this.ws.ping()
    }
  }
}

// Preserve the sequence through Cordis dependency restarts within this process.
let processSeq = 0

export function installDashboardWs(ctx: Context, overview: () => Overview) {
  const { clock, http, auth, orchestrator, workers, store } = ctx
  const bootId = workers.bootId
  const sockets = new Set<DashboardSocket>()
  const counts = new Map<string, number>()
  const ring = new Array<DashEventFrame | undefined>(capacity)
  const startSeq = processSeq
  let eventSeq = processSeq
  let overviewDue = Infinity
  let lastOverview = -Infinity
  let stopped = false
  const pendingTasks = new Map<string, number>()
  const progress = new Map<string, { value: string | null; at: number; due: number }>()

  const options = { noServer: true, clientTracking: false, maxPayload: 16 << 10, closeTimeout: 3000,
    handleProtocols: () => DASHBOARD_SUBPROTOCOL }
  const server = new WebSocketServer(options)
  function publish(event: EventInput) {
    if (stopped) return
    const frame = { ...event, t: 'event', eventSeq: ++processSeq } as DashEventFrame
    eventSeq = frame.eventSeq
    ring[eventSeq % capacity] = frame
    for (const conn of sockets) if (!conn.replaying && conn.topics.has(frame.topic)) void conn.send(frame)
  }
  const resumable = (seq: number) => seq >= Math.max(startSeq, eventSeq - capacity) && seq <= eventSeq
  const markOverview = () => { overviewDue = Math.max(clock.monotonic(), lastOverview + 1000) }
  function summary(task: TaskView) {
    const now = clock.monotonic()
    const last = progress.get(task.id)
    if (last && task.lastProgress !== last.value && now - last.at < 2000) {
      last.due = last.at + 2000
      return { ...task, lastProgress: last.value }
    }
    if (task.lastProgress !== null || last) progress.set(task.id, { value: task.lastProgress, at: last?.value === task.lastProgress ? last.at : now, due: Infinity })
    return task
  }
  function publishTask(task: TaskView, type: 'task.updated' | 'task.created') {
    const data = TaskSummary.parse(summary(task))
    publish({ topic: 'tasks', type, data })
    publish({ topic: 'task:' + task.id, type, data })
  }
  function publishDetail(id: string) {
    const data = orchestrator.getTask(id)
    if (data) publish({ topic: 'task:' + id, type: 'task.detail', data: { ...data, lastProgress: progress.has(id) ? progress.get(id)!.value : data.lastProgress } })
  }
  function snapshot(conn: DashboardSocket, added: Topic[], full: boolean) {
    if (full || added.some(topic => !topic.startsWith('task:'))) {
      const db = store.repos
      const activeTasks = db.select().from(tasks).where(inArray(tasks.status, ['awaiting_approval', 'queued', ...activeRunStatuses])).all()
        .map(task => {
          const run = db.runs.forTask(task.id)[0]
          return taskView(db, task, run && workers.get(run.workerId), undefined, run)
        })
      void conn.send({ t: 'snapshot', eventSeq, overview: overview(), workers: workers.list(), activeTasks })
    }
    for (const topic of added) if (topic.startsWith('task:')) publishDetail(topic.slice(5))
  }
  async function replay(conn: DashboardSocket, after: number) {
    conn.replaying = true
    let emitted = 0
    try {
      for (let seq = after + 1; seq <= eventSeq; seq++) {
        if (conn.ws.readyState !== WebSocket.OPEN) return
        const frame = ring[seq % capacity]
        if (frame?.eventSeq !== seq) {
          conn.replaying = false
          void conn.send({ t: 'resync', reason: 'gap_too_large' })
          snapshot(conn, [...conn.topics], true)
          return
        }
        if (!conn.topics.has(frame.topic)) continue
        const writing = conn.send(frame)
        if (++emitted % 32 === 0) await writing
      }
    } finally {
      conn.replaying = false
      const deferred = [...conn.deferredTopics]
      conn.deferredTopics.clear()
      if (deferred.length && conn.ws.readyState === WebSocket.OPEN) subscribe(conn, deferred)
    }
  }
  function subscribe(conn: DashboardSocket, topics: Topic[]) {
    const added = [...new Set(topics)].filter(topic => !conn.topics.has(topic) && !conn.deferredTopics.has(topic))
    if (!added.length) return
    if (added.length + conn.topics.size + conn.deferredTopics.size > 32) {
      void conn.send({ t: 'error', code: 'RATE_LIMITED', message: '每条连接最多订阅 32 个主题' })
      return
    }
    if (conn.replaying) {
      for (const topic of added) conn.deferredTopics.add(topic)
      return
    }
    // Register topics and read the snapshot in the same turn.
    for (const topic of added) conn.topics.add(topic)
    const after = conn.resumeAfter
    conn.resumeAfter = undefined
    if (after !== undefined && resumable(after)) {
      void guardAsync(ctx, replay(conn, after), 'dashboard replay')
      return
    }
    if (after !== undefined) void conn.send({ t: 'resync', reason: 'gap_too_large' })
    snapshot(conn, added, after !== undefined)
  }
  function receive(conn: DashboardSocket, input: unknown) {
    const parsed = DashClientFrame.safeParse(input)
    if (!parsed.success || (!conn.hello && parsed.data.t !== 'hello')) {
      void conn.send({ t: 'error', code: 'VALIDATION_FAILED', message: '无效的面板消息' })
      return
    }
    if (!conn.credential.verify()) return conn.close(codes.SESSION_EXPIRED, 'session_expired')
    const frame = parsed.data
    switch (frame.t) {
      case 'hello': {
        if (conn.hello) return
        conn.hello = true
        const resumed = frame.resume?.bootId === bootId && resumable(frame.resume.eventSeq)
        conn.resumeAfter = resumed ? frame.resume?.eventSeq : undefined
        void conn.send({ t: 'welcome', bootId, eventSeq, serverTime: clock.now(), resumed })
        break
      }
      case 'subscribe': subscribe(conn, frame.topics); break
      case 'unsubscribe':
        for (const topic of frame.topics) { conn.topics.delete(topic); conn.deferredTopics.delete(topic) }
        break
      case 'follow': conn.follows.follow(frame.runId, frame.fromSeq); break
      case 'unfollow': conn.follows.unfollow(frame.runId); break
      case 'ping': void conn.send({ t: 'pong', n: frame.n, serverTime: clock.now() }); break
    }
  }
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const authorization = req.headers.authorization
    const secret = authorization ? /^Bearer (\S+)$/.exec(authorization)?.[1] : req.headers.cookie?.split(';')
      .map(value => value.trim()).find(value => value.startsWith('ah_sid='))?.slice(7)
    const principal = () => authorization ? auth.verifyApiToken(secret, false) : auth.verifySession(secret, false)?.principal
    const reject = (status: string) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    const granted = principal()
    if (!secret || !granted) return reject('401 Unauthorized')
    const protocols = req.headers['sec-websocket-protocol']
    if (!granted.scopes.some(scope => scope === 'read' || scope === 'operate' || scope === 'admin') ||
      !auth.originAllowed(req.headers.origin) || typeof protocols !== 'string' ||
      !protocols.split(',').some(value => value.trim() === DASHBOARD_SUBPROTOCOL)) return reject('403 Forbidden')
    const credential: Credential = { hash: sha256(secret), verify: () => Boolean(principal()) }
    server.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => ws.terminate())
      const count = counts.get(credential.hash) ?? 0
      if (count >= 5) { ws.close(codes.RATE_LIMITED, 'connection_limit'); return }
      const conn = new DashboardSocket(ctx, ws, credential)
      sockets.add(conn)
      counts.set(credential.hash, count + 1)
      ws.on('close', () => {
        conn.dispose()
        sockets.delete(conn)
        const remaining = (counts.get(credential.hash) ?? 1) - 1
        if (remaining > 0) counts.set(credential.hash, remaining)
        else counts.delete(credential.hash)
      })
      ws.on('pong', () => { conn.lastFrame = clock.monotonic() })
      ws.on('ping', () => { conn.lastFrame = clock.monotonic() })
      ws.on('message', (data, binary) => {
        conn.lastFrame = clock.monotonic()
        let input: unknown
        if (!binary) try { input = JSON.parse(data.toString()) } catch { /* handled by schema validation */ }
        try { receive(conn, input) }
        catch (error) {
          ctx.logger.error('dashboard frame handler failed: %s', error instanceof Error ? error.name : 'unknown')
          void conn.send({ t: 'error', code: 'INTERNAL', message: '面板请求处理失败' })
        }
      })
    })
  }
  const markTask = (id: string) => {
    if (!pendingTasks.has(id)) pendingTasks.set(id, clock.monotonic() + 250)
  }
  ctx.effect(() => {
    const unregister = http.upgrade('/ws/dashboard', (req, socket, head) => { upgrade(req, socket, head) })
    const stopUpdates = clock.setInterval(() => {
      const now = clock.monotonic()
      if (overviewDue <= now) {
        lastOverview = now
        overviewDue = Infinity
        publish({ type: 'overview.updated', topic: 'overview', data: overview() })
      }
      for (const [id, p] of progress) if (p.due <= now) pendingTasks.set(id, Math.min(pendingTasks.get(id) ?? now, now))
      for (const [id, due] of pendingTasks) if (due <= now) {
        pendingTasks.delete(id)
        const row = store.repos.tasks.get(id)
        if (!row) { progress.delete(id); continue }
        const run = store.repos.runs.forTask(id)[0]
        const task = taskView(store.repos, row, run && workers.get(run.workerId), undefined, run)
        publishTask(task, 'task.updated')
        publishDetail(id)
        if (task.finishedAt !== null && (progress.get(id)?.due ?? Infinity) === Infinity) progress.delete(id)
      }
    }, 25)
    const stopHeartbeat = clock.setInterval(() => {
      for (const conn of sockets) conn.heartbeat(clock.monotonic())
    }, 1000)
    return () => {
      stopped = true
      unregister()
      stopUpdates()
      stopHeartbeat()
      for (const conn of sockets) conn.close(codes.GOING_AWAY, 'server_restart')
      server.close()
    }
  }, 'dashboard:ws')
  safeOn(ctx, 'task/created', task => { publishTask(task, 'task.created'); markOverview() })
  safeOn(ctx, 'task/transitioned', ({ task, from }) => { if (from !== null) markTask(task.id); markOverview() })
  safeOn(ctx, 'task/result-delivery', id => markTask(id))
  safeOn(ctx, 'run/updated', data => {
    publish({ topic: 'task:' + data.taskId, type: 'run.updated', data })
    markTask(data.taskId)
    const worker = workers.get(data.workerId)
    if (worker) publish({ topic: 'workers', type: 'worker.updated', data: worker })
    markOverview()
  })
  safeOn(ctx, 'run/events', (id, taskId, events) => {
    for (const conn of sockets) conn.follows.append(id, events)
    if (events.some(event => event.kind === 'progress')) markTask(taskId)
  })
  safeOn(ctx, 'workspace/pointer', data => publish({ topic: 'workers', type: 'workspace.updated', data }))
  safeOn(ctx, 'worker/updated', (data, previous) => {
    publish({ topic: 'workers', type: 'worker.updated', data })
    if (previous?.connection !== data.connection || previous.graceUntil !== data.graceUntil) {
      for (const run of store.repos.runs.active(data.id)) markTask(run.taskId)
    }
    markOverview()
  })
  safeOn(ctx, 'hub/status', data => { publish({ topic: 'overview', type: 'system.status', data }); markOverview() })
  safeOn(ctx, 'auth/revoked', hash => {
    for (const conn of sockets) if (conn.credential.hash === hash) conn.close(codes.SESSION_EXPIRED, 'session_expired')
  })
  safeOn(ctx, 'hub/drain', async () => {
    const { hub, feishu } = overview()
    publish({ topic: 'overview', type: 'system.status', data: { ...hub, draining: true, feishu } })
    for (const conn of sockets) conn.close(codes.GOING_AWAY, 'hub_draining')
  })
}

