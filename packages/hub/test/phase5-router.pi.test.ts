/**
 * Pi 独立验收 · Phase 5 消息预处理、身份与路由
 * 覆盖 FS-7 ~ FS-15、FS-27、SEC-19、SEC-20。
 */
import { expect, it } from 'vitest'
import type { RunDispatch } from '@agent-hub/protocol'
import { assertInvariants, eventually, FakeWorker } from './pi/harness.js'
import { openHarness } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'

const config = {
  enabled: true,
  ownerOpenIds: ['ou_owner'],
  requesterAllowlist: ['ou_req'],
  requesterPolicy: 'chat' as const,
  allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox',
}
const owner = { type: 'owner' as const, id: 'dashboard:owner', channel: 'dashboard' as const }
const at = () => Date.now()

async function hubWithFake(extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const fake = new PiFeishuTransport()
  const opened = await openHarness({ feishu: { ...config, ...extra } }, { feishuTransport: fake, ...options })
  return { ...opened, fake }
}

it('FS-7 群聊未 @ 机器人 / 机器人消息 → 静默忽略，不建任务', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.group('没有 at 机器人', { messageId: 'om_no_mention', mentions: [] })
    await fake.group('@_user_1 机器人自己发的', { messageId: 'om_bot', senderType: 'app',
      mentions: [{ id: { open_id: fake.bot.openId } }] })
    await fake.group('@_user_9 提到了别人', { messageId: 'om_other_mention', mentions: [{ id: { open_id: 'ou_someone' } }] })
    expect(hub.ctx.store.repos.tasks.getByNo(1)).toBeUndefined()
    expect(fake.messages.size).toBe(0)
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-8 群聊 @ 机器人 + 文本 → 去除 @ 占位建任务，进度卡片引用回复原消息并落库', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.group('@_user_1   修复登录页在 Safari 下的样式错位  ', { messageId: 'om_requirement' })
    const task = hub.ctx.store.repos.tasks.getByNo(1)!
    expect(task).toMatchObject({ status: 'awaiting_approval', prompt: '修复登录页在 Safari 下的样式错位',
      source: 'feishu', requesterId: 'ou_req', requesterType: 'requester' })
    const rows = hub.ctx.store.repos.feishu.messages(task.id)
    const request = rows.find(row => row.role === 'request')!
    expect(request).toMatchObject({ messageId: 'om_requirement', chatId: 'oc_group', chatType: 'group' })
    const progress = rows.find(row => row.role === 'progress_card')!
    expect(progress).toMatchObject({ chatId: 'oc_group', chatType: 'group', audience: 'requester', dead: false })
    const sent = fake.messages.get(progress.messageId)!
    expect(sent).toMatchObject({ target: 'om_requirement', reply: true })
    const card = fake.messages.get(progress.messageId)!.body
    if (card.type !== 'interactive') throw new Error('progress card is not interactive')
    expect((card.card.header as { title: { content: string } }).title.content).toBe('#1 · 等待负责人审批')
    expect(fake.json(progress.messageId)).toContain('修复登录页在 Safari 下的样式错位')
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-9 私聊 Owner 自然语言 → 直接 queued，不发审批卡片', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.p2p('帮我看下构建失败的日志', { messageId: 'om_owner_dm' })
    const task = hub.ctx.store.repos.tasks.getByNo(1)!
    expect(task).toMatchObject({ status: 'queued', requesterType: 'owner', requesterId: 'ou_owner' })
    const rows = hub.ctx.store.repos.feishu.messages(task.id)
    expect(rows.filter(row => row.role === 'approval_card')).toHaveLength(0)
    const progress = rows.find(row => row.role === 'progress_card')!
    expect(progress.audience).toBe('owner')
    expect(fake.json(progress.messageId)).toContain('#1 · 排队中')
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-10 Requester 需求 → 群内「等待审批」进度卡片 + Owner 私聊审批卡片（form 选框与批准/驳回）', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.group('把导出功能做成异步任务', { messageId: 'om_requester_dm' })
    const task = hub.ctx.store.repos.tasks.getByNo(1)!
    expect(task).toMatchObject({ status: 'awaiting_approval', profile: 'edit' })
    const rows = hub.ctx.store.repos.feishu.messages(task.id)
    const progress = rows.find(row => row.role === 'progress_card')!
    const approval = rows.find(row => row.role === 'approval_card')!
    expect(progress.audience).toBe('requester')
    expect(fake.json(progress.messageId)).toContain('等待负责人审批')
    expect(approval).toMatchObject({ chatId: 'ou_owner', chatType: 'p2p', audience: 'owner' })
    const sent = fake.messages.get(approval.messageId)!
    expect(sent).toMatchObject({ target: 'ou_owner', reply: false })
    const card = fake.messages.get(approval.messageId)!.body
    expect(card.type).toBe('interactive')
    if (card.type !== 'interactive') throw new Error('not a card')
    const elements = (card.card.body as { elements: Array<Record<string, unknown>> }).elements
    const form = elements.find(element => element.tag === 'form') as { elements: Array<Record<string, unknown>> }
    expect(form).toBeTruthy()
    const selects = form.elements.filter(element => element.tag === 'select_static')
    expect(selects.map(select => select.name)).toEqual(['adapter', 'workspace', 'profile'])
    expect((selects.find(select => select.name === 'profile') as { options: Array<{ value: string }> }).options
      .map(option => option.value)).toEqual(expect.arrayContaining(['readonly', 'edit']))
    const buttons = form.elements.filter(element => element.tag === 'button')
    expect(buttons.map(button => button.name)).toEqual(['approve', 'reject'])
    expect(buttons.every(button => button.form_action_type === 'submit')).toBe(true)
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-11 重复 event_id 与不同 event_id 但重复 message_id → 双重去重只建 1 个任务', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.group('@_user_1 只应执行一次', { messageId: 'om_dedupe', eventId: 'evt_one' })
    // 同 event_id + 同 message_id（平台重推）
    await fake.group('@_user_1 只应执行一次', { messageId: 'om_dedupe', eventId: 'evt_one' })
    // 不同 event_id + 同 message_id（重推时 event_id 变化）
    await fake.group('@_user_1 只应执行一次', { messageId: 'om_dedupe', eventId: 'evt_two' })
    // 同 event_id + 不同 message_id
    await fake.group('@_user_1 只应执行一次', { messageId: 'om_dedupe_other', eventId: 'evt_one' })
    const rows = hub.ctx.store.repos.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>
    expect(rows).toHaveLength(1)
    const keys = hub.ctx.store.repos.prepare('SELECT key FROM feishu_event_dedupe ORDER BY key').all() as Array<{ key: string }>
    expect(keys.map(row => row.key)).toEqual(expect.arrayContaining(['evt:evt_one', 'evt:evt_two', 'msg:om_dedupe']))
    const task = hub.ctx.store.repos.tasks.getByNo(1)!
    expect(hub.ctx.store.repos.feishu.messages(task.id).filter(row => row.role === 'progress_card')).toHaveLength(1)
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-12 陈旧积压消息 → 丢弃不建任务，Owner 私聊收到汇总提示', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    const startedAt = hub.ctx.orchestrator.overview().hub.startedAt
    const stale = startedAt - 600_000 - 5_000
    await fake.p2p('启动前积压的需求一', { messageId: 'om_stale_1', createTime: stale })
    await fake.p2p('启动前积压的需求二', { messageId: 'om_stale_2', createTime: stale })
    expect(hub.ctx.store.repos.tasks.getByNo(1)).toBeUndefined()
    await eventually(() => [...fake.messages.values()].some(message => message.target === 'ou_owner' &&
      fake.text(message.id) === '已忽略 2 条启动前积压消息'), { label: 'stale summary' })
    // 新鲜消息仍可正常创建
    await fake.p2p('新鲜需求', { messageId: 'om_fresh' })
    expect(hub.ctx.store.repos.tasks.getByNo(1)).toBeTruthy()
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 15000)

it('FS-13 非文本回复提示；富文本 post 拼接 text/a 节点；空文本给帮助；超长拒绝', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.group('', { messageId: 'om_image', messageType: 'image', content: JSON.stringify({ image_key: 'img_v2' }) })
    await eventually(() => [...fake.messages.values()].some(message => fake.text(message.id) === '暂仅支持文本需求'),
      { label: 'non-text reply' })
    const post = { en_us: { content: [
      [{ tag: 'text', text: '第一段需求 ' }],
      [{ tag: 'text', text: '第二段 ' }, { tag: 'a', text: '链接文本', href: 'https://example.com' }],
    ] } }
    await fake.p2p('', { messageId: 'om_post', messageType: 'post', content: JSON.stringify(post) })
    const rich = hub.ctx.store.repos.tasks.getByNo(1)!
    expect(rich.prompt).toBe('第一段需求 \n第二段 链接文本')
    await fake.p2p('@_user_1', { messageId: 'om_empty' })
    await eventually(() => [...fake.messages.values()].some(message => (fake.text(message.id) ?? '').startsWith('直接发送需求')),
      { label: 'help reply' })
    await fake.p2p('长'.repeat(32_001), { messageId: 'om_long' })
    await eventually(() => [...fake.messages.values()].some(message => fake.text(message.id) === '需求过长'),
      { label: 'too long reply' })
    expect(hub.ctx.store.repos.tasks.getByNo(2)).toBeUndefined()
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 20000)

it('FS-14 引用回复路由：awaiting_input → INPUT_PROVIDE；活动中 → 提示进行中；awaiting_approval/rejected → 提示未执行', async () => {
  const { hub, fake, cleanup } = await hubWithFake({})
  const worker = await FakeWorker.connect(hub, { workerId: 'router-active' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    await fake.p2p('#scenario: need-input', { messageId: 'om_input' })
    const inputTask = db.tasks.getByNo(1)!
    const first = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    expect(first.taskId).toBe(inputTask.id)
    const ts = at()
    worker.events(first.runId, inputTask.id, [
      { seq: 1, ts, kind: 'started', pid: 11, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: ts + 1, kind: 'input_request', requestId: 'q1', question: '继续吗？', options: ['是', '否'] },
    ])
    await eventually(() => api.getTask(inputTask.id)?.status === 'awaiting_input', { label: 'awaiting_input' })
    await fake.p2p('是', { messageId: 'om_answer', parentId: 'om_input' })
    expect((await worker.waitFor('run.input')).payload).toMatchObject({ requestId: 'q1', answer: '是' })
    expect(fake.text(fake.order.at(-1)!)).toBe('已提交回答')
    worker.events(first.runId, inputTask.id, [{ seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded',
      exitCode: 0, signal: null, durationMs: 3, summary: '输入完成' }])
    await eventually(() => api.getTask(inputTask.id)?.status === 'succeeded', { label: 'input task finished' })

    // 活动中（running）的引用回复
    await fake.p2p('#scenario: slow ms=60000', { messageId: 'om_running' })
    const runningTask = db.tasks.getByNo(2)!
    const second = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === runningTask.id)
    const run2 = second.payload as RunDispatch
    worker.events(run2.runId, runningTask.id, [
      { seq: 1, ts, kind: 'started', pid: 12, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
    ])
    await eventually(() => api.getTask(runningTask.id)?.status === 'running', { label: 'running' })
    await fake.p2p('现在到哪一步了', { messageId: 'om_running_ask', parentId: 'om_running' })
    expect(fake.text(fake.order.at(-1)!)).toBe('任务进行中，完成后再回复可继续对话')

    // 未执行（awaiting_approval / rejected）
    await fake.group('群里的新需求', { messageId: 'om_pending' })
    const pending = db.tasks.getByNo(3)!
    expect(pending.status).toBe('awaiting_approval')
    await fake.group('补充一句', { messageId: 'om_pending_reply', parentId: 'om_pending' })
    expect(fake.text(fake.order.at(-1)!)).toBe('任务未执行，请直接发送新需求')
    await api.reject(pending.id, owner, { expectedVersion: pending.version })
    await fake.group('再补充一句', { messageId: 'om_rejected_reply', parentId: 'om_pending' })
    expect(fake.text(fake.order.at(-1)!)).toBe('任务未执行，请直接发送新需求')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)

it('FS-14 终态有 session → Follow-up；终态无 session → 新建关联任务并提示无法续接上下文', async () => {
  const { hub, fake, cleanup } = await hubWithFake({})
  const worker = await FakeWorker.connect(hub, { workerId: 'router-terminal' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    await fake.p2p('#scenario: success', { messageId: 'om_a' })
    const a = db.tasks.getByNo(1)!
    const dispatchA = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    let ts = at()
    worker.events(dispatchA.runId, a.id, [
      { seq: 1, ts, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: ts + 1, kind: 'session', cliSessionId: 'sess-A' },
      { seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 2,
        summary: 'A 完成' },
    ])
    await eventually(() => api.getTask(a.id)?.status === 'succeeded', { label: 'A succeeded' })
    expect(db.tasks.get(a.id)?.cliSessionId).toBe('sess-A')

    await fake.p2p('#scenario: success', { messageId: 'om_b' })
    const b = db.tasks.getByNo(2)!
    const dispatchB = await worker.waitFor('run.dispatch', frame => (frame.payload as RunDispatch).taskId === b.id)
    ts = at()
    worker.events((dispatchB.payload as RunDispatch).runId, b.id, [
      { seq: 1, ts, kind: 'started', pid: 2, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: ts + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 1,
        summary: 'B 完成' },
    ])
    await eventually(() => api.getTask(b.id)?.status === 'succeeded', { label: 'B succeeded' })

    // 终态无 session → 新建关联任务
    await fake.p2p('基于 B 继续', { messageId: 'om_b_reply', parentId: 'om_b' })
    expect(fake.text(fake.order.at(-1)!)).toBe('无法续接上下文，已新建关联任务')
    const bChild = db.tasks.getByNo(3)!
    expect(bChild).toMatchObject({ parentTaskId: b.id, resumeSessionId: null, workspaceId: 'sandbox', profile: 'edit' })

    // 终态有 session → Follow-up 子任务继承 session
    await fake.p2p('基于 A 继续', { messageId: 'om_a_reply', parentId: 'om_a' })
    const aChild = db.tasks.getByNo(4)!
    expect(aChild).toMatchObject({ parentTaskId: a.id, resumeSessionId: 'sess-A', adapter: 'mock',
      workspaceId: 'sandbox', profile: 'edit', requiredWorkerId: 'router-terminal' })
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)

it('FS-15 Follow-up 继承 session/adapter/workspace/profile、硬亲和原 Worker；原 Worker 离线时排队并提示等待上线', async () => {
  const { hub, fake, cleanup } = await hubWithFake({})
  const worker = await FakeWorker.connect(hub, { workerId: 'follow-worker' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    await fake.group('#scenario: success', { messageId: 'om_follow_parent' })
    const parent = db.tasks.getByNo(1)!
    expect(parent.status).toBe('awaiting_approval')
    await api.approve(parent.id, owner, { expectedVersion: parent.version })
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    expect(dispatch.workspaceId).toBe('sandbox')
    const ts = at()
    worker.events(dispatch.runId, parent.id, [
      { seq: 1, ts, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock-cli' },
      { seq: 2, ts: ts + 1, kind: 'session', cliSessionId: 'sess-follow' },
      { seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 2,
        summary: '父任务完成' },
    ])
    await eventually(() => api.getTask(parent.id)?.status === 'succeeded', { label: 'parent succeeded' })
    const progress = db.feishu.messages(parent.id).find(row => row.role === 'progress_card')!

    worker.terminate()
    await eventually(() => hub.ctx.workers.get('follow-worker')?.connection !== 'online', { label: 'worker offline' })

    await fake.group('继续追问同一个会话', { messageId: 'om_follow_child', parentId: progress.messageId })
    const child = db.tasks.getByNo(2)!
    expect(child).toMatchObject({ parentTaskId: parent.id, resumeSessionId: 'sess-follow', adapter: 'mock',
      workspaceId: 'sandbox', profile: 'edit', requiredWorkerId: 'follow-worker' })

    await api.approve(child.id, owner, { expectedVersion: child.version })
    expect(api.getTask(child.id)?.status).toBe('queued')
    await eventually(() => {
      const card = db.feishu.messages(child.id).find(row => row.role === 'progress_card')
      return card ? fake.json(card.messageId).includes('等待 follow-worker 节点上线') : false
    }, { timeoutMs: 10000, label: 'offline hint' })
    expect(api.getTask(child.id)?.status).toBe('queued')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 40000)

it('FS-27 无权限用户：私聊 24h 内只回复一次「暂无使用权限」，群聊静默忽略', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  try {
    await fake.p2p('你好', { messageId: 'om_stranger_1', user: 'ou_stranger' })
    await fake.p2p('再来一次', { messageId: 'om_stranger_2', user: 'ou_stranger' })
    await fake.p2p('第三次', { messageId: 'om_stranger_3', user: 'ou_stranger' })
    const denied = [...fake.messages.values()].filter(message => fake.text(message.id) === '暂无使用权限，请联系管理员')
    expect(denied).toHaveLength(1)
    // 群聊静默：不建任务也不回复
    const before = fake.messages.size
    await fake.group('群里的陌生人', { messageId: 'om_stranger_group', user: 'ou_stranger', chatId: 'oc_not_allowed' })
    expect(fake.messages.size).toBe(before)
    expect(hub.ctx.store.repos.tasks.getByNo(1)).toBeUndefined()
    // /whoami 例外（任何人私聊可用）
    await fake.p2p('/whoami', { messageId: 'om_whoami', user: 'ou_stranger' })
    expect(fake.text(fake.order.at(-1)!)).toBe('ou_stranger')
    const keys = hub.ctx.store.repos.prepare('SELECT key FROM feishu_event_dedupe').all() as Array<{ key: string }>
    expect(keys.filter(row => row.key === 'denied:ou_stranger')).toHaveLength(1)
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 20000)

it('SEC-19 Requester 取消他人任务 / 续接他人任务链 → 拒绝且原任务不受影响', async () => {
  const { hub, fake, cleanup } = await hubWithFake({}, { listen: false })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  try {
    await fake.group('受害者的需求', { messageId: 'om_victim', user: 'ou_req' })
    const victim = db.tasks.getByNo(1)!
    const progress = db.feishu.messages(victim.id).find(row => row.role === 'progress_card')!
    const cancel = await fake.click(progress.messageId, 'ou_req2', { v: 1, a: 'cancel', t: victim.id, ver: victim.version },
      { eventId: 'sec19:cancel' })
    expect(cancel.toast).toEqual({ type: 'error', content: '无权操作此任务' })
    expect(db.tasks.get(victim.id)).toMatchObject({ status: 'awaiting_approval', version: victim.version })

    await fake.group('我来接着聊', { messageId: 'om_attacker', user: 'ou_req2', rootId: 'om_victim' })
    expect(fake.text(fake.order.at(-1)!)).toBe('无权限')
    expect(db.tasks.getByNo(2)).toBeUndefined()
    expect(db.tasks.get(victim.id)).toMatchObject({ status: 'awaiting_approval', version: victim.version })

    // 直接调用 orchestrator 也不能越权取消
    await expect(api.cancel(victim.id, { type: 'requester', id: 'ou_req2', channel: 'feishu' },
      { expectedVersion: victim.version })).rejects.toMatchObject({ status: 403 })
    expect(db.tasks.get(victim.id)).toMatchObject({ status: 'awaiting_approval', version: victim.version })
    assertInvariants(db)
  } finally { await cleanup() }
}, 20000)

it('SEC-20 Requester 受众卡片/结果消息绝不含工作区路径、命令行、面板链接、stderr 或未脱敏密钥', async () => {
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ server: { publicUrl: 'https://hub.pi.internal:8443', port: 0,
    allowInsecureWorker: true }, feishu: config }, { feishuTransport: fake })
  const worker = await FakeWorker.connect(hub, { workerId: 'privacy-worker' })
  const api = hub.ctx.orchestrator
  const db = hub.ctx.store.repos
  const secret = 'sk-ant-' + 'A'.repeat(32)
  const prompt = [
    '请修复导出功能。',
    '工作区：C:\\Users\\admin\\projects\\secret-repo',
    '执行：npm run build --workspace backend',
    '面板：https://hub.pi.internal:8443/tasks/tsk_01ABC',
    'stderr: Error: boom at C:\\Users\\admin\\secret.log',
    'app_secret: ' + 'F'.repeat(32),
    '-----BEGIN PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '-----END PRIVATE KEY-----',
  ].join('\n')
  try {
    await fake.group(prompt, { messageId: 'om_privacy' })
    const task = db.tasks.getByNo(1)!
    await api.approve(task.id, owner, { expectedVersion: task.version })
    const dispatch = (await worker.waitFor('run.dispatch')).payload as RunDispatch
    const ts = at()
    worker.events(dispatch.runId, task.id, [
      { seq: 1, ts, kind: 'started', pid: 22, adapter: 'mock', effectiveProfile: 'edit',
        commandSummary: 'C:\\Users\\admin\\bin\\cli.exe --dangerously-skip-permissions' },
      { seq: 2, ts: ts + 1, kind: 'progress', phase: 'build', detail: '执行 npm run build --workspace backend' },
      { seq: 3, ts: ts + 2, kind: 'agent', event: { type: 'tool_use', name: 'Bash',
        summary: 'C:\\Users\\admin\\bin\\run.cmd --flag' } },
      { seq: 4, ts: ts + 3, kind: 'agent', event: { type: 'file_change', path: 'C:/Users/admin/projects/secret-repo/src/a.ts',
        change: 'modify' } },
      { seq: 5, ts: ts + 4, kind: 'agent', event: { type: 'file_change', path: 'src/visible.ts', change: 'modify' } },
    ])
    // 运行中卡片保留相对路径、不泄漏绝对路径/命令行
    const progressRow = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    await eventually(() => fake.json(progressRow.messageId).includes('src/visible.ts'),
      { timeoutMs: 10000, label: 'relative path on running card' })
    const runningJson = fake.json(progressRow.messageId)
    expect(runningJson).not.toContain('C:/Users')
    expect(runningJson).not.toContain('npm run')
    worker.events(dispatch.runId, task.id, [
      { seq: 6, ts: ts + 5, kind: 'agent', event: { type: 'message', role: 'assistant', text: secret, final: true } },
      { seq: 7, ts: ts + 6, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 6,
        summary: ['完成导出。', 'stderr: ' + secret, 'C:\\Users\\admin\\secret.log', 'https://hub.pi.internal:8443/tasks/x',
          'app_secret: ' + 'G'.repeat(32), '-----BEGIN PRIVATE KEY-----', 'MIIBVwIBADANBgkq', '-----END PRIVATE KEY-----',
          '相对路径 src/ok.ts'].join('\n') },
    ])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded', { label: 'succeeded' })
    await eventually(() => {
      const progress = db.feishu.messages(task.id).find(row => row.role === 'progress_card')
      return progress ? fake.json(progress.messageId).includes('完成导出') : false
    }, { timeoutMs: 8000, label: 'result on requester card' })
    const rows = db.feishu.messages(task.id).filter(row => row.audience === 'requester')
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      const body = fake.json(row.messageId)
      expect(body).not.toContain('C:\\\\Users')
      expect(body).not.toContain('C:/Users')
      expect(body).not.toContain('npm run')
      expect(body).not.toContain('https://hub.pi.internal')
      expect(body).not.toContain('/tasks/')
      expect(body).not.toContain('stderr')
      expect(body).not.toContain('BEGIN PRIVATE KEY')
      expect(body).not.toContain(secret)
      expect(body).not.toContain('F'.repeat(32))
    }
    // 相对路径保留，证明是受众过滤而非全部抹除
    expect(runningJson).toContain('（内部信息已隐藏）')
    expect(runningJson).toContain('src/visible.ts')
    // Owner 卡片保留内部信息（面板链接 / 工作区等）
    const approval = db.feishu.messages(task.id).find(row => row.role === 'approval_card')!
    expect(fake.json(approval.messageId)).toContain('C:\\\\Users')
    assertInvariants(db)
  } finally { worker.terminate(); await cleanup() }
}, 30000)
