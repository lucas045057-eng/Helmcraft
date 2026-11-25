/**
 * Pi 独立验收 · Phase 2 门禁：P-3 / P-8
 * 对照 docs/specs/03-protocol-hub-worker.md §2「接收方对未知 type：鉴权前 → 4400；鉴权后 → 记录告警并忽略（向前兼容）」
 * 与 pi-test-matrix §2。
 */
import { expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { FakeWorker, openHarness } from './pi/harness.js'

const baseConfig = { server: { port: 0, allowInsecureWorker: true }, workers: { handshakeTimeoutMs: 1000 } }

it('P-3 鉴权前未知 type：4400 断开', async () => {
  const clock = new FakeClock(1_000)
  const { hub, cleanup } = await openHarness(baseConfig, { clock })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p3-pre', manualHello: true })
    const closed = worker.waitClose()
    worker.send('worker.future', { anything: true })
    expect(await closed).toBe(4400)
  } finally { await cleanup() }
})

it('P-3 鉴权后未知 type：忽略并告警，连接保持', async () => {
  const clock = new FakeClock(1_000)
  const { hub, cleanup } = await openHarness(baseConfig, { clock })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p3-post' })
    expect(worker.welcome).toBeTruthy()
    const before = hub.ctx.store.repos.workers.get('p3-post')!.connectionEpoch

    worker.send('worker.future', { anything: true })
    // 给 Hub 足够的处理时间（真实事件循环）
    await new Promise(resolve => setTimeout(resolve, 250))

    expect(worker.closeCode, '未知 type 不应在鉴权后关闭连接').toBeUndefined()
    await worker.heartbeat()
    await worker.waitFor('hub.heartbeat_ack', 2000)
    expect(hub.ctx.workers.isOnline('p3-post')).toBe(true)
    expect(hub.ctx.store.repos.workers.get('p3-post')!.connectionEpoch).toBe(before)
  } finally { await cleanup() }
})

it('P-8 子协议缺失：HTTP 层拒绝升级', async () => {
  const { hub, cleanup } = await openHarness(baseConfig)
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p8-missing', subprotocol: null, connect: false })
    const failed = await new Promise<string>((resolve) => {
      worker.ws.on('unexpected-response', (_req, res) => resolve('http:' + res.statusCode))
      worker.ws.on('error', error => resolve('error:' + error.message))
      worker.ws.on('open', () => resolve('open'))
    })
    expect(failed).toMatch(/^http:4/)
    worker.terminate()
  } finally { await cleanup() }
})

it('P-8 子协议错误：HTTP 层拒绝或 4426', async () => {
  const { hub, cleanup } = await openHarness(baseConfig)
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p8-wrong', subprotocol: 'agent-hub.worker.v2', connect: false })
    const outcome = await new Promise<string>((resolve) => {
      worker.ws.on('unexpected-response', (_req, res) => resolve('http:' + res.statusCode))
      worker.ws.on('error', error => resolve('error:' + error.message))
      worker.ws.on('close', code => resolve('close:' + code))
      worker.ws.on('open', async () => {
        try { resolve('close:' + await worker.waitClose(2000)) } catch { resolve('timeout') }
      })
    })
    expect(outcome === 'close:4426' || /^http:4/.test(outcome)).toBe(true)
    worker.terminate()
  } finally { await cleanup() }
})

it('P-8 鉴权前的二进制帧 → 4400', async () => {
  const clock = new FakeClock(1_000)
  const { hub, cleanup } = await openHarness(baseConfig, { clock })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p8-binary', manualHello: true })
    const closed = worker.waitClose()
    worker.sendBytes(Buffer.from([0x00, 0x01, 0x02]))
    expect(await closed).toBe(4400)
  } finally { await cleanup() }
})

it('P-8 鉴权前 > 16 KiB 帧 → 4400（即使未超出 maxFrameBytes）', async () => {
  const clock = new FakeClock(1_000)
  const { hub, cleanup } = await openHarness(baseConfig, { clock })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'p8-large', manualHello: true })
    const closed = worker.waitClose()
    worker.sendRaw(JSON.stringify({ v: 1, id: 'x', ts: 1, type: 'worker.hello', payload: { padding: 'x'.repeat(17 * 1024) } }))
    expect(await closed).toBe(4400)
  } finally { await cleanup() }
})
