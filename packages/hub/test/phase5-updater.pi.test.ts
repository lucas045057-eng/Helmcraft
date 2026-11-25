/**
 * Pi 独立验收 · Phase 5 CardUpdater 节流限流与卡具体积
 * 覆盖 FS-21、FS-23。
 */
import { expect, it, vi } from 'vitest'
import { assertInvariants, eventually, FakeWorker, ownerActor } from './pi/harness.js'
import { openHarness } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { CardUpdater } from '../src/plugins/channel-feishu/card-updater.js'
import { renderProgressCard } from '../src/plugins/channel-feishu/cards/index.js'
import type { TaskCardModel } from '../src/plugins/channel-feishu/cards/index.js'
import type { RunDispatch } from '@agent-hub/protocol'

const settings = { minPatchIntervalMs: 3000, minPatchIntervalHighMs: 1000, globalPatchQps: 5,
  cardResultMaxChars: 2000, cardMaxBytes: 28 * 1024 }

it('FS-21 注入 429 / 99991400 → 单卡指数退避；1 分钟内 ≥3 次后全局速率减半并在 5 分钟后恢复；最终一致', async () => {
  vi.useFakeTimers()
  const failures = new Map<string, unknown[]>([
    ['backoff', [{ status: 429 }, { response: { data: { code: 99991400, msg: 'frequency limit' } } }]],
  ])
  const calls: Array<{ id: string; at: number }> = []
  const transport = {
    patchCard: async (id: string) => {
      calls.push({ id, at: Date.now() })
      const queue = failures.get(id)
      if (queue?.length) throw queue.shift()
    },
  }
  const sent = vi.fn()
  const updater = new CardUpdater(transport, settings, { sent, dead: vi.fn(), warn: vi.fn() })
  const rate = () => (updater as unknown as { bucket: { rate: number } }).bucket.rate
  const advanceUntil = async (target: number, maxMs: number) => {
    let waited = 0
    while (calls.length < target && waited < maxMs) { await vi.advanceTimersByTimeAsync(25); waited += 25 }
    return waited
  }
  try {
    updater.desire('backoff', { card: { n: 0 }, version: 1, terminal: false }, true)
    await advanceUntil(1, 500)
    expect(calls).toHaveLength(1)
    expect(rate()).toBe(5)
    // 第一次 429 → 退避 2s
    await vi.advanceTimersByTimeAsync(1500)
    expect(calls).toHaveLength(1)
    await advanceUntil(2, 1500)
    expect(calls).toHaveLength(2)
    expect(rate()).toBe(5)
    const secondAt = calls[1]!.at
    // 第二次 99991400 → 退避 4s（3.5s 时仍未来）
    await vi.advanceTimersByTimeAsync(3500)
    expect(calls).toHaveLength(2)
    await advanceUntil(3, 1500)
    expect(calls).toHaveLength(3)
    const times = calls.map(call => call.at)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1990)
    expect(times[1]! - times[0]!).toBeLessThanOrEqual(2060)
    expect(times[2]! - secondAt).toBeGreaterThanOrEqual(3990)
    expect(times[2]! - secondAt).toBeLessThanOrEqual(4060)
    expect(sent).toHaveBeenCalled()
    // 第三次限流（1 分钟内）→ 全局速率减半
    failures.set('third', [{ status: 429 }])
    updater.desire('third', { card: { n: 1 }, version: 1, terminal: false }, true)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter(call => call.id === 'third')).toHaveLength(1)
    expect(rate()).toBe(2.5)
    // 5 分钟后恢复
    await vi.advanceTimersByTimeAsync(300_000)
    updater.desire('recovered', { card: { n: 2 }, version: 1, terminal: false }, true)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter(call => call.id === 'recovered')).toHaveLength(1)
    expect(rate()).toBe(5)
    // 最终一致：退避后的最新内容仍然被推送
    updater.desire('backoff', { card: { newest: true }, version: 2, terminal: true }, true)
    await vi.advanceTimersByTimeAsync(3500)
    expect(sent.mock.calls.at(-1)?.[0]).toBe('backoff')
    expect(calls.filter(call => call.id === 'backoff')).toHaveLength(4)
  } finally { updater.close(); vi.useRealTimers() }
})

const model: TaskCardModel = { id: 'tsk_' + '0'.repeat(26), taskNo: 11, status: 'running', version: 2, prompt: '需求',
  allowedActions: ['cancel'], inputRequest: null, adapter: 'mock', profile: 'edit', workspaceId: 'sandbox',
  scheduleHint: null, attempt: 1, errorCode: null, startedAt: 0, updatedAt: 4000, finishedAt: null,
  resultSummary: '结果', progress: [], panelUrl: null, resultDeliveryStatus: 'not_required' }

it('FS-23 超大进展/摘要/需求 → 截断后卡片 JSON ≤ cardMaxBytes 且合法；正文超限额外发补充文本', async () => {
  // 单元：单卡片三个字段同时超限
  for (const audience of ['owner', 'requester'] as const) {
    const card = renderProgressCard({ ...model, status: 'succeeded', prompt: '需'.repeat(32_000),
      resultSummary: '好'.repeat(12_000), progress: Array.from({ length: 5 }, (_, index) => '进展' + index + 'x'.repeat(4000)) },
      audience)
    const encoded = JSON.stringify(card)
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(28 * 1024)
    expect(JSON.parse(encoded)).toEqual(card)
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(1000)
  }
  // 极小上限也能收敛
  const tiny = renderProgressCard({ ...model, status: 'failed', prompt: '需'.repeat(5000), resultSummary: '好'.repeat(5000),
    cardMaxBytes: 640 }, 'owner')
  expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(640)

  // 集成：40k 需求卡片不超限；结果正文 > cardResultMaxChars 时额外发送补充文本
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { enabled: true, ownerOpenIds: ['ou_owner'],
    requesterAllowlist: ['ou_req'], requesterPolicy: 'chat', allowedChatIds: ['oc_group'],
    defaultWorkspaceId: 'sandbox', card: { ...settings, cardResultMaxChars: 64 } } }, { feishuTransport: fake })
  const worker = await FakeWorker.connect(hub, { workerId: 'oversize-worker' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    const huge = '导出'.repeat(15_000)
    await fake.group(huge, { messageId: 'om_oversize' })
    const hugeTask = db.tasks.getByNo(1)!
    const hugeCard = db.feishu.messages(hugeTask.id).find(row => row.role === 'progress_card')!
    const hugeJson = JSON.stringify((fake.messages.get(hugeCard.messageId)!.body as { card: unknown }).card)
    expect(Buffer.byteLength(hugeJson)).toBeLessThanOrEqual(28 * 1024)
    expect(() => JSON.parse(hugeJson)).not.toThrow()

    await fake.group('小任务', { messageId: 'om_result' })
    const task = db.tasks.getByNo(2)!
    await api.approve(task.id, ownerActor, { expectedVersion: task.version })
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    const summary = '结果正文-' + 'A'.repeat(500)
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts: Date.now(), kind: 'started', pid: 51, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: Date.now() + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null,
        durationMs: 1, summary },
    ])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded', { timeoutMs: 5000, label: 'succeeded' })
    await eventually(() => db.feishu.messages(task.id).some(row => row.role === 'result_text'),
      { timeoutMs: 8000, label: 'supplement text' })
    const supplement = db.feishu.messages(task.id).find(row => row.role === 'result_text')!
    expect(fake.text(supplement.messageId)).toBe(summary)
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    await eventually(() => fake.json(progress.messageId).includes('结果正文-'),
      { timeoutMs: 8000, label: 'truncated result on card' })
    expect(fake.json(progress.messageId)).toContain('结果正文-')
    expect(fake.json(progress.messageId)).not.toContain('A'.repeat(60))
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)
