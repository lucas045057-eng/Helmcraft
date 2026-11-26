/**
 * Pi 独立验收 · Phase 7b 飞书与面板（UX-11 ~ UX-16）
 *
 * 卡片断言尽量只依赖结构化事实（回调值、表单名、patch 序列）；文本断言只用
 * 08 §10.3 / §10.4 与面板实现的 `data-testid` 契约原文。
 */
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import { expect, it } from 'vitest'
import { FakeWorker, defaultAdapters, eventually, openHarness } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { extractProgress } from '../src/plugins/channel-feishu/cards/progress.js'
import { dispatch, mockPrompt, owner } from './pi/phase7.js'
import { assertVerificationInvariants } from './pi/verify-invariants.js'
import { ADMIN_TOKEN, useAdminToken } from './pi/rest.js'

const caps = { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' }
const feishu = { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'], allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox' }
const changes = { added: 1, modified: 0, deleted: 0, links: 0, total: 1, boardOnly: false,
  sample: [{ path: 'src.txt', change: 'added' }], truncated: false }

const startedEvent = { kind: 'started', seq: 1, ts: 1001, pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' }
const sessionEvent = { kind: 'session', seq: 2, ts: 1002, cliSessionId: 'sess-1' }
const ws = (seq: number) => ({ kind: 'workspace', seq, ts: 1000 + seq, round: 0, changes })
const verifyStarted = (seq: number) => ({ kind: 'verify', seq, ts: 1000 + seq, attempt: 1, phase: 'started', commands: ['unit'] })
const verifyFailed = (seq: number) => ({ kind: 'verify', seq, ts: 1000 + seq, attempt: 1, phase: 'result', commands: ['unit'],
  status: 'failed', results: [{ id: 'unit', status: 'failed', exitCode: 1, signal: null, durationMs: 4, tail: 'expected 2' }] })

it('UX-11 repairs with the same CLI and the captured session', async () => {
  const transport = new PiFeishuTransport()
  const opened = await openHarness({ feishu }, { feishuTransport: transport })
  try {
    const api = opened.hub.ctx.orchestrator, db = opened.hub.ctx.store.repos
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux11', headers: caps })
    await transport.p2p('/run --profile=edit --cli=mock ' + mockPrompt, { user: 'ou_owner' })
    const task = db.tasks.getByNo(1)!
    const run = await dispatch(worker, task.id)
    const card = db.feishu.messages(task.id).find(message => message.role === 'progress_card')!
    worker.events(run.runId, task.id, [startedEvent, sessionEvent, ws(3), verifyStarted(4), verifyFailed(5),
      { kind: 'finished', seq: 6, ts: 1006, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
        cliSessionId: 'sess-1', verification: { status: 'failed', attempts: 1, failed: ['unit'] } }])
    await eventually(() => api.getTask(task.id)?.verification === 'failed')
    await eventually(() => transport.json(card.messageId).includes('带报错修复'), { timeoutMs: 10_000 })
    expect(transport.json(card.messageId)).toContain('换 CLI 修复')
    const click = await transport.click(card.messageId, 'ou_owner',
      { v: 1, a: 'fix', t: task.id, r: run.runId, ver: db.tasks.get(task.id)!.version }, { form: { prompt: mockPrompt } })
    expect(click.toast.type).toBe('success')
    const child = db.tasks.getByNo(2)!
    expect(child.handoffFromRunId).toBe(run.runId)
    const childRun = await dispatch(worker, child.id)
    // 同一 CLI + 捕获到的会话 → resume（inject=resume，不重复注入黑板正文）
    expect(childRun.adapter).toBe('mock')
    expect(childRun.resume).toEqual({ cliSessionId: 'sess-1' })
    expect(childRun.harness).toMatchObject({ inject: 'resume', trust: 'owner',
      facts: { handoff: { intent: 'fix', from: { runId: run.runId } } } })
    assertVerificationInvariants(db)
  } finally { await opened.cleanup() }
}, 40_000)

it('UX-12 switches CLI for the repair with a fresh session and full injection', async () => {
  const transport = new PiFeishuTransport()
  const opened = await openHarness({ feishu }, { feishuTransport: transport })
  try {
    const api = opened.hub.ctx.orchestrator, db = opened.hub.ctx.store.repos
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux12', headers: caps,
      adapters: [...defaultAdapters, { ...defaultAdapters[0]!, id: 'codex' }] })
    await transport.p2p('/run --profile=edit --cli=mock ' + mockPrompt, { user: 'ou_owner' })
    const task = db.tasks.getByNo(1)!
    const run = await dispatch(worker, task.id)
    const card = db.feishu.messages(task.id).find(message => message.role === 'progress_card')!
    worker.events(run.runId, task.id, [startedEvent, sessionEvent, ws(3), verifyStarted(4), verifyFailed(5),
      { kind: 'finished', seq: 6, ts: 1006, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
        cliSessionId: 'sess-1', verification: { status: 'failed', attempts: 1, failed: ['unit'] } }])
    await eventually(() => api.getTask(task.id)?.verification === 'failed')
    await eventually(() => transport.json(card.messageId).includes('换 CLI 修复'), { timeoutMs: 10_000 })
    const click = await transport.click(card.messageId, 'ou_owner',
      { v: 1, a: 'fix', t: task.id, r: run.runId, ver: db.tasks.get(task.id)!.version }, { form: { cli: 'codex', prompt: mockPrompt } })
    expect(click.toast.type).toBe('success')
    const child = db.tasks.getByNo(2)!
    const childRun = await dispatch(worker, child.id)
    // 换 CLI → 新会话 + 完整注入（handoff）
    expect(childRun.adapter).toBe('codex')
    expect(childRun.resume).toBeUndefined()
    expect(childRun.harness).toMatchObject({ inject: 'handoff', trust: 'owner', facts: { handoff: { intent: 'fix' } } })
    expect(childRun.harness?.facts?.handoff?.from.verificationDetail).toMatchObject({ status: 'failed' })
    assertVerificationInvariants(db)
  } finally { await opened.cleanup() }
}, 40_000)

it('UX-13/UX-16 patches the live badge into the final one and hides ids from the requester', async () => {
  const transport = new PiFeishuTransport()
  const opened = await openHarness({ feishu }, { feishuTransport: transport })
  try {
    const db = opened.hub.ctx.store.repos
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux16', headers: caps })
    await transport.p2p('/run --profile=edit --cli=mock ' + mockPrompt, { user: 'ou_owner' })
    const task = db.tasks.getByNo(1)!
    const run = await dispatch(worker, task.id)
    const card = db.feishu.messages(task.id).find(message => message.role === 'progress_card')!
    worker.events(run.runId, task.id, [startedEvent, { kind: 'verify', seq: 2, ts: 1002, attempt: 1, phase: 'started', commands: ['unit'] }])
    await eventually(() => transport.json(card.messageId).includes('⏳ 验证中'), { timeoutMs: 12_000 })
    worker.events(run.runId, task.id, [
      { kind: 'verify', seq: 3, ts: 1003, attempt: 1, phase: 'result', commands: ['unit'], status: 'passed',
        results: [{ id: 'unit', status: 'passed', exitCode: 0, signal: null, durationMs: 4 }] },
      { kind: 'finished', seq: 4, ts: 1004, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
        verification: { status: 'passed', attempts: 1, failed: [] } },
    ])
    await eventually(() => transport.json(card.messageId).includes('✅ 验证通过'), { timeoutMs: 12_000 })
    expect(transport.json(card.messageId)).not.toContain('⏳ 验证中')
    // UX-13：进展行按受众区分
    const started = [{ kind: 'verify', seq: 1, ts: 1, attempt: 2, phase: 'started' as const, commands: ['unit', 'lint'] }]
    const wip = [{ kind: 'verify', seq: 1, ts: 1, attempt: 2, phase: 'result' as const, commands: ['unit', 'lint'],
      status: 'failed' as const, results: [{ id: 'unit', status: 'failed' as const, exitCode: 1, signal: null, durationMs: 4 }] }]
    expect(extractProgress(started, 'owner')).toEqual(['验证 #2：unit、lint'])
    expect(extractProgress(wip, 'owner')).toEqual(['验证 #2 未通过：unit'])
    expect(extractProgress(started, 'requester')).toEqual(['正在进行自动验证'])
    expect(extractProgress(wip, 'requester')).toEqual(['正在进行自动验证'])
    assertVerificationInvariants(db)
  } finally { await opened.cleanup() }
}, 40_000)

it('UX-15 stores the board_verify approval override and dispatches verification', async () => {
  const transport = new PiFeishuTransport()
  const opened = await openHarness({ feishu }, { feishuTransport: transport })
  try {
    const api = opened.hub.ctx.orchestrator, db = opened.hub.ctx.store.repos
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux15', headers: caps })
    await transport.group(mockPrompt)
    const task = db.tasks.getByNo(1)!
    const card = db.feishu.messages(task.id).find(message => message.role === 'approval_card')!
    const click = await transport.click(card.messageId, 'ou_owner',
      { v: 1, t: task.id, ver: db.tasks.get(task.id)!.version, a: 'approve' },
      { form: { harness: 'board_verify', profile: 'edit', adapter: 'mock' } })
    expect(click.toast.type).toBe('success')
    await eventually(() => db.tasks.get(task.id)?.harnessRequestJson?.overrides !== undefined)
    expect(db.tasks.get(task.id)?.harnessRequestJson?.overrides).toEqual({ blackboard: true, verify: true })
    const run = await dispatch(worker, task.id)
    expect(run.harness).toMatchObject({ trust: 'requester', board: 'write', verify: { autoFixMaxRetries: 0 } })
    worker.events(run.runId, task.id, [startedEvent, ws(2),
      { kind: 'finished', seq: 3, ts: 1003, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9 }])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded')
    // 对照：Requester 默认策略（无覆写）不请求验证
    await transport.group(mockPrompt)
    const plain = db.tasks.getByNo(2)!
    await transport.click(db.feishu.messages(plain.id).find(message => message.role === 'approval_card')!.messageId, 'ou_owner',
      { v: 1, t: plain.id, ver: db.tasks.get(plain.id)!.version, a: 'approve' }, { form: { profile: 'edit', adapter: 'mock' } })
    const plainRun = await dispatch(worker, plain.id)
    expect(plainRun.harness?.verify).toBeUndefined()
    expect(api.getTask(plain.id)?.verification).toBeUndefined()
    assertVerificationInvariants(db)
  } finally { await opened.cleanup() }
}, 40_000)

it('UX-14 renders the verification panel, tamper paths, autofix info and the pipeline badge', async () => {
  useAdminToken()
  const socket = createServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as AddressInfo).port
  await new Promise<void>(resolve => socket.close(() => resolve()))
  const origin = 'http://127.0.0.1:' + port
  const opened = await openHarness({ server: { port },
    dashboard: { allowedOrigins: [origin], distDir: fileURLToPath(new URL('../../dashboard/dist/site/', import.meta.url)) } })
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const api = opened.hub.ctx.orchestrator
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ux14', headers: caps })
    const page = await browser.newPage()
    await page.goto(origin + '/')
    await page.getByTestId('login-token').fill(ADMIN_TOKEN)
    await page.getByTestId('login-submit').click()
    const tampered = await api.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit', prompt: mockPrompt }, owner)
    const tamperRun = await dispatch(worker, tampered.id)
    worker.events(tamperRun.runId, tampered.id, [
      startedEvent,
      { kind: 'workspace', seq: 2, ts: 1002, round: 0, changes,
        tamper: { total: 2, paths: ['package.json', 'vitest.config.ts'], links: 0 } },
      { kind: 'finished', seq: 3, ts: 1003, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
        verification: { status: 'skipped', reason: 'TAMPER_RISK', attempts: 0, failed: [], autoFix: { attempts: 0, stoppedBy: 'TAMPER_RISK' } } },
    ])
    await eventually(() => api.getTask(tampered.id)?.verification === 'skipped')
    await page.goto(origin + '/tasks/' + tampered.id)
    await page.getByTestId('tech-details').locator('summary').click()
    const panel = page.getByTestId('verification-panel')
    await pw(panel.getByTestId('verification-badge')).toHaveText('已跳过验证')
    await pw(panel).toContainText('TAMPER_RISK')
    await pw(panel).toContainText('package.json')
    await pw(panel).toContainText('vitest.config.ts')
    await pw(panel).toContainText('自动修复 0 次 · TAMPER_RISK')
    await pw(panel.getByTestId('verification-fix-same')).toHaveCount(0)
    const tamperedCard = page.getByTestId('task-card-' + tampered.taskNo)
    await pw(tamperedCard).toBeAttached()
    await pw(tamperedCard.getByTestId('verification-badge')).toHaveCount(0)
    // 第二个 Run：验证失败 + 自动修复信息 → 面板出现两个修复入口
    const failed = await api.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit', prompt: mockPrompt }, owner)
    const failedRun = await dispatch(worker, failed.id)
    worker.events(failedRun.runId, failed.id, [
      startedEvent, ws(2), verifyStarted(3), verifyFailed(4),
      { kind: 'finished', seq: 5, ts: 1005, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
        verification: { status: 'failed', attempts: 2, failed: ['unit'],
          autoFix: { attempts: 1, stoppedBy: 'MAX_RETRIES' } } },
    ])
    await eventually(() => api.getTask(failed.id)?.verification === 'failed')
    await page.goto(origin + '/tasks/' + failed.id)
    await page.getByTestId('tech-details').locator('summary').click()
    const failedPanel = page.getByTestId('verification-panel')
    await pw(failedPanel.getByTestId('verification-badge')).toHaveText('验证失败')
    await pw(failedPanel).toContainText('expected 2')
    await pw(failedPanel).toContainText('自动修复 1 次 · MAX_RETRIES')
    await pw(failedPanel.getByTestId('verification-fix-same')).toBeVisible()
    await pw(failedPanel.getByTestId('verification-fix-switch')).toBeVisible()
    await pw(page.getByTestId('task-card-' + failed.taskNo).getByTestId('verification-badge')).toHaveText('验证失败')
  } finally { await browser.close(); await opened.cleanup() }
}, 90_000)
