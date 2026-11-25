import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { FakeClock } from '@agent-hub/common'
import { DASHBOARD_SUBPROTOCOL, DashServerFrame } from '@agent-hub/protocol'
import { enrollWorker, eventually, openHarness, ownerActor, seedRun } from './pi/harness.js'

const origin = 'http://127.0.0.1'
const settings = { server: { port: 0, allowInsecureWorker: true }, dashboard: { allowedOrigins: [origin] } }

it('admin can replace policies with a revision and revoke a token without exposing hashes', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  try {
    const authorization = 'Bearer ' + hub.ctx.auth.createApiToken('test', ['admin'])
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
      hub.ctx.http.app.inject({ method, url: '/api/v1' + url, headers: { authorization }, payload })
    const policies = await call('GET', '/config/policies')
    expect(policies.statusCode).toBe(200)
    expect(policies.headers['x-policy-revision']).toBe('0')
    expect((await call('PUT', '/config/policies', { rules: [], expectedRevision: 0 })).json()).toEqual({ revision: 1 })
    expect((await call('PUT', '/config/policies', { rules: [], expectedRevision: 0 })).statusCode).toBe(409)
    const created = await call('POST', '/api-tokens', { name: 'temporary', scopes: ['read'] })
    expect(created.statusCode).toBe(201)
    const { id, token } = created.json()
    expect((await call('GET', '/api-tokens')).body).not.toContain(token)
    expect((await call('DELETE', '/api-tokens/' + id)).statusCode).toBe(204)
    expect(hub.ctx.auth.verifyApiToken(token)).toBeNull()
    const audit = await call('GET', '/audit?action=token.revoked&limit=1')
    expect(audit.json().items[0]).toMatchObject({ targetId: id })
    hub.ctx.http.setAccepting(false)
    expect((await call('PUT', '/config/policies', { rules: [], expectedRevision: 1 })).statusCode).toBe(503)
    expect((await call('GET', '/overview')).statusCode).toBe(200)
  } finally { await cleanup() }
})

it('uses a development HTTP cookie and enforces CSRF', async () => {
  const secret = 'phase4-admin-' + 'a'.repeat(32)
  vi.stubEnv('HUB_ADMIN_TOKEN_SHA256', createHash('sha256').update(secret).digest('hex'))
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  try {
    const login = await hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token: secret } })
    expect(login.statusCode).toBe(200)
    expect(login.headers['set-cookie']).not.toContain('Secure')
    const cookie = String(login.headers['set-cookie']).split(';')[0]!
    const result = await hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin } })
    expect(result.json().error.code).toBe('CSRF_FAILED')
  } finally { await cleanup(); vi.unstubAllEnvs() }
})

it('authenticates upgrades and synchronizes the dashboard over WebSocket', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const authorization = 'Bearer ' + hub.ctx.auth.createApiToken('read', ['read'])
  const url = hub.address!.replace('http:', 'ws:') + '/ws/dashboard'
  const rejected = new WebSocket(url, DASHBOARD_SUBPROTOCOL, { origin: 'https://wrong.test', headers: { authorization } })
  const socket = new WebSocket(url, DASHBOARD_SUBPROTOCOL, { origin, headers: { authorization } })
  try {
    await Promise.all([once(socket, 'open'), expect(once(rejected, 'open')).rejects.toThrow('403')])
    const receive = async () => JSON.parse(String((await once(socket, 'message'))[0])) as DashServerFrame
    socket.send(JSON.stringify({ t: 'hello' }))
    const welcome = await receive()
    expect(welcome).toMatchObject({ t: 'welcome', resumed: false })
    socket.send(JSON.stringify({ t: 'subscribe', topics: ['overview', 'workers', 'tasks'] }))
    expect(await receive()).toMatchObject({ t: 'snapshot', eventSeq: (welcome as Extract<DashServerFrame, { t: 'welcome' }>).eventSeq })
    socket.send(JSON.stringify({ t: 'follow', runId: 'missing', fromSeq: 0 }))
    expect(await receive()).toMatchObject({ t: 'logs.reset', reason: 'run_not_found' })
  } finally { socket.terminate(); rejected.terminate(); await cleanup() }
})


function inbox(socket: WebSocket) {
  const messages: DashServerFrame[] = []
  socket.on('message', data => messages.push(DashServerFrame.parse(JSON.parse(String(data)))))
  const send = (frame: object) => socket.send(JSON.stringify(frame))
  return { messages, send, wait: (predicate: () => boolean) => eventually(predicate, { timeoutMs: 3000 }) }
}

it('replays only newly declared topics and broadcasts draining before close', async () => {
  const clock = new FakeClock(10_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('resume', ['read']) }
  const address = url.replace('http:', 'ws:') + '/ws/dashboard'
  const first = new WebSocket(address, DASHBOARD_SUBPROTOCOL, { origin, headers })
  let second: WebSocket | undefined
  try {
    await enrollWorker(hub, 'resume-worker')
    const worker = hub.ctx.workers.get('resume-worker')!
    const before = inbox(first)
    await once(first, 'open')
    before.send({ t: 'hello' })
    before.send({ t: 'subscribe', topics: ['overview', 'workers'] })
    await before.wait(() => before.messages.some(frame => frame.t === 'snapshot'))
    const snapshot = before.messages.find(frame => frame.t === 'snapshot')!
    first.close()
    await once(first, 'close')
    for (let i = 0; i < 100; i++) hub.ctx.emit('worker/updated', { ...worker, rttMs: i }, worker)
    clock.advance(25)
    second = new WebSocket(address, DASHBOARD_SUBPROTOCOL, { origin, headers })
    const after = inbox(second)
    await once(second, 'open')
    after.send({ t: 'hello', resume: { bootId: snapshot.overview.hub.bootId, eventSeq: snapshot.eventSeq } })
    after.send({ t: 'subscribe', topics: ['workers'] })
    after.send({ t: 'ping', n: 1 })
    await after.wait(() => after.messages.some(frame => frame.t === 'pong') && after.messages.filter(frame => frame.t === 'event').length >= 100)
    expect(after.messages[0]).toMatchObject({ t: 'welcome', resumed: true })
    const replay = after.messages.filter(frame => frame.t === 'event')
    expect(replay).toHaveLength(100)
    expect(replay.every((frame, i) => frame.topic === 'workers' && frame.eventSeq === snapshot.eventSeq + 1 + i)).toBe(true)
    expect(after.messages.some(frame => frame.t === 'snapshot')).toBe(false)
    after.send({ t: 'subscribe', topics: ['overview'] })
    await after.wait(() => after.messages.some(frame => frame.t === 'snapshot'))
    const closing = once(second, 'close')
    await hub.close()
    expect((await closing)[0]).toBe(1001)
    expect(after.messages.at(-1)).toMatchObject({ t: 'event', type: 'system.status', data: { draining: true } })
  } finally { first.terminate(); second?.terminate(); await cleanup() }
})

it('follows a multi-page run through a concurrent append and streams the same log download', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('logs', ['read']) }
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
  try {
    const wire = inbox(socket)
    await once(socket, 'open')
    await enrollWorker(hub, 'log-worker')
    const run = seedRun(hub, { workerId: 'log-worker', taskStatus: 'running', runStatus: 'running' })
    const records = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({
      seq: from + i, ts: hub.ctx.clock.now(), kind: 'log' as const, stream: 'stdout' as const, text: 'line ' + (from + i),
    }))
    const persist = async (from: number, count: number) => {
      const events = records(from, count)
      const job = hub.ctx.store.ingest.enqueue(run.runId, events)
      await hub.ctx.store.ingest.flush()
      await job
      hub.ctx.emit('run/events', run.runId, run.taskId, events)
    }
    await persist(1, 1001)
    wire.send({ t: 'hello' })
    wire.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
    await wire.wait(() => wire.messages.some(frame => frame.t === 'logs'))
    await persist(1002, 10)
    await wire.wait(() => wire.messages.some(frame => frame.t === 'logs' && frame.entries.some(entry => entry.seq === 1011)))
    const logs = wire.messages.filter(frame => frame.t === 'logs')
    expect(logs[0]?.entries).toHaveLength(500)
    expect(logs.flatMap(frame => frame.entries.map(entry => entry.seq))).toEqual(records(1, 1011).map(entry => entry.seq))
    const download = await fetch(url + '/api/v1/tasks/' + run.taskId + '/runs/' + run.runId + '/logs.txt', { headers })
    expect(download.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect((await download.text()).trim().split('\n')).toEqual(records(1, 1011).map(entry => entry.text))
  } finally { socket.terminate(); await cleanup() }
})

it('uses the configured timezone for the daily statistics', async () => {
  const clock = new FakeClock(Date.parse('2026-11-23T01:00:00Z'))
  const { hub, cleanup } = await openHarness(settings, { clock, listen: false })
  try {
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'local day', workspaceId: 'sandbox' }, ownerActor)
    hub.ctx.store.repos.prepare("UPDATE tasks SET status='succeeded', finished_at=? WHERE id=?")
      .run(Date.parse('2026-11-22T17:00:00Z'), task.id)
    expect(hub.ctx.orchestrator.overview().today.succeeded).toBe(1)
  } finally { await cleanup() }
})

it('resets follows and closes a WebSocket that remains backpressured', async () => {
  const clock = new FakeClock(5_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('slow', ['read']) }
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
  try {
    const wire = inbox(socket)
    await once(socket, 'open')
    await enrollWorker(hub, 'slow-worker')
    const run = seedRun(hub, { workerId: 'slow-worker', taskStatus: 'running', runStatus: 'running' })
    wire.send({ t: 'hello' })
    wire.send({ t: 'follow', runId: run.runId, fromSeq: 0 })
    wire.send({ t: 'ping', n: 1 })
    await wire.wait(() => wire.messages.some(frame => frame.t === 'pong'))
    socket.pause()
    const payload = 'x'.repeat(16_000)
    for (let seq = 1; seq <= 1000; seq += 100) {
      hub.ctx.emit('run/events', run.runId, run.taskId, Array.from({ length: 100 }, (_, i) => ({
        kind: 'log' as const, stream: 'stdout' as const, seq: seq + i, ts: clock.now(), text: payload,
      })))
    }
    clock.advance(11_000)
    const closed = once(socket, 'close')
    socket.resume()
    expect((await closed)[0]).toBe(4008)
    expect(wire.messages.find(frame => frame.t === 'logs.reset')).toMatchObject({ reason: 'slow_consumer', runId: run.runId })
    expect(wire.messages.at(-1)).toMatchObject({ t: 'resync', reason: 'slow_consumer' })
  } finally { socket.terminate(); await cleanup() }
})

it('serves the SPA index and assets while keeping API and WebSocket paths separate', async () => {
  const distDir = mkdtempSync(join(tmpdir(), 'phase4-static-'))
  writeFileSync(join(distDir, 'index.html'), '<main>command center</main>')
  writeFileSync(join(distDir, 'asset.js'), 'export {}')
  const { hub, cleanup } = await openHarness({ ...settings, dashboard: { ...settings.dashboard, distDir } }, { listen: false })
  try {
    const get = (url: string) => hub.ctx.http.app.inject({ url })
    expect((await get('/tasks/overview')).body).toBe('<main>command center</main>')
    expect((await get('/asset.js')).headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect((await get('/api/v1/missing')).statusCode).toBe(404)
    expect((await get('/ws/dashboard')).statusCode).toBe(404)
    expect((await get('/healthz')).json()).toEqual({ ok: true })
  } finally { await cleanup(); rmSync(distDir, { recursive: true, force: true }) }
})

it('requires a fresh snapshot when the resume sequence is older than 10,000 events', async () => {
  const clock = new FakeClock(10_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('resume-window', ['read']) }
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
  try {
    const wire = inbox(socket)
    await once(socket, 'open')
    await enrollWorker(hub, 'window-worker')
    const worker = hub.ctx.workers.get('window-worker')!
    const base = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
    try {
      const before = inbox(base)
      await once(base, 'open')
      before.send({ t: 'hello' })
      await before.wait(() => before.messages.length > 0)
      const welcome = before.messages[0]!
      if (welcome.t !== 'welcome') throw new Error('Expected welcome')
      for (let i = 0; i < 10_001; i++) hub.ctx.emit('worker/updated', { ...worker, rttMs: i }, worker)
      wire.send({ t: 'hello', resume: { bootId: welcome.bootId, eventSeq: welcome.eventSeq } })
      await wire.wait(() => wire.messages.length > 0)
      expect(wire.messages[0]).toMatchObject({ t: 'welcome', resumed: false, eventSeq: welcome.eventSeq + 10_001 })
    } finally { base.terminate() }
  } finally { socket.terminate(); await cleanup() }
})

it('coalesces task updates and delivers the newest version after 250 ms', async () => {
  const clock = new FakeClock(10_000)
  const { hub, cleanup, url } = await openHarness(settings, { clock })
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('task-updates', ['read']) }
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
  try {
    const wire = inbox(socket)
    await once(socket, 'open')
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'updates', workspaceId: 'sandbox' }, ownerActor)
    wire.send({ t: 'hello' })
    wire.send({ t: 'subscribe', topics: ['tasks'] })
    await wire.wait(() => wire.messages.some(frame => frame.t === 'snapshot'))
    const patch = hub.ctx.store.repos.prepare('UPDATE tasks SET version = ? WHERE id = ?')
    for (let version = 2; version <= 11; version++) {
      patch.run(version, task.id)
      hub.ctx.emit('task/transitioned', { task: { ...task, version }, from: 'awaiting_approval',
        to: 'queued', event: 'APPROVE', actor: ownerActor })
    }
    const updates = () => wire.messages.filter(frame => frame.t === 'event' && frame.type === 'task.updated')
    clock.advance(249)
    expect(updates()).toHaveLength(0)
    clock.advance(1)
    await wire.wait(() => updates().length > 0)
    expect(updates()).toMatchObject([{ data: { id: task.id, version: 11 } }])
  } finally { socket.terminate(); await cleanup() }
})

it('rate-limits the sixth unsuccessful login in the 15-minute window', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  try {
    for (let trial = 1; trial <= 6; trial++) {
      const result = await hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token: 'invalid' } })
      expect(result.statusCode).toBe(trial === 6 ? 429 : 401)
      if (trial === 6) {
        expect(result.json().error.code).toBe('RATE_LIMITED')
        expect(Number(result.headers['retry-after'])).toBeGreaterThan(0)
      }
    }
  } finally { await cleanup() }
})

it('closes the sixth Dashboard socket for the same credential with 4029', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('connection-limit', ['read']) }
  const address = url.replace('http:', 'ws:') + '/ws/dashboard'
  const peers: WebSocket[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const socket = new WebSocket(address, DASHBOARD_SUBPROTOCOL, { origin, headers })
      peers.push(socket)
      await once(socket, 'open')
    }
    const sixth = new WebSocket(address, DASHBOARD_SUBPROTOCOL, { origin, headers })
    peers.push(sixth)
    expect((await once(sixth, 'close'))[0]).toBe(4029)
    expect(peers.slice(0, 5).every(socket => socket.readyState === WebSocket.OPEN)).toBe(true)
  } finally { for (const socket of peers) socket.terminate(); await cleanup() }
})

it('clears a Worker grace countdown as soon as its last active Run ends', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  const headers = { authorization: 'Bearer ' + hub.ctx.auth.createApiToken('grace', ['read']) }
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/dashboard', DASHBOARD_SUBPROTOCOL, { origin, headers })
  try {
    const wire = inbox(socket)
    await once(socket, 'open')
    await enrollWorker(hub, 'grace-worker')
    const run = seedRun(hub, { workerId: 'grace-worker', taskStatus: 'running', runStatus: 'running' })
    hub.ctx.store.repos.prepare('UPDATE workers SET disconnected_at = ? WHERE id = ?').run(hub.ctx.clock.now(), 'grace-worker')
    wire.send({ t: 'hello' })
    wire.send({ t: 'subscribe', topics: ['workers'] })
    await wire.wait(() => wire.messages.some(frame => frame.t === 'snapshot'))
    expect(wire.messages.find(frame => frame.t === 'snapshot')?.workers[0]?.graceUntil).toBeGreaterThan(hub.ctx.clock.now())
    hub.ctx.store.repos.prepare("UPDATE task_runs SET status = 'lost' WHERE id = ?").run(run.runId)
    hub.ctx.emit('run/updated', hub.ctx.orchestrator.getTask(run.taskId)!.runs[0]!)
    await wire.wait(() => wire.messages.some(frame => frame.t === 'event' && frame.type === 'worker.updated'))
    expect(wire.messages.find(frame => frame.t === 'event' && frame.type === 'worker.updated'))
      .toMatchObject({ data: { id: 'grace-worker', activeRunIds: [], slotsUsed: 0, graceUntil: null } })
  } finally { socket.terminate(); await cleanup() }
})
