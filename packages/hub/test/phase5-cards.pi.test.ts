/**
 * Pi 独立验收 · Phase 5 卡片回调、幂等、安全与 CardUpdater 集成行为
 * 覆盖 FS-16 ~ FS-20、FS-22、FS-24、FS-25、SEC-18。
 */
import { expect, it, vi } from 'vitest'
import { CardActionValue, TaskStatus } from '@agent-hub/protocol'
import type { RunDispatch } from '@agent-hub/protocol'
import { assertInvariants, delay, eventually, FakeWorker, ownerActor } from './pi/harness.js'
import { openHarness } from './pi/harness.js'
import { cardButtons, PiFeishuTransport } from './pi/feishu.js'
import { renderApprovalCard, renderOwnerReviewCard, renderProgressCard, renderTaskListCard, renderWorkersCard } from '../src/plugins/channel-feishu/cards/index.js'
import type { TaskCardModel } from '../src/plugins/channel-feishu/cards/index.js'

const config = {
  enabled: true,
  ownerOpenIds: ['ou_owner'],
  requesterAllowlist: ['ou_req'],
  requesterPolicy: 'chat' as const,
  allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox',
}

async function setup(extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const fake = new PiFeishuTransport()
  const opened = await openHarness({ feishu: { ...config, ...extra } }, { feishuTransport: fake, ...options })
  const db = opened.hub.ctx.store.repos
  return { ...opened, fake, db, api: opened.hub.ctx.orchestrator }
}

it('FS-16 同一审批按钮 10 个并发回调（不同 event_id）→ 恰好 1 次 APPROVE，其余 toast，< 3s 返回，只产生 1 个 Run', async () => {
  const { hub, fake, db, api, cleanup } = await setup()
  const worker = await FakeWorker.connect(hub, { workerId: 'concurrent-worker' })
  try {
    await fake.group('并发点击审批', { messageId: 'om_c16' })
    const task = db.tasks.getByNo(1)!
    const approval = db.feishu.messages(task.id).find(row => row.role === 'approval_card')!
    const value = { v: 1, a: 'approve', t: task.id, ver: task.version }
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      fake.click(approval.messageId, 'ou_owner', value, { eventId: 'concurrent:' + index })))
    const successes = results.filter(result => result.toast.type === 'success')
    expect(successes).toHaveLength(1)
    expect(successes[0]!.toast.content).toBe('已批准')
    const others = results.filter(result => result.toast.type !== 'success').map(result => result.toast.content)
    expect(others).toHaveLength(9)
    expect(others.every(content => ['正在处理，请稍候', '已处理'].includes(content))).toBe(true)
    expect(results.every(result => result.elapsed < 3000)).toBe(true)
    expect(db.runs.forTask(task.id)).toHaveLength(1)
    await eventually(() => worker.count('run.dispatch') === 1, { timeoutMs: 8000, label: 'single dispatch' })
    const dispatch = await worker.waitFor('run.dispatch')
    await worker.ackCommand(dispatch)
    await eventually(() => api.getTask(task.id)?.status === 'running', { timeoutMs: 5000, label: 'running' })
    await delay(400)
    expect(worker.count('run.dispatch')).toBe(1)
    expect(db.runs.forTask(task.id)).toHaveLength(1)
    const approvals = db.prepare("SELECT id FROM audit_logs WHERE target_id = ? AND action = 'task.approve'").all(task.id)
    expect(approvals).toHaveLength(1)
    expect(db.tasks.get(task.id)!.version).toBeGreaterThan(task.version)
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)

it('FS-17 旧版本卡片点击（ver 过期且动作已非法）→ toast 任务状态已变化、回调返回最新卡片自愈旧卡', async () => {
  const { fake, db, api, cleanup } = await setup({}, { listen: false })
  try {
    await fake.group('旧卡片', { messageId: 'om_c17' })
    const task = db.tasks.getByNo(1)!
    const approval = db.feishu.messages(task.id).find(row => row.role === 'approval_card')!
    const staleVersion = task.version
    await api.approve(task.id, ownerActor, { expectedVersion: task.version })
    const latest = api.getTask(task.id)!
    expect(latest.status).toBe('queued')
    const result = await fake.click(approval.messageId, 'ou_owner',
      { v: 1, a: 'approve', t: task.id, ver: staleVersion }, { eventId: 'card17' })
    expect(result.toast).toEqual({ type: 'info', content: '任务状态已变化' })
    expect(result.card?.type).toBe('raw')
    expect(fake.json(approval.messageId)).toContain('已批准')
    const row = db.feishu.messages(task.id).find(item => item.messageId === approval.messageId)!
    expect(row.cardTaskVersion).toBe(latest.version)
    expect(db.tasks.get(task.id)!.version).toBe(latest.version)
    assertInvariants(db)
  } finally { await cleanup() }
}, 20000)

it('FS-18 orchestrator 注入 2.5s 延迟 → 2.0s 前返回「已提交」，随后 CardUpdater 异步 patch 终态', async () => {
  const { fake, db, api, cleanup } = await setup()
  try {
    await fake.group('慢审批', { messageId: 'om_c18' })
    const task = db.tasks.getByNo(1)!
    const approval = db.feishu.messages(task.id).find(row => row.role === 'approval_card')!
    const real = api.approve.bind(api)
    const stub = vi.spyOn(api, 'approve').mockImplementation(async (...args: Parameters<typeof real>) => {
      await delay(2500)
      return real(...args)
    })
    const startedAt = Date.now()
    const result = await fake.click(approval.messageId, 'ou_owner',
      { v: 1, a: 'approve', t: task.id, ver: task.version }, { eventId: 'card18' })
    const elapsed = Date.now() - startedAt
    expect(result.toast).toEqual({ type: 'info', content: '已提交' })
    expect(elapsed).toBeGreaterThanOrEqual(1900)
    expect(elapsed).toBeLessThan(2900)
    await eventually(() => db.tasks.get(task.id)?.status === 'queued', { timeoutMs: 6000, label: 'async approve' })
    await eventually(() => fake.json(approval.messageId).includes('已批准'), { timeoutMs: 6000, label: 'async patch' })
    expect(stub).toHaveBeenCalledTimes(1)
    stub.mockRestore()
    assertInvariants(db)
  } finally { await cleanup() }
}, 30000)

it('FS-19 1s 内 200 次进展变化 → 同一卡片 3s 内 patch ≤ 1，最终内容为最新状态', async () => {
  const { hub, fake, db, cleanup } = await setup()
  const worker = await FakeWorker.connect(hub, { workerId: 'progress-worker' })
  try {
    await fake.p2p('#scenario: slow ms=60000', { messageId: 'om_c19' })
    const task = db.tasks.getByNo(1)!
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    const ts = Date.now()
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts, kind: 'started', pid: 31, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
    ])
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    await eventually(() => fake.json(progress.messageId).includes('执行中'), { timeoutMs: 8000, label: 'running card' })
    await delay(120)
    const startedAt = Date.now()
    let seq = 1
    for (let batch = 0; batch < 4; batch++) {
      const events: Array<Record<string, unknown>> = []
      for (let index = 0; index < 50; index++) {
        seq++
        events.push({ seq, ts: Date.now(), kind: 'progress', phase: 'step', detail: '进展 ' + seq })
      }
      worker.events(dispatch.runId, task.id, events)
      await delay(220)
    }
    expect(Date.now() - startedAt).toBeLessThan(1500)
    // 距最后一次成功 patch 至少 3s 的窗口内最多 1 次
    await delay(2600)
    const during = fake.patches.filter(patch => patch.id === progress.messageId && patch.at >= startedAt)
    expect(during.length).toBeLessThanOrEqual(1)
    await eventually(() => fake.json(progress.messageId).includes('进展 ' + seq),
      { timeoutMs: 8000, label: 'latest progress wins' })
    expect(fake.patches.filter(patch => patch.id === progress.messageId && patch.at >= startedAt).length)
      .toBeLessThanOrEqual(2)
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)

it('FS-20 终态优先：进展节流期间进入 succeeded → HIGH 间隔（1s）内完成终态 patch', async () => {
  const { hub, fake, db, api, cleanup } = await setup()
  const worker = await FakeWorker.connect(hub, { workerId: 'terminal-worker' })
  try {
    await fake.p2p('#scenario: slow ms=60000', { messageId: 'om_c20' })
    const task = db.tasks.getByNo(1)!
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    const ts = Date.now()
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts, kind: 'started', pid: 32, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
    ])
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    await eventually(() => fake.json(progress.messageId).includes('执行中'), { timeoutMs: 8000, label: 'running card' })
    await delay(80)
    worker.events(dispatch.runId, task.id, [
      { seq: 2, ts: ts + 1, kind: 'progress', phase: 'step', detail: '最后一步' },
      { seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 2, summary: '终态结果' },
    ])
    const finishedAt = Date.now()
    await eventually(() => api.getTask(task.id)?.status === 'succeeded', { timeoutMs: 5000, label: 'succeeded' })
    await eventually(() => fake.json(progress.messageId).includes('已完成'), { timeoutMs: 4000, label: 'terminal patch' })
    const terminal = fake.patches.find(patch => patch.id === progress.messageId && patch.at >= finishedAt &&
      JSON.stringify(patch.card).includes('已完成'))
    expect(terminal).toBeTruthy()
    expect(terminal!.at - finishedAt).toBeLessThanOrEqual(1500)
    expect(fake.json(progress.messageId)).toContain('终态结果')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)

it('FS-22 卡片不可更新（撤回/超期）→ 标记 dead=1，任务活动时发送新卡片并更新绑定', async () => {
  const { fake, db, api, cleanup } = await setup({}, { listen: false })
  try {
    await fake.group('卡片失效场景', { messageId: 'om_c22' })
    const task = db.tasks.getByNo(1)!
    const old = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    fake.failPatch = (id, attempt) => id === old.messageId && attempt === 1
      ? { response: { data: { code: 230011, msg: 'message has been recalled' } } }
      : undefined
    await api.approve(task.id, ownerActor, { expectedVersion: task.version })
    await eventually(() => db.feishu.messages(task.id).some(row => row.messageId === old.messageId && row.dead),
      { timeoutMs: 10000, label: 'old card dead' })
    await eventually(() => db.feishu.messages(task.id).filter(row => row.role === 'progress_card' && !row.dead).length === 1,
      { timeoutMs: 10000, label: 'replacement card' })
    const replacement = db.feishu.messages(task.id).find(row => row.role === 'progress_card' && !row.dead)!
    expect(replacement.messageId).not.toBe(old.messageId)
    expect(replacement.chatId).toBe('oc_group')
    expect(replacement.cardTaskVersion).toBe(api.getTask(task.id)!.version)
    expect(fake.json(replacement.messageId)).toContain('排队中')
    assertInvariants(db)
  } finally { await cleanup() }
}, 30000)

it('FS-25 reconnecting 期间状态变化不发 patch；reconnected 后每卡只补推最新一次', async () => {
  const { hub, fake, db, api, cleanup } = await setup({}, { listen: false })
  try {
    await fake.group('重连补推', { messageId: 'om_c25' })
    const task = db.tasks.getByNo(1)!
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    fake.setStatus('reconnecting')
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('reconnecting')
    const startedAt = Date.now()
    await api.approve(task.id, ownerActor, { expectedVersion: task.version })
    await api.cancel(task.id, ownerActor, { expectedVersion: api.getTask(task.id)!.version })
    expect(api.getTask(task.id)!.status).toBe('cancelled')
    await delay(700)
    expect(fake.patches.filter(patch => patch.id === progress.messageId && patch.at >= startedAt)).toHaveLength(0)
    fake.setStatus('connected')
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('connected')
    await eventually(() => fake.json(progress.messageId).includes('已取消'),
      { timeoutMs: 10000, label: 'latest card after reconnect' })
    const after = fake.patches.filter(patch => patch.id === progress.messageId && patch.at >= startedAt)
    expect(after).toHaveLength(1)
    assertInvariants(db)
  } finally { await cleanup() }
}, 30000)

it('SEC-18 Requester 点击审批按钮 → toast 仅负责人可操作，任务状态与卡片均不变', async () => {
  const { fake, db, cleanup } = await setup({}, { listen: false })
  try {
    await fake.group('越权审批', { messageId: 'om_sec18a' })
    const task = db.tasks.getByNo(1)!
    const approval = db.feishu.messages(task.id).find(row => row.role === 'approval_card')!
    const beforeBody = fake.json(approval.messageId)
    const beforeVersion = task.version
    const result = await fake.click(approval.messageId, 'ou_req',
      { v: 1, a: 'approve', t: task.id, ver: task.version }, { eventId: 'sec18a' })
    expect(result.toast).toEqual({ type: 'error', content: '仅负责人可操作' })
    expect(result.card).toBeUndefined()
    expect(db.tasks.get(task.id)!).toMatchObject({ status: 'awaiting_approval', version: beforeVersion })
    expect(fake.json(approval.messageId)).toBe(beforeBody)
    assertInvariants(db)
  } finally { await cleanup() }
}, 20000)

it('SEC-18 Requester 点击 owner_review 发送按钮 → 拒绝，结果仍 pending_review、Requester 未收到', async () => {
  const { hub, fake, db, api, cleanup } = await setup({ requesterReplyPolicy: 'owner_review' })
  const worker = await FakeWorker.connect(hub, { workerId: 'sec18-worker' })
  try {
    await fake.group('审核结果越权', { messageId: 'om_sec18b' })
    const task = db.tasks.getByNo(1)!
    await api.approve(task.id, ownerActor, { expectedVersion: task.version })
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts: Date.now(), kind: 'started', pid: 41, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: Date.now() + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null,
        durationMs: 1, summary: '机密结论 XYZ' },
    ])
    await eventually(() => db.feishu.messages(task.id).some(row => row.role === 'review_card'),
      { timeoutMs: 5000, label: 'review card' })
    const review = db.feishu.messages(task.id).find(row => row.role === 'review_card')!
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    const beforeBody = fake.json(progress.messageId)
    const version = api.getTask(task.id)!.version
    const result = await fake.click(review.messageId, 'ou_req',
      { v: 1, a: 'publish_result', t: task.id, ver: version }, { eventId: 'sec18b' })
    expect(result.toast).toEqual({ type: 'error', content: '仅负责人可操作' })
    expect(db.tasks.get(task.id)!.resultDeliveryStatus).toBe('pending_review')
    expect(db.feishu.messages(task.id).filter(row => row.role === 'result_text')).toHaveLength(0)
    expect(fake.json(progress.messageId)).toBe(beforeBody)
    expect(fake.json(progress.messageId)).not.toContain('机密结论 XYZ')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)

const model: TaskCardModel = { id: 'tsk_' + '0'.repeat(26), taskNo: 7, status: 'running', version: 4, prompt: '渲染结构校验',
  allowedActions: ['cancel'], inputRequest: null, adapter: 'mock', profile: 'edit', workspaceId: 'sandbox',
  scheduleHint: null, attempt: 1, errorCode: null, startedAt: 0, updatedAt: 4000, finishedAt: null,
  resultSummary: '结果摘要', progress: ['第一步'], panelUrl: 'https://hub.test/tasks/1', resultDeliveryStatus: 'not_required' }

it('FS-24 全部卡片状态 × 受众结构校验：Card JSON 2.0、update_multi、体积与动作值合法', () => {
  const validate = (card: Record<string, unknown>) => {
    expect(card.schema).toBe('2.0')
    expect(card.config).toMatchObject({ update_multi: true, width_mode: 'fill' })
    const header = card.header as { title?: { tag?: string; content?: string } } | undefined
    expect(header?.title?.tag).toBe('plain_text')
    expect(typeof header?.title?.content).toBe('string')
    const body = card.body as { elements?: unknown[] } | undefined
    expect(Array.isArray(body?.elements)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(28 * 1024)
    expect(JSON.parse(JSON.stringify(card))).toEqual(card)
    for (const button of cardButtons(card as never)) {
      const behaviors = button.behaviors as Array<{ type: string; value?: unknown }> | undefined
      for (const behavior of behaviors ?? []) {
        if (behavior.type !== 'callback') continue
        expect(CardActionValue.safeParse(behavior.value).success).toBe(true)
      }
    }
  }
  for (const audience of ['owner', 'requester'] as const) {
    for (const status of TaskStatus.options) {
      const allowedActions: TaskCardModel['allowedActions'] = []
      if (['awaiting_approval', 'queued', 'running'].includes(status)) allowedActions.push('cancel')
      if (status === 'awaiting_input') allowedActions.push('input')
      if (audience === 'owner' && ['failed', 'timed_out'].includes(status)) allowedActions.push('retry')
      validate(renderProgressCard({ ...model, status, allowedActions,
        inputRequest: status === 'awaiting_input'
          ? { requestId: 'q1', question: '请确认', options: ['继续', '停止'], expiresAt: 10_000 } : null }, audience))
    }
  }
  for (const status of ['awaiting_approval', 'queued', 'running', 'rejected', 'cancelled'] as const) {
    validate(renderApprovalCard({ ...model, status }, { adapters: ['mock'], workspaces: ['sandbox'], profiles: ['readonly', 'edit'] }))
  }
  for (const resultDeliveryStatus of ['pending_review', 'delivered', 'suppressed'] as const) {
    validate(renderOwnerReviewCard({ ...model, status: 'succeeded', resultDeliveryStatus }))
  }
  validate(renderWorkersCard([{ id: 'w1', displayName: 'W1', connection: 'online', slotsUsed: 0, maxConcurrency: 2,
    adapters: [{ id: 'mock', status: 'ready', version: '1', features: { resume: true, liveInput: true, structuredOutput: true } }],
    workspaces: [{ id: 'sandbox', label: 'Sandbox', allowedAdapters: ['mock'], maxProfile: 'edit', maxConcurrent: 1, isGitRepo: true }],
    drain: false, lastSeenAt: 0, graceUntil: null }]))
  validate(renderTaskListCard([{ id: model.id, taskNo: 7, version: 1, title: '标题', status: 'running',
    priority: 0, requester: { type: 'owner', id: 'ou_owner', channel: 'feishu' }, origin: { source: 'feishu' },
    adapter: 'mock', workspaceId: 'sandbox', profile: 'edit', workerId: 'w1', attempt: 1, maxAttempts: 3,
    parentTaskId: null, lastProgress: null, scheduleHint: null, workerConnection: 'online', graceUntil: null,
    errorCode: null, resultDeliveryStatus: 'not_required', createdAt: 0, updatedAt: 0, startedAt: null,
    finishedAt: null, allowedActions: ['cancel'] }], 'requester'))
})
