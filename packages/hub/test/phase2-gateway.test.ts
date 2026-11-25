import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { FakeClock, ulid } from '@agent-hub/common'
import { HubToWorkerFrame, WORKER_SUBPROTOCOL } from '@agent-hub/protocol'
import type { WorkerHello } from '@agent-hub/protocol'
import { expect, it } from 'vitest'
import { createTestHub } from '../src/app.js'

it('authenticates a registered identity, rejects a replay and times out an unfinished handshake', async () => {
  const clock = new FakeClock(1000)
  const hub = await createTestHub({ server: { port: 0, allowInsecureWorker: true }, storage: { path: ':memory:' } }, { clock })
  const sockets: WebSocket[] = []
  try {
    const workerId = 'gw-test'
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    const { token } = hub.ctx.auth.createEnrollToken({ type: 'owner', id: 'owner', channel: 'dashboard' }, workerId)
    hub.ctx.auth.enroll({ token, workerId, publicKey: der.toString('base64'), hostname: 'test', os: 'linux' }, '127.0.0.1')
    const url = new URL('/ws/worker', hub.address)
    url.protocol = 'ws:'
    const createSocket = () => {
      const socket = new WebSocket(url, WORKER_SUBPROTOCOL, { headers: { 'X-Worker-Id': workerId } })
      sockets.push(socket)
      return socket
    }
    const challengeOf = async (socket: WebSocket) => {
      const data = HubToWorkerFrame.parse(JSON.parse(String((await once(socket, 'message'))[0])))
      if (data.type !== 'hub.challenge') throw new Error('Expected challenge')
      return data.payload
    }
    const socket = createSocket()
    const challenge = await challengeOf(socket)
    const clientNonce = randomBytes(16).toString('base64url')
    const message = Buffer.from(['agent-hub/worker-auth/v1', workerId, challenge.nonce, clientNonce, challenge.hubBootId].join('\n'))
    const hello: WorkerHello = {
      auth: { workerId, clientNonce, keyFingerprint: createHash('sha256').update(der).digest('base64url').slice(0, 16),
        signature: sign(null, message, privateKey).toString('base64url') },
      agent: { version: 'test', hostname: 'test', os: 'linux', arch: 'x64', nodeVersion: process.version, pid: 1 },
      maxConcurrency: 1, adapters: [], workspaces: [], runs: [], drain: false,
    }
    const frame = JSON.stringify({ v: 1, id: ulid(1000), ts: 1000, type: 'worker.hello', payload: hello })
    const welcome = once(socket, 'message')
    socket.send(frame)
    expect(HubToWorkerFrame.parse(JSON.parse(String((await welcome)[0])))).toMatchObject({
      type: 'hub.welcome', payload: { connectionEpoch: 1 },
    })
    const replay = createSocket()
    expect((await challengeOf(replay)).nonce).not.toBe(challenge.nonce)
    const replayClosed = once(replay, 'close')
    replay.send(frame)
    expect((await replayClosed)[0]).toBe(4401)
    expect(hub.ctx.store.repos.workers.get(workerId)?.connectionEpoch).toBe(1)
    const idle = createSocket()
    await challengeOf(idle)
    const idleClosed = once(idle, 'close')
    clock.advance(5000)
    expect((await idleClosed)[0]).toBe(4408)
  } finally {
    for (const socket of sockets) socket.terminate()
    await hub.close()
  }
})
