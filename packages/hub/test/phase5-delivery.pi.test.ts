/**
 * Pi 独立验收 · Phase 5 结果回传策略（FS-26）与运维隔离（凭据失败 / drain）。
 */
import { expect, it } from 'vitest'
import type { RunDispatch } from '@agent-hub/protocol'
import { assertInvariants, delay, eventually, FakeWorker, ownerActor } from './pi/harness.js'
import { openHarness } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { FiberState } from '../src/kernel/fiber-state.js'

const base = {
  enabled: true,
  ownerOpenIds: ['ou_owner'],
  requesterAllowlist: ['ou_req'],
  requesterPolicy: 'chat' as const,
  allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox',
}
const reviewConfig = { ...base, requesterReplyPolicy: 'owner_review' as const,
  card: { minPatchIntervalMs: 3000, minPatchIntervalHighMs: 10, globalPatchQps: 5, cardResultMaxChars: 5, cardMaxBytes: 28672 } }

async function reviewSetup() {
  const fake = new PiFeishuTransport()
  const opened = await openHarness({ feishu: reviewConfig }, { feishuTransport: fake })
  const db = opened.hub.ctx.store.repos
  return { ...opened, fake, db, api: opened.hub.ctx.orchestrator }
}

async function succeed(fake: PiFeishuTransport, hub: Awaited<ReturnType<typeof reviewSetup>>['hub'],
  worker: FakeWorker, messageId: string, summary: string) {
  await fake.group('生成需要审核的结果', { messageId })
  const task = hub.ctx.store.repos.tasks.getByNo(1)!
  await hub.ctx.orchestrator.approve(task.id, ownerActor, { expectedVersion: task.version })
  const dispatch = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === task.id)
  const run = dispatch.payload as RunDispatch
  worker.events(run.runId, task.id, [
    { seq: 1, ts: Date.now(), kind: 'started', pid: 61, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
    { seq: 2, ts: Date.now() + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null,
      durationMs: 1, summary },
  ])
  await eventually(() => hub.ctx.store.repos.tasks.get(task.id)?.resultDeliveryStatus === 'pending_review',
    { timeoutMs: 5000, label: 'pending_review' })
  return task
}

it('FS-26 owner_review：结果先到 Owner 审核卡，Owner 点「发送给对方」后 Requester 才收到，重复点击幂等', async () => {
  const { hub, fake, db, api, cleanup } = await reviewSetup()
  const worker = await FakeWorker.connect(hub, { workerId: 'review-card-worker' })
  const summary = 'SECRET-RESULT-ONLY-AFTER-REVIEW'
  try {
    const task = await succeed(fake, hub, worker, 'om_review_send', summary)
    const rows = () => db.feishu.messages(task.id)
    await eventually(() => rows().some(row => row.role === 'review_card'), { timeoutMs: 5000, label: 'review card' })
    const review = rows().find(row => row.role === 'review_card')!
    const progress = rows().find(row => row.role === 'progress_card')!
    expect(fake.messages.get(review.messageId)!.target).toBe('ou_owner')
    expect(fake.json(review.messageId)).toContain(summary)
    expect(fake.json(progress.messageId)).not.toContain(summary)
    expect(fake.json(progress.messageId)).toContain('结果等待负责人审核')
    expect(rows().filter(row => row.role === 'result_text')).toHaveLength(0)

    const version = api.getTask(task.id)!.version
    const result = await fake.click(review.messageId, 'ou_owner',
      { v: 1, a: 'publish_result', t: task.id, ver: version }, { eventId: 'review:send' })
    expect(result.toast.type).toBe('success')
    await eventually(() => db.tasks.get(task.id)?.resultDeliveredAt !== null, { timeoutMs: 6000, label: 'delivered' })
    expect(db.tasks.get(task.id)!.resultDeliveryStatus).toBe('delivered')
    const delivered = rows().filter(row => row.role === 'result_text')
    expect(delivered).toHaveLength(1)
    expect(fake.text(delivered[0]!.messageId)).toBe(summary)
    expect(fake.messages.get(delivered[0]!.messageId)).toMatchObject({ target: 'om_review_send', reply: true })
    await eventually(() => fake.json(progress.messageId).includes('SECRE'), { timeoutMs: 6000, label: 'requester result card' })

    // 重复点击：幂等，不重复发送
    const duplicate = await fake.click(review.messageId, 'ou_owner',
      { v: 1, a: 'publish_result', t: task.id, ver: version }, { eventId: 'review:send-again' })
    expect(duplicate.toast).toEqual({ type: 'info', content: '已处理' })
    await delay(200)
    expect(rows().filter(row => row.role === 'result_text')).toHaveLength(1)
    // 面板重复投递同样幂等
    const token = hub.ctx.auth.createApiToken('pi', ['admin'])
    const again = await hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/tasks/' + task.id + '/deliver-result',
      headers: { authorization: 'Bearer ' + token }, payload: { action: 'send', expectedVersion: api.getTask(task.id)!.version } })
    expect(again.statusCode).toBe(200)
    expect(rows().filter(row => row.role === 'result_text')).toHaveLength(1)
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)

it('FS-26 owner_review：面板 deliver-result 发送后 Requester 才收到结果', async () => {
  const { hub, fake, db, api, cleanup } = await reviewSetup()
  const worker = await FakeWorker.connect(hub, { workerId: 'review-panel-worker' })
  const summary = 'PANEL-REVIEWED-RESULT'
  try {
    const task = await succeed(fake, hub, worker, 'om_review_panel', summary)
    const rows = () => db.feishu.messages(task.id)
    await eventually(() => rows().some(row => row.role === 'review_card'), { timeoutMs: 5000, label: 'review card' })
    const progress = rows().find(row => row.role === 'progress_card')!
    expect(fake.json(progress.messageId)).not.toContain(summary)
    const token = hub.ctx.auth.createApiToken('pi', ['admin'])
    const response = await hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/tasks/' + task.id + '/deliver-result',
      headers: { authorization: 'Bearer ' + token },
      payload: { action: 'send', expectedVersion: api.getTask(task.id)!.version } })
    expect(response.statusCode).toBe(200)
    await eventually(() => rows().some(row => row.role === 'result_text'), { timeoutMs: 6000, label: 'result delivered' })
    expect(fake.text(rows().find(row => row.role === 'result_text')!.messageId)).toBe(summary)
    await eventually(() => fake.json(progress.messageId).includes('PANEL'), { timeoutMs: 6000, label: 'requester card' })
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)

it('FS-26 owner_review：点「不发送」→ suppressed，Requester 只见“负责人未发送结果”且无结果正文', async () => {
  const { hub, fake, db, api, cleanup } = await reviewSetup()
  const worker = await FakeWorker.connect(hub, { workerId: 'review-suppress-worker' })
  const summary = 'SUPPRESSED-RESULT-TEXT'
  try {
    const task = await succeed(fake, hub, worker, 'om_review_suppress', summary)
    const rows = () => db.feishu.messages(task.id)
    await eventually(() => rows().some(row => row.role === 'review_card'), { timeoutMs: 5000, label: 'review card' })
    const review = rows().find(row => row.role === 'review_card')!
    const progress = rows().find(row => row.role === 'progress_card')!
    const result = await fake.click(review.messageId, 'ou_owner',
      { v: 1, a: 'suppress_result', t: task.id, ver: api.getTask(task.id)!.version }, { eventId: 'review:suppress' })
    expect(result.toast).toEqual({ type: 'success', content: '已选择不发送' })
    await eventually(() => db.tasks.get(task.id)?.resultDeliveryStatus === 'suppressed', { timeoutMs: 5000, label: 'suppressed' })
    await eventually(() => fake.json(progress.messageId).includes('负责人未发送结果'),
      { timeoutMs: 6000, label: 'suppressed card' })
    expect(fake.json(progress.messageId)).not.toContain(summary)
    expect(rows().filter(row => row.role === 'result_text')).toHaveLength(0)
    expect(db.tasks.get(task.id)!.resultDeliveredAt).toBeNull()
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)

it('飞书凭据缺失 → 非关键插件隔离：/readyz 200、overview.feishu.state=failed、Hub 其余功能正常', async () => {
  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  delete process.env.FEISHU_APP_ID
  delete process.env.FEISHU_APP_SECRET
  const { hub, cleanup } = await openHarness({ feishu: base }, { listen: false })
  try {
    await eventually(() => hub.ctx.orchestrator.overview().feishu.state === 'failed',
      { timeoutMs: 5000, label: 'feishu failed' })
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('failed')
    expect(hub.fibers.get('feishu')!.state).toBe(FiberState.FAILED)
    expect((await hub.ctx.http.app.inject('/readyz')).statusCode).toBe(200)
    const task = await hub.ctx.orchestrator.createTask({ prompt: '凭据缺失时仍可建任务', workspaceId: 'sandbox' }, ownerActor)
    expect(task.status).toBe('queued')
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('failed')
    assertInvariants(hub.ctx.store.repos)
  } finally {
    await cleanup()
    if (appId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = appId
    if (appSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = appSecret
  }
}, 30000)

it('hub/drain：新消息回复「系统维护中」、卡片回调拒绝、终态卡片被冲刷', async () => {
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: base }, { feishuTransport: fake })
  const worker = await FakeWorker.connect(hub, { workerId: 'drain-worker' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    // drain 前先创建一张待审批卡片，用于验证 drain 期间回调被拒绝
    await fake.group('drain 期间的审批卡片', { messageId: 'om_drain_approval' })
    const approvalTask = db.tasks.getByNo(1)!
    const approvalRow = db.feishu.messages(approvalTask.id).find(row => row.role === 'approval_card')!
    await fake.p2p('#scenario: slow ms=60000', { messageId: 'om_drain' })
    const task = db.tasks.getByNo(2)!
    const dispatch = (await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === task.id)).payload as RunDispatch
    const ts = Date.now()
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts, kind: 'started', pid: 71, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
    ])
    await eventually(() => api.getTask(task.id)?.status === 'running', { timeoutMs: 5000 })
    const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    const patchesBefore = fake.patches.filter(patch => patch.id === progress.messageId).length
    worker.events(dispatch.runId, task.id, [
      { seq: 2, ts: ts + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null,
        durationMs: 1, summary: 'drain 前完成' },
    ])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded', { timeoutMs: 5000 })
    const startedAt = Date.now()
    await hub.ctx.parallel('hub/drain')
    expect(Date.now() - startedAt).toBeLessThanOrEqual(3500)
    expect(api.overview().hub.draining).toBe(true)
    expect(fake.json(progress.messageId)).toContain('已完成')
    expect(fake.patches.filter(patch => patch.id === progress.messageId).length).toBeGreaterThan(patchesBefore)
    // 新消息 → 系统维护中
    await fake.p2p('维护期间的新需求', { messageId: 'om_draining_new' })
    expect(fake.text(fake.order.at(-1)!)).toBe('系统维护中，请稍后重试')
    // 卡片回调 → 系统维护中
    const result = await fake.click(approvalRow.messageId, 'ou_owner',
      { v: 1, a: 'approve', t: approvalTask.id, ver: api.getTask(approvalTask.id)!.version })
    expect(result.toast).toEqual({ type: 'info', content: '系统维护中，请稍后重试' })
    expect(api.getTask(approvalTask.id)!.status).toBe('awaiting_approval')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)
