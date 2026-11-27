import { expect, it } from 'vitest'
import { QuotaOverviewResponse } from '@agent-hub/protocol'
import { FakeWorker, openHarness } from './pi/harness.js'

const settings = { server: { port: 0, allowInsecureWorker: true } }

it('stores the subscription quotas a worker reports and serves them to the dashboard', async () => {
  const { hub, cleanup } = await openHarness(settings, {})
  try {
    const authorization = 'Bearer ' + hub.ctx.auth.createApiToken('test', ['read'])
    const get = async () => QuotaOverviewResponse.parse((await hub.ctx.http.app.inject({ method: 'GET', url: '/api/v1/quotas', headers: { authorization } })).json())
    const worker = await FakeWorker.connect(hub, { workerId: 'quota' })
    expect(await get()).toEqual([])
    const claude = { adapter: 'claude-code', plan: 'pro', checkedAt: 1, windows: [{ label: '5 小时', usedPercent: 15, resetsAt: 2 }, { label: '每周', usedPercent: 42, resetsAt: null }] }
    const codex = { adapter: 'codex', checkedAt: 1, windows: [{ label: '每周', usedPercent: 50, resetsAt: 3 }] }
    await worker.heartbeat({ quotas: [claude, codex] })
    await expect.poll(get).toEqual([{ ...claude, workerId: 'quota' }, { ...codex, workerId: 'quota' }])
    // 没带 quotas 的心跳不改动；带了就整体替换
    await worker.heartbeat()
    await worker.heartbeat({ quotas: [codex] })
    await expect.poll(get).toEqual([{ ...codex, workerId: 'quota' }])
  } finally { await cleanup() }
})
