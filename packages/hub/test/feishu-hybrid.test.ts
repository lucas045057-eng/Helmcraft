import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { canUseCommand, parseCommand } from '@agent-hub/protocol'
import type { AgentEvent } from '@agent-hub/protocol'
import { extractProgress } from '../src/plugins/channel-feishu/cards/progress.js'
import { splitResult } from '../src/plugins/channel-feishu/result-text.js'
import { HubConfigSchema } from '../src/config/schema.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { eventually, FakeWorker, openHarness } from './pi/harness.js'
import { dispatch, finish, mockPrompt, requester } from './pi/phase7.js'

const permissions = { autoApproveAll: true, allowRequesterCommands: true, allowRequesterHandoff: true,
  disableRequesterLimits: true, disableResultGating: true, allowRequesterAutoAccept: true }
const feishu = { enabled: true, ownerOpenIds: ['ou_owner'], defaultWorkspaceId: 'sandbox', defaultProfile: 'full',
  requesterAllowlist: ['ou_req'], allowedChatIds: ['oc_group'], deliveryMode: 'hybrid', groupAudience: 'owner',
  allowGroupCommands: true, card: { minPatchIntervalMs: 20, minPatchIntervalHighMs: 10 } }
const events = (...items: AgentEvent[]) => items.map((event, i) => ({ kind: 'agent' as const, seq: i + 1, ts: Date.now(), event }))

it('keeps card mode, requester visibility and independent permissions closed by default', () => {
  const config = HubConfigSchema.parse({})
  expect(config.feishu).toMatchObject({ deliveryMode: 'card', groupAudience: 'requester', allowGroupCommands: false })
  expect(config.feishu.defaultProfile).toBeUndefined()
  for (const name of Object.keys(permissions)) {
    expect(HubConfigSchema.parse({ permissions: { [name]: true } }).permissions).toEqual({ ...config.permissions, [name]: true })
  }
  expect(Object.values(config.permissions)).toEqual(Array(6).fill(false))
})

it('shows command lifecycle and compact reasoning only to the owner audience', () => {
  const input = events({ type: 'thinking', text: '\n  ' + 'a'.repeat(200) + '\nsecond' },
    ...[null, 0, 3].map(exitCode => ({ type: 'command' as const, command: 'git diff', exitCode })))
  expect(extractProgress(input, 'owner')).toEqual(['💭 ' + 'a'.repeat(140), '▶ $ git diff', '✓ $ git diff', '✗ $ git diff (exit 3)'])
  expect(extractProgress(input, 'requester')).toEqual([])
  const many = events(...Array.from({ length: 10 }, (_, i) => ({ type: 'thinking' as const, text: String(i) })))
  expect(extractProgress(many, 'owner')).toHaveLength(5)
  expect(extractProgress(many, 'owner', 8)).toEqual(Array.from({ length: 8 }, (_, i) => '💭 ' + (i + 2)))
})

it('preserves complete lines and Unicode across numbered result messages', () => {
  expect(splitResult('a'.repeat(8000))).toEqual(['a'.repeat(8000)])
  const lines = ('甲'.repeat(3900) + '\n').repeat(3)
  expect(splitResult(lines)[0]).toBe('1/2\n' + lines.slice(0, 7802))
  const long = '🛰'.repeat(15000)
  const parts = splitResult(long)
  expect(parts.every(part => part.length <= 8000 && part.isWellFormed())).toBe(true)
  expect(parts.map(part => part.slice(part.indexOf('\n') + 1)).join('')).toBe(long)
})

it('streams Markdown, collapses the card, binds every chunk and handles replies to different chunks', async () => {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions, feishu, workers: { redactionPatterns: ['private-marker'] },
    orchestrator: { limits: { requesterTasksPerHour: 1, maxActivePerRequester: 1 } } }, { feishuTransport: bot })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'hybrid' })
    const db = hub.ctx.store.repos
    await bot.group('skip', { mentions: [] })
    await bot.group('/run --profile=full skip', { user: 'stranger' })
    expect(db.tasks.getByNo(1)).toBeUndefined()
    await bot.group('/run --worker=hybrid --priority=5 build', { messageId: 'original' })
    const task = db.tasks.getByNo(1)!
    expect(task).toMatchObject({ requesterType: 'requester', profile: 'full', priority: 5 })
    const run = await dispatch(w, task.id)
    const bindings = () => db.feishu.messages(task.id)
    const card = bindings().find(row => row.role === 'progress_card')!
    expect(card.audience).toBe('owner')
    expect(bindings().some(row => row.role === 'approval_card')).toBe(false)
    w.events(run.runId, task.id, events({ type: 'thinking', text: 'checking private-marker' },
      { type: 'command', command: 'git diff', exitCode: 0 }))
    await eventually(() => bot.json(card.messageId).includes('✓ $ git diff'))
    expect(bot.json(card.messageId)).toContain('"tag":"markdown"')
    expect(bot.json(card.messageId)).toContain('💭 checking')
    expect(bot.json(card.messageId)).not.toContain('private-marker')
    const summary = 'result line\n'.repeat(850)
    w.events(run.runId, task.id, [{ kind: 'finished', seq: 3, ts: Date.now(), status: 'succeeded', durationMs: 1,
      summary, cliSessionId: 'hybrid-session', filesChanged: ['file.ts'], exitCode: 0, signal: null }])
    await eventually(() => bindings().filter(row => row.role === 'result_text').length === 2)
    const chunks = bindings().filter(row => row.role === 'result_text')
    expect(chunks.map(row => bot.text(row.messageId))).toEqual(splitResult(summary))
    expect(chunks.every(row => bot.messages.get(row.messageId)?.target === 'original')).toBe(true)
    expect(bot.json(card.messageId)).toContain('改动 1 个文件')
    expect(bot.json(card.messageId)).not.toMatch(/result line|git diff|"tag":"form"/u)
    bot.setStatus('reconnecting')
    bot.setStatus('connected')
    await bot.group('continue', { parentId: chunks[0]!.messageId })
    expect(db.tasks.getByNo(2)).toMatchObject({ parentTaskId: task.id, resumeSessionId: 'hybrid-session' })
    await bot.group('/handoff --cli=mock next', { parentId: chunks[1]!.messageId })
    expect(db.tasks.getByNo(3)).toMatchObject({ handoffFromRunId: run.runId, requesterId: 'ou_req', requesterType: 'requester' })
    expect(bindings().filter(row => row.role === 'result_text')).toHaveLength(2)
  } finally { await cleanup() }
}, 25000)

it('recovers an interrupted split result after reconnect without repeating a confirmed chunk', async () => {
  const bot = new PiFeishuTransport()
  const reply = bot.replyMessage.bind(bot)
  let attempts = 0, unavailable = true
  vi.spyOn(bot, 'replyMessage').mockImplementation(async (id, body, opts) => {
    if (body.type === 'text' && body.text.startsWith('2/') && unavailable) {
      attempts++
      throw Object.assign(new Error('message rejected'), { response: { status: 400 } })
    }
    return reply(id, body, opts)
  })
  const { hub, cleanup } = await openHarness({ permissions, feishu }, { feishuTransport: bot })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'recover' })
    await bot.p2p('test')
    const db = hub.ctx.store.repos, task = db.tasks.getByNo(1)!
    const run = await dispatch(w, task.id)
    w.events(run.runId, task.id, [{ kind: 'finished', seq: 1, ts: Date.now(), status: 'succeeded',
      durationMs: 1, summary: 'x'.repeat(12000), exitCode: 0, signal: null }])
    await eventually(() => attempts > 0)
    expect(db.tasks.get(task.id)?.feishuResultVersion).toBe(0)
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(Date.now() - 86400000, task.id)
    unavailable = false
    bot.setStatus('reconnecting')
    bot.setStatus('connected')
    await eventually(() => db.tasks.get(task.id)?.feishuResultVersion === db.tasks.get(task.id)?.version)
    expect([...bot.messages.values()].filter(m => m.body.type === 'text')).toHaveLength(2)
    expect(db.feishu.messages(task.id).filter(m => m.role === 'result_text')).toHaveLength(2)
  } finally { await cleanup() }
}, 15000)

it.each(['failed', 'timed_out'] as const)('sends the %s diagnostic in chat and keeps it out of the status bar', async status => {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions, feishu }, { feishuTransport: bot })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'diagnostic' })
    await bot.p2p('test')
    const task = hub.ctx.store.repos.tasks.getByNo(1)!
    const run = await dispatch(w, task.id)
    w.events(run.runId, task.id, [{ kind: 'finished', seq: 1, ts: Date.now(), status, durationMs: 1,
      summary: 'partial work', errorMessage: 'diagnostic detail', exitCode: 1, signal: null }])
    const rows = () => hub.ctx.store.repos.feishu.messages(task.id)
    await eventually(() => rows().filter(row => row.role === 'result_text').length === 2)
    expect(bot.text(rows().filter(row => row.role === 'result_text')[1]!.messageId)).toContain('diagnostic detail')
    const card = bot.json(rows().find(row => row.role === 'progress_card')!.messageId)
    expect(card).toContain('重试')
    expect(card).not.toMatch(/partial work|diagnostic detail/u)
  } finally { await cleanup() }
}, 12000)

it('respects owner review and delivers only the approved text to an open group', async () => {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions, feishu: { ...feishu, requesterReplyPolicy: 'owner_review' } }, { feishuTransport: bot })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'review' })
    await bot.group('review this')
    const db = hub.ctx.store.repos, task = db.tasks.getByNo(1)!
    await finish(hub, w, await dispatch(w, task.id))
    const rows = () => db.feishu.messages(task.id)
    await eventually(() => rows().some(row => row.role === 'review_card'))
    expect(rows().some(row => row.role === 'result_text')).toBe(false)
    const card = rows().find(row => row.role === 'progress_card')!
    expect(bot.json(card.messageId)).not.toContain('"done"')
    await hub.ctx.orchestrator.deliverResult(task.id, { id: 'owner', type: 'owner', channel: 'dashboard' }, { action: 'send', summaryOverride: 'approved' })
    expect(bot.text(rows().find(row => row.role === 'result_text')!.messageId)).toBe('approved')
  } finally { await cleanup() }
}, 10000)

it.each([false, true])('gates board deletion and advances requester pointers with independent switches (%s)', async open => {
  const { hub, cleanup } = await openHarness({ permissions: { autoApproveAll: true, disableResultGating: open, allowRequesterAutoAccept: open,
    allowRequesterHandoff: open }, harness: { defaults: { allowRequesterBlackboard: true, allowRequesterVerify: true } } })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'board', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1' } })
    const api = hub.ctx.orchestrator
    const task = await api.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit', adapter: 'mock' }, requester)
    const run = await dispatch(w, task.id)
    await finish(hub, w, run)
    expect(api.getTask(task.id)?.resultDeliveryStatus).toBe(open ? 'not_required' : 'pending_review')
    const accepted = hub.ctx.store.repos.pointers.get(w.identity.workerId, 'sandbox')!.lastAcceptedRunId
    expect(accepted).toBe(open ? run.runId : null)
    if (open) expect(api.handoffPreview(task.id, requester, {}).facts.currentRun.trust).toBe('requester')
    else expect(() => api.handoffPreview(task.id, requester, {})).toThrow()
    const accept = (id: string) => api.acceptRun('board', 'sandbox', { ...requester, id }, { runId: run.runId, expectedAcceptedRunId: accepted })
    await expect(accept('someone-else')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(accept(requester.id)).rejects.toMatchObject({ code: open ? 'INVALID_TRANSITION' : 'FORBIDDEN' })
  } finally { await cleanup() }
})

it.each(['/workers', '/tasks all', '/approve #1', '/reject #1', '/retry #1', '/drain node on',
  '/run --profile=full --worker=node --priority=1 test'])('delegates %s only to admitted requesters', text => {
  const parsed = parseCommand(text)
  if (!parsed.ok) throw Error(parsed.error)
  expect(canUseCommand(parsed.cmd, 'requester', 'group')).toBe(false)
  expect(canUseCommand(parsed.cmd, 'requester', 'group', permissions)).toBe(true)
  expect(canUseCommand(parsed.cmd, 'unauthorized', 'group', permissions)).toBe(false)
})

it.each(['/handoff --cli=codex', '/run --from=#1 --cli=mock continue', '/fix #1', '/accept #1'])('honors separate handoff and group switches for %s', text => {
  const parsed = parseCommand(text)
  if (!parsed.ok) throw Error(parsed.error)
  const open = { ...permissions, allowGroupCommands: true }
  expect(canUseCommand(parsed.cmd, 'requester', 'group', open)).toBe(true)
  for (const key of ['allowRequesterHandoff', 'allowGroupCommands', 'allowRequesterCommands'] as const) {
    expect(canUseCommand(parsed.cmd, 'requester', 'group', { ...open, [key]: false })).toBe(false)
  }
  expect(canUseCommand(parsed.cmd, 'owner', 'group', { allowGroupCommands: false })).toBe(false)
})

it('applies profile precedence, requester approval, rejection and hot permission revocation', async () => {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions: { allowRequesterCommands: true }, feishu: { ...feishu,
    chatDefaults: { oc_group: { profile: 'readonly' } } } }, { feishuTransport: bot })
  try {
    const db = hub.ctx.store.repos
    await bot.group('first')
    expect(db.tasks.getByNo(1)).toMatchObject({ profile: 'readonly', status: 'awaiting_approval' })
    await bot.group('/approve #1')
    expect(db.tasks.getByNo(1)).toMatchObject({ status: 'queued', decidedBy: 'ou_req' })
    await bot.group('/run --profile=edit second')
    expect(db.tasks.getByNo(2)?.profile).toBe('edit')
    await bot.group('/reject #2 unsuitable')
    expect(db.tasks.getByNo(2)).toMatchObject({ status: 'rejected', decidedBy: 'ou_req' })
    const channel = hub.fibers.get('feishu')!
    await channel.update({ ...channel.config, groupAudience: 'requester', permissions: HubConfigSchema.parse({}).permissions })
    await bot.group('/run --profile=full blocked')
    expect(db.tasks.getByNo(3)).toBeUndefined()
    await eventually(() => db.feishu.messages(db.tasks.getByNo(1)!.id).some(m => m.role === 'progress_card' && m.audience === 'requester'))
    await bot.group('outside', { chatId: 'outside' })
    expect(db.tasks.getByNo(3)?.profile).toBe('edit') // full default clamped by policy
  } finally { await cleanup() }
}, 15000)

it('allows requester card fixes and explicit acceptance independently of auto-accept', async () => {
  const bot = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ permissions: { ...permissions, allowRequesterAutoAccept: false }, feishu,
    harness: { defaults: { allowRequesterVerify: true, allowRequesterBlackboard: true } } }, { feishuTransport: bot })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'fix', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' } })
    const db = hub.ctx.store.repos
    await bot.group(mockPrompt)
    const task = db.tasks.getByNo(1)!
    const run = await dispatch(w, task.id)
    w.events(run.runId, task.id, [
      { kind: 'started', seq: 1, ts: Date.now(), effectiveProfile: 'full', adapter: 'mock', pid: 1, commandSummary: 'mock' },
      { kind: 'verify', seq: 2, ts: Date.now(), phase: 'result', attempt: 1, commands: ['unit'], status: 'failed',
        results: [{ id: 'unit', status: 'failed', exitCode: 1, signal: null, durationMs: 1 }] },
      { kind: 'finished', seq: 3, ts: Date.now(), status: 'succeeded', exitCode: 0, signal: null, durationMs: 1, summary: 'done',
        verification: { status: 'failed', attempts: 1, failed: ['unit'] } },
    ])
    const card = db.feishu.messages(task.id).find(row => row.role === 'progress_card')!
    await eventually(() => bot.json(card.messageId).includes('带报错修复'))
    expect(db.tasks.get(task.id)?.resultDeliveryStatus).toBe('not_required')
    expect(db.pointers.get('fix', 'sandbox')?.lastAcceptedRunId).toBeNull()
    await bot.group('/accept #1')
    expect(db.pointers.get('fix', 'sandbox')).toMatchObject({ lastAcceptedRunId: run.runId, acceptedBy: 'ou_req' })
    const response = await bot.click(card.messageId, 'ou_req', { v: 1, a: 'fix', t: task.id, ver: db.tasks.get(task.id)!.version, r: run.runId })
    expect(response.toast.type).toBe('success')
    expect(db.tasks.getByNo(2)).toMatchObject({ requesterType: 'requester', requesterId: 'ou_req', handoffFromRunId: run.runId,
      originJson: { feishu: { chatType: 'group', chatId: 'oc_group' } } })
  } finally { await cleanup() }
}, 12000)

it('admits concurrent requester runs across workspaces while enforcing worker capacity', async () => {
  const { hub, cleanup } = await openHarness({ permissions, orchestrator: { limits: { requesterTasksPerHour: 1, maxActivePerRequester: 1 } } })
  try {
    const w = await FakeWorker.connect(hub, { workerId: 'limits', maxConcurrency: 2 })
    for (const workspaceId of ['sandbox', 'backend']) {
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'read', workspaceId, profile: 'readonly' }, requester)
      await dispatch(w, task.id)
    }
    expect(hub.ctx.store.repos.runs.active('limits')).toHaveLength(2)
  } finally { await cleanup() }
})

it('preserves dashboard authentication, mutation origin checks and policy admission with all switches enabled', async () => {
  const { hub, cleanup } = await openHarness({ permissions, feishu: { ...feishu, enabled: false }, dashboard: { allowedOrigins: ['https://dashboard.test'] } })
  try {
    expect(hub.ctx.policy.evaluate({ actor: requester, source: 'feishu', profile: 'full', workspaceId: 'sandbox', adapter: 'mock',
      prompt: 'test', chatId: 'unlisted' }).decision).toBe('deny')
    const app = hub.ctx.http.app
    expect((await app.inject({ url: '/api/v1/tasks' })).statusCode).toBe(401)
    vi.stubEnv('HUB_ADMIN_TOKEN_SHA256', createHash('sha256').update('test-login').digest('hex'))
    const session = hub.ctx.auth.login('test-login', { ip: '127.0.0.1' })
    expect((await app.inject({ method: 'POST', url: '/api/v1/tasks', headers: { cookie: 'ah_sid=' + session.sessionId,
      origin: 'https://wrong.test', 'x-csrf-token': session.csrfToken }, payload: {} })).statusCode).toBe(403)
  } finally { vi.unstubAllEnvs(); await cleanup() }
})
