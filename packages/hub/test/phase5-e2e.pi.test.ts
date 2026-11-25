/**
 * Pi 独立验收 · Phase 5 端到端（真实 Hub + 真实 Worker 进程 + mock-cli + FakeFeishuTransport）
 * 覆盖 E2E-11、E2E-12、E2E-13。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertInvariants, delay, enrollWorker, eventually, openHarness, wsUrl } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

const base = {
  enabled: true,
  ownerOpenIds: ['ou_owner'],
  requesterAllowlist: ['ou_req'],
  requesterPolicy: 'chat' as const,
  allowedChatIds: ['oc_group'],
  defaultWorkspaceId: 'sandbox',
}

function files(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const workspace = join(dir, 'repo')
  mkdirSync(workspace)
  return { dir, workspace, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

type Hub = Awaited<ReturnType<typeof openHarness>>['hub']

async function workerFor(hub: Hub, workerId: string, workspace: string, stateDir: string) {
  const identity = await enrollWorker(hub, workerId)
  const worker = await startWorker(WorkerConfigSchema.parse({
    workerId, hub: { url: wsUrl(hub.address!) }, maxConcurrency: 2,
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full' }],
  }), { stateDir, random: () => 0, onWarning: () => undefined,
    identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint },
  })
  await eventually(() => hub.ctx.store.repos.workers.get(workerId)?.connection === 'online', { timeoutMs: 10_000 })
  return worker
}

it('E2E-11 Requester 群聊 @Bot 提需求 → Owner 私聊审批（含覆写）→ 本机 Mock Worker 执行 → 卡片更新 → 结果回传', async () => {
  const dirs = files('pi-p5-e2e11-')
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: base }, { feishuTransport: fake })
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  const db = hub.ctx.store.repos
  try {
    worker = await workerFor(hub, 'feishu-e2e11', dirs.workspace, join(dirs.dir, 'state'))
    await fake.group('#scenario: success n=4', { messageId: 'om_e2e11' })
    const task = db.tasks.getByNo(1)!
    expect(task).toMatchObject({ status: 'awaiting_approval', source: 'feishu', requesterType: 'requester' })
    const rows = () => db.feishu.messages(task.id)
    const progress = rows().find(row => row.role === 'progress_card')!
    const approval = rows().find(row => row.role === 'approval_card')!
    expect(fake.json(progress.messageId)).toContain('等待负责人审批')
    expect(fake.messages.get(approval.messageId)!.target).toBe('ou_owner')

    const click = await fake.click(approval.messageId, 'ou_owner',
      { v: 1, a: 'approve', t: task.id, ver: task.version },
      { eventId: 'e2e11:approve', form: { adapter: 'mock', workspace: 'sandbox', profile: 'readonly' } })
    expect(click.toast).toEqual({ type: 'success', content: '已批准' })
    await eventually(() => db.tasks.get(task.id)?.status === 'running', { timeoutMs: 15_000, label: 'running' })
    expect(db.tasks.get(task.id)!.profile).toBe('readonly')

    await eventually(() => db.tasks.get(task.id)?.status === 'succeeded', { timeoutMs: 30_000, label: 'succeeded' })
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(detail.resultSummary).toBe('Mock response 4')
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]).toMatchObject({ profile: 'readonly', adapter: 'mock', workspaceId: 'sandbox',
      workerId: 'feishu-e2e11', status: 'succeeded' })
    expect(detail.runs[0]!.pid).toBeGreaterThan(0)
    expect(detail.runs[0]!.cliSessionId).toBe('mock-session')
    // 卡片状态序列：等待审批 → 执行中 → 已完成；结果回传到 Requester 卡片
    await eventually(() => fake.json(approval.messageId).includes('已批准'), { timeoutMs: 8000, label: 'approval card' })
    await eventually(() => fake.json(progress.messageId).includes('已完成'), { timeoutMs: 10_000, label: 'progress card' })
    expect(fake.json(progress.messageId)).toContain('Mock response 4')
    expect(rows().filter(row => row.role === 'result_text')).toHaveLength(0)
    assertInvariants(db)
  } finally { await worker?.close(); dirs.cleanup(); await cleanup() }
}, 120_000)

it('E2E-12 Requester 引用结果卡片追问 → Follow-up 子任务 resume 同一 cliSessionId 与同一 Worker 并成功', async () => {
  const dirs = files('pi-p5-e2e12-')
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: base }, { feishuTransport: fake })
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  const db = hub.ctx.store.repos
  try {
    worker = await workerFor(hub, 'feishu-e2e12', dirs.workspace, join(dirs.dir, 'state'))
    await fake.group('#scenario: success n=2', { messageId: 'om_e2e12' })
    const parent = db.tasks.getByNo(1)!
    const rows = () => db.feishu.messages(parent.id)
    const approval = rows().find(row => row.role === 'approval_card')!
    await fake.click(approval.messageId, 'ou_owner', { v: 1, a: 'approve', t: parent.id, ver: parent.version },
      { eventId: 'e2e12:approve' })
    await eventually(() => db.tasks.get(parent.id)?.status === 'succeeded', { timeoutMs: 30_000, label: 'parent succeeded' })
    const parentRuns = hub.ctx.orchestrator.getTask(parent.id)!.runs
    expect(parentRuns[0]!.cliSessionId).toBe('mock-session')
    const progress = db.feishu.messages(parent.id).find(row => row.role === 'progress_card')!

    await fake.group('在结果基础上继续追问', { messageId: 'om_e2e12_child', parentId: progress.messageId })
    const child = db.tasks.getByNo(2)!
    expect(child).toMatchObject({ parentTaskId: parent.id, resumeSessionId: 'mock-session',
      requiredWorkerId: 'feishu-e2e12', workspaceId: 'sandbox', profile: 'edit', adapter: 'mock' })
    expect(child.status).toBe('awaiting_approval')
    const childApproval = db.feishu.messages(child.id).find(row => row.role === 'approval_card')!
    await fake.click(childApproval.messageId, 'ou_owner',
      { v: 1, a: 'approve', t: child.id, ver: child.version }, { eventId: 'e2e12:approve-child' })
    await eventually(() => db.tasks.get(child.id)?.status === 'succeeded', { timeoutMs: 30_000, label: 'child succeeded' })
    const childDetail = hub.ctx.orchestrator.getTask(child.id)!
    expect(childDetail.runs).toHaveLength(1)
    expect(childDetail.runs[0]).toMatchObject({ workerId: 'feishu-e2e12', cliSessionId: 'mock-session', adapter: 'mock' })
    const childProgress = db.feishu.messages(child.id).find(row => row.role === 'progress_card')!
    await eventually(() => fake.json(childProgress.messageId).includes('已完成'), { timeoutMs: 10_000, label: 'child card' })
    assertInvariants(db)
  } finally { await worker?.close(); dirs.cleanup(); await cleanup() }
}, 150_000)

it('E2E-13 飞书审批按钮与面板 REST 并发审批同一任务 → 恰好执行一次、只产生 1 个 Run、两边状态一致', async () => {
  const dirs = files('pi-p5-e2e13-')
  const fake = new PiFeishuTransport()
  const { hub, cleanup } = await openHarness({ feishu: base }, { feishuTransport: fake })
  let worker: Awaited<ReturnType<typeof workerFor>> | undefined
  const db = hub.ctx.store.repos
  const api = hub.ctx.orchestrator
  try {
    worker = await workerFor(hub, 'feishu-e2e13', dirs.workspace, join(dirs.dir, 'state'))
    await fake.group('#scenario: success n=1', { messageId: 'om_e2e13' })
    const task = db.tasks.getByNo(1)!
    const rows = () => db.feishu.messages(task.id)
    const approval = rows().find(row => row.role === 'approval_card')!
    const progress = rows().find(row => row.role === 'progress_card')!
    const token = hub.ctx.auth.createApiToken('pi', ['admin'])
    const value = { v: 1, a: 'approve', t: task.id, ver: task.version }
    const startedAt = Date.now()
    const [clicks, http] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, (_, index) =>
        fake.click(approval.messageId, 'ou_owner', value, { eventId: 'e2e13:' + index }))),
      hub.ctx.http.app.inject({ method: 'POST', url: '/api/v1/tasks/' + task.id + '/approve',
        headers: { authorization: 'Bearer ' + token }, payload: { expectedVersion: task.version } }),
    ])
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(clicks.every(click => click.elapsed < 3000)).toBe(true)
    const cardWins = clicks.filter(click => click.toast.type === 'success').length
    const httpWins = Number(http.statusCode === 200)
    expect(cardWins + httpWins).toBe(1)
    expect([200, 409]).toContain(http.statusCode)
    expect(db.prepare("SELECT id FROM audit_logs WHERE target_id = ? AND action = 'task.approve'").all(task.id)).toHaveLength(1)
    await eventually(() => db.tasks.get(task.id)?.status === 'running' && db.runs.forTask(task.id).length === 1,
      { timeoutMs: 15_000, label: 'single run' })
    await delay(500)
    expect(db.runs.forTask(task.id)).toHaveLength(1)
    await eventually(() => db.tasks.get(task.id)?.status === 'succeeded', { timeoutMs: 30_000, label: 'succeeded' })
    expect(db.runs.forTask(task.id)).toHaveLength(1)
    expect(api.getTask(task.id)!.runs).toHaveLength(1)
    // 两边卡片/状态一致
    await eventually(() => fake.json(approval.messageId).includes('已批准'), { timeoutMs: 10_000, label: 'approval card' })
    await eventually(() => fake.json(progress.messageId).includes('已完成'), { timeoutMs: 10_000, label: 'progress card' })
    const version = db.tasks.get(task.id)!.version
    await eventually(() => rows().filter(row => row.role === 'progress_card')
      .every(row => row.dead || row.cardTaskVersion === version), { timeoutMs: 5000, label: 'card versions' })
    assertInvariants(db)
  } finally { await worker?.close(); dirs.cleanup(); await cleanup() }
}, 150_000)
