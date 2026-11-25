/**
 * Pi 独立验收 · Phase 7a 飞书与卡片（UX-1 ~ UX-7、RT-8 的渠道侧、BC-7）。
 */
import { expect, it } from 'vitest'
import { canUseCommand, parseCommand } from '@agent-hub/protocol'
import type { CardActionValue, TaskDetailView } from '@agent-hub/protocol'
import { renderProgressCard } from '../src/plugins/channel-feishu/cards/index.js'
import { FakeWorker, eventually, openHarness } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { capabilities, dispatch, mockPrompt, snapshot } from './pi/phase7.js'

const settings = { feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'],
  defaultWorkspaceId: 'sandbox', allowedChatIds: ['oc_group'] } }

it('UX-1 parses /handoff and /run --from with the documented errors', () => {
  const ok = parseCommand('/handoff --cli=codex 继续')
  expect(ok.ok && ok.cmd).toMatchObject({ name: 'handoff', flags: { cli: 'codex' }, prompt: '继续' })
  const missingCli = parseCommand('/handoff --from=#1')
  expect(missingCli.ok).toBe(false)
  expect(!missingCli.ok && missingCli.error).toContain('--cli')
  const runFrom = parseCommand('/run --from=#12 --cli=gemini x')
  expect(runFrom.ok && runFrom.cmd).toMatchObject({ name: 'run', flags: { from: '#12', cli: 'gemini' }, prompt: 'x' })
  expect(parseCommand('/run --from=INVALID x').ok).toBe(false)
  expect(parseCommand('/run --from=#1 --ws=sandbox x').ok).toBe(false)
  // P-1 回归：既有选项与未知选项的行为完全不变
  expect(parseCommand('/run --unknown=1 x').ok).toBe(false)
  expect(parseCommand('/run --profile=deploy x').ok).toBe(false)
  // Owner + p2p 才能用
  for (const text of ['/handoff --cli=mock', '/run --from=#1 x']) {
    const parsed = parseCommand(text)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(canUseCommand(parsed.cmd, 'owner', 'p2p')).toBe(true)
    expect(canUseCommand(parsed.cmd, 'owner', 'group')).toBe(false)
    expect(canUseCommand(parsed.cmd, 'requester', 'p2p')).toBe(false)
  }
})

async function ownerSession(transport: PiFeishuTransport) {
  const opened = await openHarness(settings, { feishuTransport: transport })
  const db = opened.hub.ctx.store.repos
  const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux', headers: capabilities })
  await transport.emit({ text: mockPrompt, user: 'ou_owner', chatType: 'p2p' })
  const source = db.tasks.getByNo(1)!
  const run = await dispatch(worker, source.id)
  return { ...opened, db, worker, source, run }
}

it('UX-2/UX-3/UX-4 route reply handoffs, reject non-Owner and keep ordinary replies on resume', async () => {
  const transport = new PiFeishuTransport()
  const session = await ownerSession(transport)
  try {
    const { db, worker, source, run } = session
    await worker.events(run.runId, run.taskId, [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock', seq: 1, ts: 1 },
      { kind: 'session', cliSessionId: 'mock-session-1', seq: 2, ts: 2 },
      { kind: 'harness', applied: { board: 'write', inject: 'fresh', trust: 'owner', bootstrap: false, verify: false,
        autoFixMaxRetries: 0, downgrades: [] }, board: snapshot('board body'), seq: 3, ts: 3 },
      { kind: 'workspace', round: 0, board: snapshot('board body'), seq: 4, ts: 4 },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 1, seq: 5, ts: 5 },
    ])
    await eventually(() => db.runs.get(run.runId)?.status === 'succeeded')
    const card = db.feishu.messages(source.id).find(message => message.role === 'progress_card')!
    // UX-2：引用回复卡片发 /handoff --cli=mock → 以该卡片任务的最近 Run 交接
    await transport.emit({ text: '/handoff --cli=mock', user: 'ou_owner', chatType: 'p2p', parentId: card.messageId })
    const relay = db.tasks.getByNo(2)!
    expect(relay).toMatchObject({ handoffFromRunId: run.runId, requiredWorkerId: 'pi-ux', resumeSessionId: null })
    const relayCard = db.feishu.messages(relay.id).find(message => message.role === 'progress_card')
    expect(relayCard).toBeDefined()
    // UX-3：群聊中的 Owner 指令与 Requester 私聊均被拒绝
    await transport.group('/handoff --cli=mock --from=#1', { user: 'ou_owner' })
    expect(transport.text(transport.order.at(-1)!)).toBe('无权执行此指令')
    const before = db.tasks.getByNo(3)
    expect(before).toBeUndefined()
    // UX-4：普通引用回复仍走 followUp + resume（字段与 Phase 6 相同）
    await transport.emit({ text: '继续下一步', user: 'ou_owner', chatType: 'p2p', parentId: card.messageId })
    const follow = db.tasks.getByNo(3)!
    expect(follow).toMatchObject({ parentTaskId: source.id, rootTaskId: source.id, resumeSessionId: 'mock-session-1' })
    expect(follow.handoffFromRunId).toBeNull()
    expect(follow.prompt).toBe('继续下一步')
  } finally { await session.cleanup() }
}, 30000)

it('UX-5 creates exactly one child for a double-clicked card form and replies in the private chat', async () => {
  const transport = new PiFeishuTransport()
  const session = await ownerSession(transport)
  try {
    const { db, worker, source, run } = session
    await worker.events(run.runId, run.taskId, [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock', seq: 1, ts: 1 },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 1, seq: 2, ts: 2 },
    ])
    await eventually(() => db.runs.get(run.runId)?.status === 'succeeded')
    const card = db.feishu.messages(source.id).find(message => message.role === 'progress_card')!
    const task = session.hub.ctx.orchestrator.getTask(source.id)!
    const value: CardActionValue = { v: 1, a: 'handoff', t: source.id, r: run.runId, ver: task.version }
    const form = { cli: 'mock', prompt: mockPrompt }
    const clicks = await Promise.all([
      transport.click(card.messageId, 'ou_owner', value, { form }),
      transport.click(card.messageId, 'ou_owner', value, { form }),
      transport.click(card.messageId, 'ou_owner', value, { form }),
    ])
    expect(clicks.filter(click => click.toast.type === 'success').length).toBeGreaterThanOrEqual(1)
    expect(session.hub.ctx.orchestrator.getTask(source.id)!.children).toHaveLength(1)
    const child = db.tasks.getByNo(2)!
    expect(child).toMatchObject({ handoffFromRunId: run.runId, prompt: mockPrompt, adapter: 'mock' })
    await eventually(() => db.feishu.messages(child.id).some(message => message.role === 'progress_card'))
    // Requester 点击接力按钮被拒绝（RT-8 渠道侧）
    expect((await transport.click(card.messageId, 'ou_req', value, { form })).toast.type).toBe('error')
    expect(session.hub.ctx.orchestrator.getTask(source.id)!.children).toHaveLength(1)
  } finally { await session.cleanup() }
}, 30000)

function model(task: TaskDetailView, withHarness: boolean) {
  return { ...task, ...(withHarness && { harness: {
    fromRunId: task.runs[0]!.runId,
    board: [{ file: 'HANDOFF.md' as const, change: 'deleted' as const, added: 0, removed: 3 },
      { file: 'LESSONS.md' as const, change: 'modified' as const, added: 2, removed: 1 }],
    warnings: ['OVER_BUDGET'],
    handoffTargets: ['mock', 'codex'],
  } }) }
}

it('UX-6/UX-7/BC-7 render Harness details for Owner only and drop them in budget order', async () => {
  const transport = new PiFeishuTransport()
  const session = await ownerSession(transport)
  try {
    const { worker, run, source } = session
    await worker.events(run.runId, run.taskId, [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock', seq: 1, ts: 1 },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 1, seq: 2, ts: 2 },
    ])
    await eventually(() => session.db.runs.get(run.runId)?.status === 'succeeded')
    const task = session.hub.ctx.orchestrator.getTask(source.id)!
    // UX-6：Requester 视图与「完全没有 Harness」的模型逐字节一致（C-8）
    const requesterWith = JSON.stringify(renderProgressCard(model(task, true), 'requester'))
    const requesterWithout = JSON.stringify(renderProgressCard(model(task, false), 'requester'))
    expect(requesterWith).toBe(requesterWithout)
    expect(requesterWith).not.toMatch(/换 CLI|HANDOFF\.md|OVER_BUDGET|lastAccepted/u)
    const ownerCard = JSON.stringify(renderProgressCard(model(task, true), 'owner'))
    expect(ownerCard).toContain('换 CLI 接力')
    expect(ownerCard).toContain('HANDOFF.md 已删除')
    expect(ownerCard).toContain('OVER_BUDGET')
    // BC-7：无 Harness 的 Owner 卡片不包含任何 Phase 7 新元素（既有快照不变，C-8）
    const ownerPlain = JSON.stringify(renderProgressCard(model(task, false), 'owner'))
    expect(ownerPlain).not.toMatch(/换 CLI|黑板|HANDOFF\.md|OVER_BUDGET|lastAccepted|验证/u)
    expect(JSON.stringify(renderProgressCard(model(task, false), 'requester')))
    // UX-7：截断顺序 = 表单 → 告警行 → 黑板摘要
    const threshold = (marker: string) => {
      for (let budget = 512; budget <= 30_000; budget += 32) {
        const card = JSON.stringify(renderProgressCard({ ...model(task, true), cardMaxBytes: budget }, 'owner'))
        if (card.includes(marker)) return budget
      }
      return Number.POSITIVE_INFINITY
    }
    const board = threshold('HANDOFF.md')
    const warning = threshold('OVER_BUDGET')
    const form = threshold('换 CLI 接力')
    expect(board).toBeLessThan(30_000)
    expect(warning).toBeGreaterThanOrEqual(board)
    expect(form).toBeGreaterThanOrEqual(warning)
  } finally { await session.cleanup() }
}, 30000)
