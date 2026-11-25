import { expect, it, vi } from 'vitest'
import { FakeFeishuTransport } from './fake-feishu-transport.js'
import { FakeWorker, openHarness } from './pi/harness.js'
import { TaskStatus } from '@agent-hub/protocol'
import type { RunDispatch } from '@agent-hub/protocol'
import { renderProgressCard } from '../src/plugins/channel-feishu/cards/index.js'
import type { TaskCardModel } from '../src/plugins/channel-feishu/cards/index.js'
import { CardUpdater } from '../src/plugins/channel-feishu/card-updater.js'

const settings = { minPatchIntervalMs: 3000, minPatchIntervalHighMs: 1000, globalPatchQps: 5, cardResultMaxChars: 2000, cardMaxBytes: 28672 }
const config = { enabled: true, ownerOpenIds: ['ou_owner'], requesterPolicy: 'chat', allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox', card: { ...settings, minPatchIntervalHighMs: 10 } }
const value = (id: string, version: number, a: string) => ({ v: 1, t: id, ver: version, a })

it.each(['auto', 'dashboard_send', 'card_send', 'card_suppress'])('group approval, execution, %s delivery and session follow-up', async mode => {
  const policy = mode === 'auto' ? 'auto' : 'owner_review'
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { ...config, card: { ...config.card, cardResultMaxChars: 3 }, requesterReplyPolicy: policy } }, { feishuTransport: fake })
  const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
  const worker = await FakeWorker.connect(hub, { workerId: 'fs-worker' })
  try {
    await fake.message('ignored', 'ignored', 'ou_req', { mentions: [] })
    expect(api.getTask('1')).toBeUndefined()
    await fake.message('request', '@_user_1 测试')
    await fake.message('request', '@_user_1 测试')
    const task = api.getTask('1')!
    expect(task).toMatchObject({ status: 'awaiting_approval', profile: 'edit', prompt: '测试' })
    expect(api.getTask('2')).toBeUndefined()
    const rows = () => db.feishu.messages(task.id)
    const approval = rows().find(r => r.role === 'approval_card')!.messageId
    const progress = rows().find(r => r.role === 'progress_card')!.messageId
    expect(fake.messages.get(approval)).toMatchObject({ target: 'ou_owner', reply: false })
    expect(fake.messages.get(progress)).toMatchObject({ target: 'request', reply: true })
    const cmd = value(task.id, task.version, 'approve')
    expect((await fake.click(approval, 'ou_req', cmd)).toast.content).toBe('仅负责人可操作')
    const token = hub.ctx.auth.createApiToken('test', ['admin'])
    const post = (action: string, body: object) => hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/tasks/' + task.id + '/' + action,
      headers: { authorization: 'Bearer ' + token }, payload: body })
    const [clicks, http] = await Promise.all([Promise.all(Array.from({ length: 10 }, () => fake.click(approval, 'ou_owner', cmd))),
      post('approve', { expectedVersion: task.version })])
    expect(clicks.filter(c => c.toast.type === 'success').length + Number(http.statusCode === 200)).toBe(1)
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    expect(dispatch.profile).toBe('edit')
    expect(worker.frames.filter(f => f.type === 'run.dispatch')).toHaveLength(1)
    expect((await fake.click(approval, 'ou_owner', cmd)).card?.type).toBe('raw')
    const ts = Date.now()
    worker.send('run.events', { runId: dispatch.runId, taskId: task.id, events: [
      { seq: 1, ts, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'internal' },
      { seq: 2, ts, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 1, summary: '测试完成', cliSessionId: 'session-one' },
    ] })
    await expect.poll(() => api.getTask(task.id)?.status).toBe('succeeded')
    if (policy === 'owner_review') {
      await expect.poll(() => rows().some(r => r.role === 'review_card')).toBe(true)
      expect(JSON.stringify(fake.messages.get(progress))).not.toContain('测试完成')
      const review = rows().find(r => r.role === 'review_card')!
      expect(fake.messages.get(review.messageId)?.target).toBe('ou_owner')
      const ver = api.getTask(task.id)!.version
      expect(rows().filter(r => r.role === 'result_text')).toHaveLength(0)
      if (mode === 'dashboard_send') expect((await post('deliver-result', { action: 'send', expectedVersion: ver })).statusCode).toBe(200)
      else {
        const a = mode === 'card_suppress' ? 'suppress_result' : 'publish_result'
        const res = await fake.click(review.messageId, 'ou_owner', value(task.id, ver, a))
        expect(res.toast.type).toBe('success')
        if (mode === 'card_suppress') {
          expect(api.getTask(task.id)?.resultDeliveryStatus).toBe('suppressed')
          await expect.poll(() => JSON.stringify(fake.messages.get(progress)?.body)).toContain('未发送')
          expect(rows().filter(r => r.role === 'result_text')).toHaveLength(0)
          return
        }
      }
      expect(db.tasks.get(task.id)?.resultDeliveredAt).not.toBeNull()
    }
    await expect.poll(() => JSON.stringify(fake.messages.get(progress)?.body)).toContain('测试完')
    await expect.poll(() => rows().filter(r => r.role === 'result_text').length).toBe(1)
    const supplement = rows().find(r => r.role === 'result_text')!
    expect(fake.messages.get(supplement.messageId)?.body).toEqual({ type: 'text', text: '测试完成' })
    await fake.message('other', '追问', 'someone', { parent_id: progress })
    expect(api.getTask('2')).toBeUndefined()
    await fake.message('follow', '追问', 'ou_req', { parent_id: 'unknown-parent', root_id: progress })
    const child = db.tasks.getByNo(2)!
    expect(child).toMatchObject({ parentTaskId: task.id, requiredWorkerId: 'fs-worker', resumeSessionId: 'session-one', profile: 'edit', adapter: 'mock' })
    const nextApproval = db.feishu.messages(child.id).find(m => m.role === 'approval_card')!
    await fake.click(nextApproval.messageId, 'ou_owner', value(child.id, child.version, 'approve'))
    const next = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === child.id)
    expect(next.payload).toMatchObject({ workspaceId: 'sandbox', adapter: 'mock', resume: { cliSessionId: 'session-one' } })
  } finally { worker.terminate(); await cleanup() }
}, 20000)

it('filters stale, unsupported and unauthorized messages and allows private whoami', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake, listen: false })
  try {
    const dm = { chat_type: 'p2p', chat_id: 'oc_private' } as const
    await fake.message('a', 'hello', 'stranger', dm)
    await fake.message('b', 'hello', 'stranger', dm)
    await fake.message('who', '/whoami', 'stranger', dm)
    await fake.message('stale', 'hello', 'ou_owner', { ...dm, create_time: Date.now() - 610000 })
    await fake.message('image', 'hello', 'ou_owner', { ...dm, message_type: 'image' })
    await expect.poll(() => [...fake.messages.values()].filter(m => m.target === 'ou_owner').length).toBe(1)
    expect([...fake.messages.values()].map(m => m.body)).toEqual(expect.arrayContaining([
      { type: 'text', text: 'stranger' }, { type: 'text', text: '暂仅支持文本需求' }, { type: 'text', text: '暂无使用权限，请联系管理员' }]))
    expect(fake.messages.size).toBe(4)
    expect(hub.ctx.orchestrator.getTask('1')).toBeUndefined()
    await hub.ctx.parallel('hub/drain')
    await fake.message('drain', 'test', 'ou_owner', dm)
    expect([...fake.messages.values()].at(-1)?.body).toMatchObject({ text: '系统维护中，请稍后重试' })
  } finally { await cleanup() }
}, 10000)

it('replaces a recalled active card and reconciles once when the socket reconnects', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake, listen: false })
  try {
    await fake.message('request', 'task')
    const task = hub.ctx.orchestrator.getTask('1')!
    const rows = () => hub.ctx.store.repos.feishu.messages(task.id).filter(r => r.role === 'progress_card')
    const old = rows()[0]!
    const patch = fake.patchCard.bind(fake)
    vi.spyOn(fake, 'patchCard').mockImplementation(async (id, card) => {
      if (id === old.messageId) throw { response: { data: { code: 230011 } } }
      return patch(id, card)
    })
    fake.setStatus('reconnecting')
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('reconnecting')
    await hub.ctx.orchestrator.approve(task.id, { id: 'owner', type: 'owner', channel: 'dashboard' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fake.patchCard).not.toHaveBeenCalled()
    fake.setStatus('connected')
    await expect.poll(() => rows().length, { timeout: 3000 }).toBe(2)
    expect(rows().find(m => m.messageId === old.messageId)?.dead).toBe(true)
    const replacement = rows().find(m => !m.dead)!
    expect(JSON.stringify(fake.messages.get(replacement.messageId)?.body)).toContain('排队中')
  } finally { await cleanup() }
})

it('treats the Feishu fiber as noncritical and applies hot configuration without reconnecting', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake, listen: false })
  try {
    const fiber = hub.fibers.get('feishu')!
    const start = vi.spyOn(fake, 'start')
    await fiber.update({ ...fiber.config, defaultWorkspaceId: 'backend' })
    await fake.message('new', '任务')
    expect(hub.ctx.orchestrator.getTask('1')?.workspaceId).toBe('backend')
    expect(start).not.toHaveBeenCalled()
    await fiber.update({ ...fiber.config, domain: 'lark' })
    expect(start).toHaveBeenCalledTimes(1)
    fake.setStatus('failed')
    await expect.poll(() => fiber.state).toBe(3)
    expect((await hub.ctx.http.app.inject('/readyz')).statusCode).toBe(200)
    expect(hub.ctx.orchestrator.overview().feishu.state).toBe('failed')
    await expect.poll(() => hub.ctx.orchestrator.overview().feishu.state, { timeout: 7000 }).toBe('connected')
  } finally { await cleanup() }
}, 12000)

it('handles referenced input, status, terminal-without-session, group whoami and parent precedence', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake })
  const worker = await FakeWorker.connect(hub, { workerId: 'input-worker' })
  try {
    const dm = { chat_type: 'p2p', chat_id: 'owner-chat' } as const
    const post = { en_us: { content: [[{ tag: 'text', text: 'check ' }, { tag: 'a', text: 'this' }]] } }
    await fake.message('rich', '', 'ou_owner', { ...dm, message_type: 'post', content: JSON.stringify(post) })
    const task = hub.ctx.orchestrator.getTask('1')!
    expect(task.prompt).toBe('check this')
    const run = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    const ts = Date.now()
    worker.events(run.runId, task.id, [
      { seq: 1, ts, kind: 'started', pid: 42, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'internal' },
      { seq: 2, ts, kind: 'input_request', requestId: 'question', question: '继续吗', options: ['是', '否'] }])
    await expect.poll(() => hub.ctx.orchestrator.getTask(task.id)?.status).toBe('awaiting_input')
    await fake.message('answer', '是', 'ou_owner', { ...dm, parent_id: 'rich' })
    expect((await worker.waitFor('run.input')).payload).toMatchObject({ requestId: 'question', answer: '是' })
    await fake.message('active', '进展', 'ou_owner', { ...dm, root_id: 'rich' })
    expect([...fake.messages.values()].at(-1)?.body).toMatchObject({ text: '任务进行中，完成后再回复可继续对话' })
    worker.events(run.runId, task.id, [{ seq: 3, ts, kind: 'finished', status: 'succeeded', exitCode: 0,
      durationMs: 1, signal: null, summary: 'done' }])
    await expect.poll(() => hub.ctx.orchestrator.getTask(task.id)?.status).toBe('succeeded')
    await fake.message('retry', '新需求', 'ou_owner', { ...dm, parent_id: 'rich' })
    expect(hub.ctx.store.repos.tasks.getByNo(2)).toMatchObject({ parentTaskId: task.id, resumeSessionId: null })
    expect([...fake.messages.values()].at(-1)?.body).toMatchObject({ text: '无法续接上下文，已新建关联任务' })
    await fake.message('group-who', '/whoami', 'ou_owner')
    expect([...fake.messages.values()].at(-1)?.body).toMatchObject({ text: '请私聊使用 /whoami' })
    await fake.message('status', '/status #1', 'ou_owner', dm)
    expect(JSON.stringify([...fake.messages.values()].at(-1)?.body)).toContain('已完成')
  } finally { worker.terminate(); await cleanup() }
}, 15000)

it('routes slash commands through permission, policy, lookup and worker services', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake })
  const worker = await FakeWorker.connect(hub, { workerId: 'command-worker' })
  try {
    let n = 0
    const command = (text: string, user = 'ou_owner') => fake.message('cmd-' + ++n, text, user, { chat_id: user === 'ou_owner' ? 'oc_' + n : 'oc_group' })
    const latest = () => JSON.stringify([...fake.messages.values()].at(-1)?.body)
    await command('/help')
    expect(latest()).toContain('/approve')
    await command('/workers')
    expect(latest()).toContain('command-worker')
    await command('/drain command-worker on')
    expect(hub.ctx.workers.get('command-worker')?.drain).toBe(true)
    await command('/run --worker=command-worker refuse', 'ou_req')
    expect(hub.ctx.orchestrator.getTask('1')).toBeUndefined()
    await command('/run --ws=backend --cli=mock first', 'ou_req')
    const first = hub.ctx.orchestrator.getTask('1')!
    expect(first).toMatchObject({ workspaceId: 'backend', adapter: 'mock', profile: 'edit', status: 'awaiting_approval' })
    await fake.message('ref', '补充', 'ou_req', { parent_id: 'cmd-5' })
    expect(latest()).toContain('任务未执行')
    await command('/tasks mine', 'ou_req')
    expect(latest()).toContain('first')
    await command('/reject #1 无需执行')
    expect(hub.ctx.orchestrator.getTask('1')?.status).toBe('rejected')
    await command('/run second', 'ou_req')
    await command('/approve #2')
    expect(hub.ctx.orchestrator.getTask('2')?.status).toBe('queued')
    await command('/cancel #2', 'ou_req')
    expect(hub.ctx.orchestrator.getTask('2')?.status).toBe('cancelled')
    await command('/retry #2')
    expect(hub.ctx.orchestrator.getTask('2')?.status).toBe('queued')
    await command('/status')
    expect(latest()).toContain('second')
    await command('/drain command-worker off')
    expect(hub.ctx.workers.get('command-worker')?.drain).toBe(false)
  } finally { worker.terminate(); await cleanup() }
}, 15000)

it('returns a toast on budget expiry and patches when approval completes', async () => {
  const fake = new FakeFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: config }, { feishuTransport: fake, listen: false })
  try {
    await fake.message('request', 'task')
    const task = hub.ctx.orchestrator.getTask('1')!
    const id = hub.ctx.store.repos.feishu.messages(task.id).find(m => m.role === 'approval_card')!.messageId
    const api = hub.ctx.orchestrator
    const approve = api.approve.bind(api)
    const stub = vi.spyOn(api, 'approve').mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 2500))
      return approve(...args)
    })
    const start = Date.now()
    const first = fake.click(id, 'ou_owner', value(task.id, task.version, 'approve'))
    await expect(fake.click(id, 'ou_owner', value(task.id, task.version, 'approve'))).resolves.toMatchObject({ toast: { content: '正在处理，请稍候' } })
    await expect(first).resolves.toEqual({ toast: { type: 'info', content: '已提交' } })
    expect(Date.now() - start).toBeLessThan(2900)
    await expect.poll(() => JSON.stringify(fake.messages.get(id)?.body)).toContain('已批准')
    expect(stub).toHaveBeenCalledTimes(1)
    stub.mockRestore()
  } finally { await cleanup() }
}, 8000)

const model: TaskCardModel = { id: 'tsk_' + '0'.repeat(26), taskNo: 1, status: 'running', version: 3, prompt: '检查任务',
  allowedActions: ['cancel'], inputRequest: null, adapter: 'mock', profile: 'edit', workspaceId: 'test', scheduleHint: null,
  attempt: 1, errorCode: null, startedAt: 0, updatedAt: 4000, finishedAt: null, resultSummary: '完成检查',
  progress: ['第一步', '执行 npm test', '查看 C:\\internal\\job'], panelUrl: 'https://internal.test/tasks/1', resultDeliveryStatus: 'not_required' }
for (const audience of ['owner', 'requester'] as const) {
  it('snapshots progress states for ' + audience, () => {
    const cards = TaskStatus.options.map(status => {
      const allowedActions: TaskCardModel['allowedActions'] = []
      if (['awaiting_approval', 'queued', 'running'].includes(status)) allowedActions.push('cancel')
      if (status === 'awaiting_input') allowedActions.push('input')
      if (audience === 'owner' && ['failed', 'timed_out'].includes(status)) allowedActions.push('retry')
      return renderProgressCard({ ...model, status, allowedActions, inputRequest: status === 'awaiting_input'
        ? { requestId: 'q1', question: '请确认', options: ['继续', '停止'], expiresAt: 12000 } : null }, audience)
    })
    expect(cards).toMatchSnapshot()
    if (audience === 'requester') expect(JSON.stringify(cards)).not.toMatch(/internal|npm test/)
    const oversized = renderProgressCard({ ...model, prompt: '需'.repeat(32000), status: 'succeeded', resultSummary: '好'.repeat(12000) }, audience)
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThanOrEqual(28672)
  })
}

it('halves patch throughput for five minutes after three independent rate limits', async () => {
  vi.useFakeTimers()
  let calls = 0
  const transport = { patchCard: async () => { if (++calls <= 3) throw { status: 429 } } }
  const updater = new CardUpdater(transport, settings, { sent: vi.fn(), dead: vi.fn(), warn: vi.fn() })
  const burst = (prefix: string) => {
    for (let i = 0; i < 24; i++) updater.desire(prefix + i, { card: { i }, version: 1, terminal: false }, false)
  }
  try {
    burst('first')
    await vi.advanceTimersByTimeAsync(1950)
    expect(calls).toBeGreaterThanOrEqual(13)
    expect(calls).toBeLessThanOrEqual(14) // 10 burst plus at most four replenished tokens
    await vi.advanceTimersByTimeAsync(300000)
    const before = calls
    burst('second')
    await vi.advanceTimersByTimeAsync(1950)
    expect(calls - before).toBeGreaterThanOrEqual(18)
    expect(calls - before).toBeLessThanOrEqual(19)
  } finally { updater.close(); vi.useRealTimers() }
})

it('coalesces 200 updates, observes patch backoff, reconnect and dead-card handling', async () => {
  vi.useFakeTimers()
  const patchCard = vi.fn(async (_id: string, card: object) => { void card })
  const dead = vi.fn(async () => {})
  const updater = new CardUpdater({ patchCard }, settings, { sent: vi.fn(), dead, warn: vi.fn() })
  try {
    updater.setPaused(true)
    for (let i = 0; i < 200; i++) updater.desire('om', { card: { i }, version: 1, terminal: false }, false)
    await vi.advanceTimersByTimeAsync(4000)
    expect(patchCard).not.toHaveBeenCalled()
    patchCard.mockRejectedValueOnce({ response: { status: 429 } }).mockRejectedValueOnce({ code: 99991400 })
    updater.setPaused(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(patchCard).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1998)
    expect(patchCard).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(patchCard).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(patchCard).toHaveBeenLastCalledWith('om', { i: 199 })
    updater.desire('om', { card: { newest: true }, version: 2, terminal: true }, true)
    patchCard.mockRejectedValueOnce({ code: 230011 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(dead).toHaveBeenCalledWith('om')
  } finally { updater.close(); vi.useRealTimers() }
})
