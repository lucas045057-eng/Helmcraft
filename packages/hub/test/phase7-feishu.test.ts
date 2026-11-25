import { expect, it } from 'vitest'
import { openHarness, FakeWorker, eventually } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { capabilities, dispatch, finish, mockPrompt } from './pi/phase7.js'
import { renderProgressCard } from '../src/plugins/channel-feishu/cards/index.js'

it('routes Owner private handoffs, deduplicates card submissions, and gates Requester cards and approvals', async () => {
  const transport = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'],
    defaultWorkspaceId: 'sandbox', allowedChatIds: ['oc_group'] } }, { feishuTransport: transport })
  const db = hub.ctx.store.repos
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'fs-worker', headers: capabilities })
    await transport.emit({ text: mockPrompt, user: 'ou_owner', chatType: 'p2p' })
    const source = db.tasks.getByNo(1)!
    const run = await dispatch(worker, source.id)
    await finish(hub, worker, run)
    const card = db.feishu.messages(source.id).find(m => m.role === 'progress_card')!
    const task = hub.ctx.orchestrator.getTask(source.id)!
    const model = { ...task, harness: { fromRunId: run.runId, board: task.runs[0]!.harness!.boardChanges!, handoffTargets: ['mock'] } }
    const ownerCard = JSON.stringify(renderProgressCard(model, 'owner'))
    expect(ownerCard).toContain('换 CLI 接力')
    expect(ownerCard).toContain('HANDOFF.md 已删除')
    expect(JSON.stringify(renderProgressCard(model, 'requester'))).not.toMatch(/换 CLI|HANDOFF.md|private board text/)
    const value = { v: 1, a: 'handoff', t: source.id, r: run.runId, ver: task.version }
    expect((await transport.click(card.messageId, 'ou_req', value)).toast.type).toBe('error')
    const form = { cli: 'mock', prompt: mockPrompt }
    const clicks = await Promise.all([transport.click(card.messageId, 'ou_owner', value, { form }), transport.click(card.messageId, 'ou_owner', value, { form })])
    expect(clicks.some(c => c.toast.content.includes('已创建接力任务'))).toBe(true)
    expect(hub.ctx.orchestrator.getTask(source.id)!.children).toHaveLength(1)
    const child = db.tasks.getByNo(2)!
    expect(child.handoffFromRunId).toBe(run.runId)
    await eventually(() => db.feishu.messages(child.id).some(m => m.role === 'progress_card' && m.audience === 'owner'))
    await transport.emit({ text: '/handoff --cli=mock', user: 'ou_owner', chatType: 'p2p', parentId: card.messageId })
    expect(db.tasks.getByNo(3)).toMatchObject({ handoffFromRunId: run.runId, requiredWorkerId: 'fs-worker' })
    await transport.emit({ text: '/run --from=#1 --cli=mock next', user: 'ou_owner', chatType: 'p2p' })
    expect(db.tasks.getByNo(4)).toMatchObject({ prompt: 'next', handoffFromRunId: run.runId })
    await transport.group('/handoff --cli=mock --from=#1', { user: 'ou_owner' })
    expect(transport.text(transport.order.at(-1)!)).toBe('无权执行此指令')
    await transport.group(mockPrompt)
    const request = db.tasks.getByNo(5)!
    const approval = db.feishu.messages(request.id).find(m => m.role === 'approval_card')!
    expect(transport.json(approval.messageId)).toContain('board_verify')
    const result = await transport.click(approval.messageId, 'ou_owner', { v: 1, a: 'approve', t: request.id, ver: request.version }, { form: { harness: 'board_verify' } })
    expect(result.toast.type).toBe('success')
    expect(db.tasks.get(request.id)?.harnessRequestJson?.overrides).toEqual({ blackboard: true, verify: true })
    const fix = await transport.click(card.messageId, 'ou_owner', { ...value, a: 'fix' })
    expect(fix.toast.type).toBe('success')
    expect(db.tasks.getByNo(6)).toMatchObject({ adapter: 'mock', resumeSessionId: 'session-' + run.runId, harnessRequestJson: { intent: 'fix' } })
    const requesterCard = db.feishu.messages(request.id).find(m => m.role === 'progress_card')!
    expect((await transport.click(requesterCard.messageId, 'ou_owner', { ...value, t: request.id })).toast.type).toBe('error')
  } finally { await cleanup() }
}, 20000)
