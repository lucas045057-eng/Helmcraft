import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import type { PersonalBinding, ProjectOverview } from '@agent-hub/protocol'
import { RunDispatch } from '@agent-hub/protocol'
import { HubConfigSchema } from '../src/config/schema.js'
import { analyzeProjectHealth, nextDailyBriefingAt } from '../src/plugins/orchestrator/steward.js'
import { dailyBackup } from '../src/plugins/retention/backup.js'
import { purgeLogSlice } from '../src/plugins/retention/cleanup.js'
import { openStore } from '../src/plugins/store-sqlite/index.js'
import { FakeFeishuTransport } from './fake-feishu-transport.js'
import { eventually, FakeWorker, openHarness } from './pi/harness.js'
import { login, ORIGIN, rest, settings, useAdminToken } from './pi/rest.js'

const bindingFixture: PersonalBinding = {
  workerId: 'w-smart',
  workspaceId: 'soren',
  subdir: 'Forma',
  root: '/ws/soren/Forma',
  branch: 'main',
  remote: 'local',
  ref: 'refs/heads/main',
  destination: 'a'.repeat(64),
  executables: { main: '/bin/codex', reviewer: '/bin/claude', advisor: '/bin/agy' },
  mode: 'flexible',
  allowVersionDrift: true,
  autoCommit: true,
  autoPush: false,
  adapters: { main: 'codex', reviewer: 'claude-code', advisor: 'antigravity' },
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('smart workflow hub end-to-end', () => {
  it('keeps multimodal, smartRouting, and steward disabled by default', () => {
    const cfg = HubConfigSchema.parse({})
    expect(cfg.feishu.multimodal.enabled).toBe(false)
    expect(cfg.feishu.smartRouting.enabled).toBe(false)
    expect(cfg.steward.enabled).toBe(false)
  })

  it('ingests Feishu image, post+img, and HTTP-transcribed audio attachments and handles ASR fallback', async () => {
    const asr = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: '帮 Forma 新增导出表格按钮' }))
      })
    })
    await new Promise<void>(resolve => asr.listen(0, '127.0.0.1', resolve))
    const asrPort = (asr.address() as AddressInfo).port
    cleanups.push(() => new Promise<void>(resolve => asr.close(() => resolve())))

    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
        defaultProfile: 'edit',
        deliveryMode: 'hybrid',
        multimodal: {
          enabled: true,
          asrUrl: `http://127.0.0.1:${asrPort}/v1/audio/transcriptions`,
        },
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: false },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    const worker = await FakeWorker.connect(hub, {
      workerId: 'w-smart',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['codex', 'claude-code', 'antigravity', 'mock'],
        maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => worker.terminate())

    fake.resources.set('img_key_1', { data: Buffer.from('fake-png-bytes'), mimeType: 'image/png' })
    fake.resources.set('audio_key_1', { data: Buffer.from('fake-ogg-bytes'), mimeType: 'audio/ogg' })

    // 1. Direct P2P image triggers multimodal ingestion and attaches image to run.dispatch
    await fake.message('m_img', '', 'ou_owner', {
      chat_id: 'oc_p2p_owner',
      chat_type: 'p2p',
      mentions: [],
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_key_1' }),
    })
    const d1 = RunDispatch.parse((await worker.waitFor('run.dispatch', 8000)).payload)
    expect(d1.attachments).toHaveLength(1)
    expect(d1.attachments![0]).toMatchObject({ kind: 'image', mimeType: 'image/png' })

    // Complete task #1 so concurrency slot frees up
    worker.events(d1.runId, d1.taskId, [
      { seq: 1, ts: Date.now(), kind: 'started', pid: 10, adapter: d1.adapter, effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: Date.now(), kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: '图片处理完成' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(d1.taskId)?.status === 'succeeded')

    // 2. Audio message gets transcribed via local ASR HTTP server & routed to Forma!
    await fake.message('m_aud', '', 'ou_owner', {
      chat_id: 'oc_p2p_owner',
      chat_type: 'p2p',
      mentions: [],
      message_type: 'audio',
      content: JSON.stringify({ file_key: 'audio_key_1' }),
    })
    const d2 = RunDispatch.parse((await worker.waitFor('run.dispatch', 8000, f => (f.payload as { taskId: string }).taskId !== d1.taskId)).payload)
    expect(d2.prompt).toContain('帮 Forma 新增导出表格按钮')
    expect(d2.subdir).toBe('Forma')
    expect(d2.attachments?.[0]?.kind).toBe('audio')

    // Round 4 P1 #7: Oversized audio (>500 KB dispatch cap) transcribes cleanly & omits oversized binary instead of failing dispatch
    fake.resources.set('audio_big_key', { data: Buffer.alloc(600_000, 7), mimeType: 'audio/ogg' })
    worker.events(d2.runId, d2.taskId, [
      { seq: 1, ts: Date.now(), kind: 'started', pid: 11, adapter: d2.adapter, effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: Date.now(), kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: '完成' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(d2.taskId)?.status === 'succeeded')
    await fake.message('m_aud_big', '', 'ou_owner', {
      chat_id: 'oc_p2p_owner', chat_type: 'p2p', mentions: [], message_type: 'audio', content: JSON.stringify({ file_key: 'audio_big_key' }),
    })
    const d3 = RunDispatch.parse((await worker.waitFor('run.dispatch', 8000, f => ![d1.taskId, d2.taskId].includes((f.payload as { taskId: string }).taskId))).payload)
    expect(d3.prompt).toContain('帮 Forma 新增导出表格按钮')
    expect(d3.attachments ?? []).toEqual([])

    // 3. Fallback error when asrUrl is not configured
    const fakeNoAsr = new FakeFeishuTransport()
    const noAsr = await openHarness({
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
        multimodal: { enabled: true },
      },
    }, { feishuTransport: fakeNoAsr })
    cleanups.push(noAsr.cleanup)
    fakeNoAsr.resources.set('aud_no_url', { data: Buffer.from('ogg'), mimeType: 'audio/ogg' })
    await fakeNoAsr.message('m_no_asr', '', 'ou_owner', {
      chat_id: 'oc_p2p_2', chat_type: 'p2p', mentions: [], message_type: 'audio', content: JSON.stringify({ file_key: 'aud_no_url' }),
    })
    await eventually(() => [...fakeNoAsr.messages.values()].some(m =>
      m.body.type === 'text' && m.body.text.includes('未配置语音转写')))
  }, 20_000)

  it('handles smart routing, project lock, proposal card + failure rollback, visual artifacts, and REST XSS headers', async () => {
    useAdminToken()
    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      ...settings,
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
        deliveryMode: 'hybrid',
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: true },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    // Register worker AFTER testing offline rollback!
    // Trigger autopilot proposal first while worker is offline
    const workerFirst = await FakeWorker.connect(hub, {
      workerId: 'w-smart',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['codex', 'claude-code', 'antigravity', 'mock'],
        maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => workerFirst.terminate())

    // /project Forma locks session memory
    await fake.message('m_proj', '/project Forma', 'ou_owner', { chat_id: 'oc_p2p_r', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('已锁定当前会话项目：soren/Forma')))

    // Multi-step prompt produces Autopilot proposal card
    await fake.message('m_auto_prop', '从零搭建完整实现一个报表导出模块并且自动测试验收闭环', 'ou_owner', { chat_id: 'oc_p2p_r', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('proposal_accept')))
    const propCardEntry = [...fake.messages.entries()].find(([, m]) => m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('proposal_accept'))!
    const propIdMatch = JSON.stringify(propCardEntry[1].body).match(/prp_[0-9A-HJKMNP-TV-Z]{26}/u)!
    const propId = propIdMatch[0]!

    // Disconnect worker momentarily to test proposal rollback on transient preflight failure
    workerFirst.terminate()
    await eventually(() => hub.ctx.orchestrator.listWorkers()[0]?.connection === 'offline')
    const failClick = await fake.click(propCardEntry[0], 'ou_owner', { v: 1, a: 'proposal_accept', p: propId })
    expect(failClick.toast.type).toBe('error')

    // Reconnect worker & reply "干" -> proposal was rolled back to pending so text reply now succeeds!
    const allAdapters = (['mock', 'codex', 'claude-code', 'antigravity'] as const).map(id => ({
      id, status: 'ready' as const, version: '0.1.0', features: { resume: true, liveInput: true, structuredOutput: true },
    }))
    const worker = await FakeWorker.connect(hub, {
      workerId: 'w-smart',
      identity: workerFirst.identity,
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      adapters: allAdapters,
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['codex', 'claude-code', 'antigravity', 'mock'],
        maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => worker.terminate())

    const replyPromise = fake.message('m_go', '干', 'ou_owner', { chat_id: 'oc_p2p_r', chat_type: 'p2p', mentions: [] })
    const preFrame = await worker.waitFor('project.preflight', 5000)
    await worker.ackCommand(preFrame, { result: { preflight: { ok: true, binding: bindingFixture, checks: ['unit'] } } })
    await replyPromise
    const startedMsg = await eventually(() => [...fake.messages.values()].find(m => m.body.type === 'text' && m.body.text.includes('🚀 已启动自动交付')))
    expect(startedMsg).toBeTruthy()
    const projIdMatch = startedMsg!.body.type === 'text' ? startedMsg!.body.text.match(/\(([^)]+)\)/u) : null
    const projId = projIdMatch?.[1]
    expect(projId).toBeTruthy()

    // Also test REST /personal/preflight & clean stop before dispatching standard visual task
    const { cookie, csrfToken } = await login(rest(hub))
    const apiCall = rest(hub)
    const preRestPromise = apiCall('POST', '/api/v1/personal/preflight', {
      cookie,
      csrf: csrfToken,
      origin: ORIGIN,
      payload: { workerId: 'w-smart', workspaceId: 'soren', subdir: 'Forma', mode: 'flexible' },
    })
    const preFrame2 = await worker.waitFor('project.preflight', f => f.id !== preFrame.id)
    await worker.ackCommand(preFrame2, { result: { preflight: { ok: true, binding: bindingFixture, checks: ['unit'] } } })
    const preRest = await preRestPromise
    expect(preRest.status).toBe(200)
    expect(preRest.json()).toMatchObject({ ok: true, checks: ['unit'] })

    const planTaskDispatch = await worker.waitFor('run.dispatch')
    await worker.ackCommand(planTaskDispatch)
    const planPayload = planTaskDispatch.payload as { runId: string; taskId: string }
    const stopRes = await apiCall('POST', `/api/v1/personal/projects/${projId}/stop`, { cookie, csrf: csrfToken, origin: ORIGIN })
    expect(stopRes.status).toBe(204)
    const cancelFrame = await worker.waitFor('run.cancel', 5000)
    await worker.ackCommand(cancelFrame)
    worker.events(planPayload.runId, planPayload.taskId, [
      { seq: 1, ts: hub.ctx.clock.now(), kind: 'started', pid: 21, adapter: 'codex', effectiveProfile: 'readonly', commandSummary: 'codex' },
      { seq: 2, ts: hub.ctx.clock.now() + 1, kind: 'finished', status: 'cancelled', errorCode: 'CANCELLED', exitCode: null, signal: 'SIGTERM', durationMs: 5, summary: '' },
    ])
    const relFrame = await worker.waitFor('project.release', 5000)
    await worker.ackCommand(relFrame, { result: { releasedProject: projId } })
    await eventually(() => hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(projId) === 'stopped')

    // Normal visual task: Worker emits visual shots -> Hub persists artifacts + uploads to Feishu + REST anti-XSS
    const visualTask = await hub.ctx.orchestrator.createTask({
      prompt: '检查 Forma 页面样式',
      workspaceId: 'soren',
      subdir: 'Forma',
      profile: 'edit',
      origin: { source: 'feishu', feishu: { chatId: 'oc_p2p_r', chatType: 'p2p', messageId: 'm_vis_orig' } },
    }, { type: 'owner', id: 'ou_owner', channel: 'feishu' })

    const visDispatch = (await worker.waitFor('run.dispatch', f => (f.payload as { taskId: string }).taskId === visualTask.id)).payload as { runId: string; taskId: string }
    const ts = hub.ctx.clock.now()
    worker.events(visDispatch.runId, visDispatch.taskId, [
      { seq: 1, ts, kind: 'started', pid: 33, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      {
        seq: 2, ts: ts + 1, kind: 'visual', phase: 'before', status: 'passed',
        shots: [{ route: '/chart', url: 'http://127.0.0.1:4173/chart', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 12, mimeType: 'image/jpeg', imageBase64: Buffer.from('before-jpeg').toString('base64') }],
      },
      {
        seq: 3, ts: ts + 2, kind: 'visual', phase: 'after', status: 'passed',
        shots: [{ route: '/chart', url: 'http://127.0.0.1:4173/chart', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 10, mimeType: 'image/jpeg', imageBase64: Buffer.from('after-jpeg').toString('base64') }],
      },
      { seq: 4, ts: ts + 3, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 10, summary: '视觉通过' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(visualTask.id)?.status === 'succeeded')
    await eventually(() => fake.uploadedImages.length >= 2)
    await eventually(() => [...fake.messages.values()].filter(m => m.target === 'm_vis_orig' && m.body.type === 'image').length >= 2, { timeout: 10_000 })

    const artRes = await apiCall('GET', `/api/v1/tasks/${visualTask.id}/runs/${visDispatch.runId}/artifacts`, { cookie, csrf: csrfToken, origin: ORIGIN })
    expect(artRes.status).toBe(200)
    const arts = artRes.json<Array<{ id: string; kind: string; mimeType: string; url: string }>>()
    expect(arts.map(a => a.kind)).toEqual(['visual_before', 'visual_after'])

    const imgRes = await apiCall('GET', arts[0]!.url, { cookie, origin: ORIGIN })
    expect(imgRes.status).toBe(200)
    expect(imgRes.header('x-content-type-options')).toBe('nosniff')
    expect(imgRes.header('content-security-policy')).toContain('sandbox')
    expect(imgRes.header('content-type')).toContain('image/jpeg')

    // Stored XSS hardening: non-image text/html artifact forces attachment + application/octet-stream
    const htmlArt = hub.ctx.store.artifacts.save({
      taskId: visualTask.id,
      runId: visDispatch.runId,
      kind: 'inbound_file',
      label: 'xss.html',
      mimeType: 'text/html',
      data: Buffer.from('<script>alert(1)</script>'),
      now: ts,
    })
    const htmlRes = await apiCall('GET', `/api/v1/artifacts/${htmlArt.id}`, { cookie, origin: ORIGIN })
    expect(htmlRes.status).toBe(200)
    expect(htmlRes.header('content-type')).toContain('application/octet-stream')
    expect(htmlRes.header('content-disposition')).toBe('attachment')
    expect(htmlRes.header('content-security-policy')).toContain('sandbox')

    // Round 6 P1 #3: Two distinct routeIndex values sharing identical redacted labels stay separated in Feishu header & uploads
    const visCollisionTask = await hub.ctx.orchestrator.createTask({
      prompt: '检查脱敏后同名路由的多路视觉对比',
      workspaceId: 'soren',
      subdir: 'Forma',
      profile: 'edit',
      origin: { source: 'feishu', feishu: { chatId: 'oc_p2p_r', chatType: 'p2p', messageId: 'm_vis_col_orig' } },
    }, { type: 'owner', id: 'ou_owner', channel: 'feishu' })
    const visColDisp = (await worker.waitFor('run.dispatch', f => (f.payload as { taskId: string }).taskId === visCollisionTask.id)).payload as { runId: string; taskId: string }
    const colUploadsBefore = fake.uploadedImages.length
    worker.events(visColDisp.runId, visColDisp.taskId, [
      { seq: 1, ts, kind: 'started', pid: 34, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      {
        seq: 2, ts: ts + 1, kind: 'visual', phase: 'before', status: 'passed',
        shots: [{ routeIndex: 0, route: '/?token=[REDACTED]', url: 'http://127.0.0.1:4173/?token=[REDACTED]', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 8, mimeType: 'image/jpeg', imageBase64: Buffer.from('col-before-0').toString('base64') }],
      },
      {
        seq: 3, ts: ts + 2, kind: 'visual', phase: 'after', status: 'passed',
        shots: [{ routeIndex: 1, route: '/?token=[REDACTED]', url: 'http://127.0.0.1:4173/?token=[REDACTED]', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 8, mimeType: 'image/jpeg', imageBase64: Buffer.from('col-after-1').toString('base64') }],
      },
      { seq: 4, ts: ts + 3, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 10, summary: '双路由对比完成' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(visCollisionTask.id)?.status === 'succeeded', { timeout: 10_000 })
    await eventually(() => fake.uploadedImages.length >= colUploadsBefore + 2, { timeout: 15_000 })
    const visColHdr = await eventually(() => [...fake.messages.values()].find(m =>
      m.target === 'm_vis_col_orig' && m.body.type === 'text' && m.body.text.includes('视觉验收截图')), { timeout: 10_000 })
    expect(visColHdr?.body.type === 'text' ? visColHdr.body.text : '').toContain('改前(/?token=[REDACTED] (#1))')
    expect(visColHdr?.body.type === 'text' ? visColHdr.body.text : '').toContain('改后(/?token=[REDACTED] (#2))')
  }, 30_000)

  it('analyzes project health, triggers scheduled morning briefing via FakeClock, and dispatches numeric/card actions with permission checks', async () => {
    // Pure health analyzer check
    const staleProject: ProjectOverview = {
      workerId: 'w1', workspaceId: 'soren', subdir: 'Forma', label: 'Forma', isGitRepo: true,
      workerOnline: true, allowedAdapters: ['codex', 'claude-code'], activeTasks: 0, totalTasks: 3,
      succeededTasks: 2, failedTasks: 1, latestTaskId: 'tsk_' + '0'.repeat(26), latestTaskNo: 3,
      latestVerification: 'failed', boardCapturedAt: 1000, lastActiveAt: 2000,
      board: {
        dir: 'present', capturedAt: 1000, agentsMd: { status: 'absent', bytes: 0 },
        files: [
          { file: 'PROJECT_STATE.md', status: 'present', bytes: 100, lines: 3, schemaOk: true, overBudget: true, content: '## Active Tech Debt\n- 重构导出逻辑' },
          { file: 'HANDOFF.md', status: 'present', bytes: 80, lines: 3, schemaOk: true, overBudget: false, content: '## Next\n- 补齐 E2E 用例\n\n## Open Questions\n- 是否启用缓存?' },
          { file: 'DECISIONS.md', status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false },
          { file: 'LESSONS.md', status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false },
        ],
      },
    }
    const analysis = analyzeProjectHealth(staleProject, 1000 + 8 * 86_400_000)
    expect(analysis.health).toBe('warning')
    expect(analysis.findings.map(f => f.category)).toEqual(
      expect.arrayContaining(['verification', 'board_budget', 'board_stale', 'open_questions', 'tech_debt']),
    )
    expect(analysis.actions.length).toBeGreaterThanOrEqual(2)

    // Schedule morning briefing 10 seconds ahead using FakeClock
    const clock = new FakeClock(Date.UTC(2026, 5, 1, 8, 59, 50))
    expect(nextDailyBriefingAt(clock.now(), 9, 0, 'UTC')).toBe(Date.UTC(2026, 5, 1, 9, 0, 0))

    useAdminToken()
    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      ...settings,
      server: { port: 0, allowInsecureWorker: true, timezone: 'UTC' },
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        requesterAllowlist: ['ou_req'],
        allowedChatIds: ['oc_group'],
        groupAudience: 'owner',
        allowGroupCommands: false,
        defaultWorkspaceId: 'soren',
        smartRouting: { enabled: true },
      },
      steward: {
        enabled: true,
        patrolIntervalMs: 3_600_000,
        briefingHour: 9,
        briefingMinute: 0,
        notifyChatIds: ['oc_group', 'oc_other_group'],
      },
    }, { clock, feishuTransport: fake })
    cleanups.push(cleanup)

    const worker = await FakeWorker.connect(hub, {
      workerId: 'w-steward',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['codex', 'claude-code', 'mock'],
        maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => worker.terminate())

    // Create a failed task so Forma has verification='failed' / actionable briefing
    await hub.ctx.orchestrator.createTask({ prompt: 'failing check', workspaceId: 'soren', subdir: 'Forma' }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    const failedDispatch = await worker.waitFor('run.dispatch')
    const fPayload = failedDispatch.payload as { runId: string; taskId: string }
    worker.events(fPayload.runId, fPayload.taskId, [
      { seq: 1, ts: clock.now(), kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: clock.now() + 1, kind: 'finished', status: 'failed', errorCode: 'NONZERO_EXIT', exitCode: 1, signal: null, durationMs: 5, summary: 'fail' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(fPayload.taskId)?.status === 'failed')

    // Advance FakeClock across 09:00 UTC -> TimerWheel triggers morning briefing & pushes cards per groupAudience!
    clock.advance(12_000)
    const ownerCardEntry = await eventually(() => [...fake.messages.entries()].find(([, m]) =>
      m.target === 'oc_group' && m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('briefing_run')))
    const reqCardEntry = await eventually(() => [...fake.messages.entries()].find(([, m]) =>
      m.target === 'oc_other_group' && m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('📋 项目状态')))
    expect(JSON.stringify(reqCardEntry![1].body)).not.toContain('briefing_run')
    expect(JSON.stringify(reqCardEntry![1].body)).not.toContain('推荐下一步')

    // Card callback requires bound messageId match (P1 #9)
    const propMatch = JSON.stringify(ownerCardEntry![1].body).match(/prp_[0-9A-HJKMNP-TV-Z]{26}/u)!
    const mismatchClick = await fake.click(reqCardEntry![0], 'ou_owner', { v: 1, a: 'briefing_run', p: propMatch[0]!, idx: 1 })
    expect(mismatchClick.toast.type).toBe('error')

    // Non-privileged requester cannot dispatch briefing via numeric reply "1"
    await fake.message('m_req_num', '1', 'ou_req', { chat_id: 'oc_group', chat_type: 'group' })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text === '无权执行此指令'))

    // Owner numeric reply "1" in group dispatches action #1 cleanly even with allowGroupCommands=false
    await fake.message('m_owner_num', '1', 'ou_owner', { chat_id: 'oc_group', chat_type: 'group' })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('已按简报建议 #1 派发任务')))

    // Manual REST briefing run & dispatch
    const { cookie, csrfToken } = await login(rest(hub))
    const runRes = await rest(hub)('POST', '/api/v1/briefings/run', {
      cookie,
      csrf: csrfToken,
      origin: ORIGIN,
      payload: { workspaceId: 'soren', subdir: 'Forma' },
    })
    expect(runRes.status).toBe(200)
    const list = runRes.json<Array<{ id: string }>>()
    expect(list.length).toBeGreaterThanOrEqual(1)
    const dispatchRes = await rest(hub)('POST', `/api/v1/briefings/${list[0]!.id}/actions/1/dispatch`, { cookie, csrf: csrfToken, origin: ORIGIN })
    expect(dispatchRes.status).toBe(201)
  }, 20_000)

  it('enforces capability negotiation gates for attachments, preflight, and visual events (P1 #12)', async () => {
    useAdminToken()
    const { hub, cleanup } = await openHarness(settings)
    cleanups.push(cleanup)
    const { cookie, csrfToken } = await login(rest(hub))
    const apiCall = rest(hub)

    // Worker WITHOUT attachments.v1 / preflight.v1 / visual.v1
    const noCap = await FakeWorker.connect(hub, {
      workerId: 'w-nocap',
      headers: {},
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['mock', 'codex'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => noCap.terminate())

    const preRes = await apiCall('POST', '/api/v1/personal/preflight', {
      cookie,
      csrf: csrfToken,
      origin: ORIGIN,
      payload: { workerId: 'w-nocap', workspaceId: 'soren', subdir: 'Forma', mode: 'flexible' },
    })
    expect(preRes.status).toBe(200)
    expect(preRes.json()).toMatchObject({ ok: false })
    expect(JSON.stringify(preRes.json())).toContain('preflight.v1')

    // Task with attachment stays queued and never dispatches to w-nocap (lacks attachments.v1)
    const attTask = await hub.ctx.orchestrator.createTask({
      prompt: '带图任务',
      workspaceId: 'soren',
      requiredWorkerId: 'w-nocap',
    }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' }, {
      initialArtifacts: [{ kind: 'inbound_image', label: 'a.png', mimeType: 'image/png', data: Buffer.from('png') }],
    })
    await new Promise(r => setTimeout(r, 150))
    expect(noCap.frames.some(f => f.type === 'run.dispatch')).toBe(false)
    expect(hub.ctx.orchestrator.getTask(attTask.id)?.status).toBe('queued')

    // Worker with blackboard.v1+verify.v1 only (no visual.v1): visual events are ignored on ingest
    const noVis = await FakeWorker.connect(hub, {
      workerId: 'w-novis',
      headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' },
      workspaces: [{ id: 'soren', label: 'Soren', allowedAdapters: ['mock'], maxProfile: 'edit', maxConcurrent: 1, isGitRepo: false }],
    })
    cleanups.push(async () => noVis.terminate())
    const plainTask = await hub.ctx.orchestrator.createTask({
      prompt: '无视觉能力节点',
      workspaceId: 'soren',
      requiredWorkerId: 'w-novis',
    }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    const disp = (await noVis.waitFor('run.dispatch')).payload as { runId: string; taskId: string }
    const ts = hub.ctx.clock.now()
    noVis.events(disp.runId, disp.taskId, [
      { seq: 1, ts, kind: 'started', pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      {
        seq: 2, ts: ts + 1, kind: 'visual', phase: 'after', status: 'passed',
        shots: [{ route: '/', url: 'http://127.0.0.1:4173/', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 5, mimeType: 'image/jpeg', imageBase64: Buffer.from('jpg').toString('base64') }],
      },
      { seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: 'done' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(plainTask.id)?.status === 'succeeded')
    expect(hub.ctx.orchestrator.listRunArtifacts(plainTask.id, disp.runId)).toEqual([])
  }, 20_000)

  it('verifies ArtifactStore integrity, unlinks purged artifacts on retention, and leaves visual imageBase64 uncorrupted (P1 #13, P1 #14, P2 #5)', async () => {
    useAdminToken()
    const { existsSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { hub, dir, cleanup } = await openHarness({
      ...settings,
      workers: { redactionPatterns: ['SECRETTOKENA'] },
    })
    cleanups.push(cleanup)
    const { cookie } = await login(rest(hub))

    const w = await FakeWorker.connect(hub, {
      workerId: 'w-art',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{ id: 'soren', label: 'Soren', allowedAdapters: ['mock'], maxProfile: 'edit', maxConcurrent: 2, isGitRepo: false }],
    })
    cleanups.push(async () => w.terminate())

    const task = await hub.ctx.orchestrator.createTask({ prompt: 'base64 完整性测试', workspaceId: 'soren' }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    const disp = (await w.waitFor('run.dispatch')).payload as { runId: string; taskId: string }
    const ts = hub.ctx.clock.now()
    w.events(disp.runId, disp.taskId, [
      { seq: 1, ts, kind: 'started', pid: 2, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      {
        seq: 2, ts: ts + 1, kind: 'visual', phase: 'after', status: 'passed',
        shots: [{ route: '/', url: 'http://127.0.0.1:4173/', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 5, mimeType: 'image/jpeg', imageBase64: 'SECRETTOKENA' }],
      },
      { seq: 3, ts: ts + 2, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: 'ok' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'succeeded')
    const rows = hub.ctx.store.artifacts.listForRun(disp.runId)
    expect(rows).toHaveLength(1)
    expect(hub.ctx.store.artifacts.readBytes(rows[0]!)?.equals(Buffer.from('SECRETTOKENA', 'base64'))).toBe(true)

    // Corrupt artifact file on disk -> readBytes rejects digest mismatch and HTTP GET returns 404
    const absArt = join(dir, 'artifacts', rows[0]!.storageRelPath)
    expect(existsSync(absArt)).toBe(true)
    writeFileSync(absArt, Buffer.from('corrupt-bytes!'))
    expect(hub.ctx.store.artifacts.readBytes(rows[0]!)).toBeUndefined()
    const badRes = await rest(hub)('GET', `/api/v1/artifacts/${rows[0]!.id}`, { cookie, origin: ORIGIN })
    expect(badRes.status).toBe(404)

    // Retention cleanup purges run_artifacts rows and unlinks file from disk
    const freshRow = hub.ctx.store.artifacts.save({
      taskId: task.id, runId: disp.runId, kind: 'visual_after', label: '/keep', mimeType: 'image/jpeg', data: Buffer.from('fresh-img'), now: ts + 3,
    })
    const freshAbs = join(dir, 'artifacts', freshRow.storageRelPath)
    expect(existsSync(freshAbs)).toBe(true)
    const unlinks: Array<{ id: string; storageRelPath: string }> = []
    hub.ctx.store.tx(db => purgeLogSlice(db, ts + 40 * 86_400_000, { succeeded: 30, other: 90 }, 500, unlinks))
    for (const u of unlinks) hub.ctx.store.artifacts.unlink(u)
    expect(unlinks.map(u => u.id)).toContain(freshRow.id)
    expect(existsSync(freshAbs)).toBe(false)
    expect(hub.ctx.store.artifacts.get(freshRow.id)).toBeUndefined()
  }, 20_000)

  it('enforces Feishu media byte limits, blocks ASR HTTP redirects, preserves followUp attachments, and isolates /briefing requester cards (P1 #16, P1 #17, P2 #7)', async () => {
    const asr302 = createServer((_req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/steal' })
      res.end()
    })
    await new Promise<void>(resolve => asr302.listen(0, '127.0.0.1', resolve))
    const asrPort = (asr302.address() as AddressInfo).port
    cleanups.push(() => new Promise<void>(resolve => asr302.close(() => resolve())))

    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      permissions: { autoApproveAll: true, allowRequesterCommands: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        requesterAllowlist: ['ou_req'],
        allowedChatIds: ['oc_group'],
        allowGroupCommands: true,
        defaultWorkspaceId: 'soren',
        chatDefaults: { oc_group: { workspaceId: 'soren', subdir: 'Forma' } },
        multimodal: {
          enabled: true,
          inlineMaxBytes: 2048,
          asrUrl: `http://127.0.0.1:${asrPort}/v1/audio`,
        },
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: false },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    const worker = await FakeWorker.connect(hub, {
      workerId: 'w-cap',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['mock', 'codex'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => worker.terminate())

    // 1. Cumulative oversized post media rejected before task creation
    fake.resources.set('big_1', { data: Buffer.alloc(1500, 1), mimeType: 'image/png' })
    fake.resources.set('big_2', { data: Buffer.alloc(1500, 2), mimeType: 'image/png' })
    await fake.message('m_oversize', '', 'ou_owner', {
      chat_id: 'oc_p2p_cap', chat_type: 'p2p', mentions: [], message_type: 'post',
      content: JSON.stringify({ zh_cn: { content: [[{ tag: 'img', image_key: 'big_1' }, { tag: 'img', image_key: 'big_2' }]] } }),
    })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('超出模型单次处理上限')))
    expect(hub.ctx.orchestrator.listTasks({}).items).toHaveLength(0)

    // 2. ASR 302 redirect is refused (redirect: 'error') -> error notification
    fake.resources.set('aud_302', { data: Buffer.from('ogg-bytes'), mimeType: 'audio/ogg' })
    await fake.message('m_302', '', 'ou_owner', {
      chat_id: 'oc_p2p_cap', chat_type: 'p2p', mentions: [], message_type: 'audio',
      content: JSON.stringify({ file_key: 'aud_302' }),
    })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('语音转写服务暂不可用')))

    // 3. Initial attachments are retained across followUp
    fake.resources.set('ok_img', { data: Buffer.from('small-png'), mimeType: 'image/png' })
    await fake.message('m_ok_img', '', 'ou_owner', {
      chat_id: 'oc_p2p_cap', chat_type: 'p2p', mentions: [], message_type: 'image',
      content: JSON.stringify({ image_key: 'ok_img' }),
    })
    const dFirst = RunDispatch.parse((await worker.waitFor('run.dispatch')).payload)
    expect(dFirst.attachments).toHaveLength(1)
    worker.events(dFirst.runId, dFirst.taskId, [
      { seq: 1, ts: hub.ctx.clock.now(), kind: 'started', pid: 10, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: hub.ctx.clock.now() + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: 'first done' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(dFirst.taskId)?.status === 'succeeded')
    const card = await eventually(() => hub.ctx.store.repos.feishu.messages(dFirst.taskId).find(m => m.role === 'progress_card'))
    fake.resources.set('follow_img', { data: Buffer.from('follow-png'), mimeType: 'image/png' })
    await fake.message('m_follow_img', '', 'ou_owner', {
      chat_id: 'oc_p2p_cap', chat_type: 'p2p', parent_id: card!.messageId, mentions: [],
      message_type: 'image', content: JSON.stringify({ image_key: 'follow_img' }),
    })
    const dFollow = RunDispatch.parse((await worker.waitFor('run.dispatch', f => (f.payload as { taskId: string }).taskId !== dFirst.taskId)).payload)
    expect(dFollow.attachments).toHaveLength(1)

    // 4. Requester /briefing is scoped to chat project and omits internal board findings from card
    await fake.message('m_req_brf', '/briefing', 'ou_req', { chat_id: 'oc_group', chat_type: 'group' })
    const brfCard = await eventually(() => [...fake.messages.values()].find(m =>
      m.target === 'm_req_brf' && m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('📋 项目状态 · soren/Forma')))
    expect(brfCard).toBeTruthy()
    expect(JSON.stringify(brfCard!.body)).toContain('项目状态良好')
    expect(JSON.stringify(brfCard!.body)).not.toContain('推荐下一步')
    expect(JSON.stringify(brfCard!.body)).not.toContain('briefing_run')
  }, 20_000)

  it('guards ambiguous proposals, prevents rollback after task creation, checks autopilot 409 conflicts, and handles DST briefing schedules (P1 #18, P1 #19, P2 #1, P2 #8)', async () => {
    // P2 #8 DST-safe schedule in America/New_York
    // 2026-03-08 is US spring-forward (02:00 -> 03:00): 01:30 EST = 06:30 UTC; next 09:00 EDT = 13:00 UTC
    const springNow = Date.UTC(2026, 2, 8, 6, 30)
    expect(nextDailyBriefingAt(springNow, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 13, 0))
    // 2026-11-01 is US fall-back (02:00 -> 01:00): 00:30 EDT = 04:30 UTC; next 09:00 EST = 14:00 UTC
    const fallNow = Date.UTC(2026, 10, 1, 4, 30)
    expect(nextDailyBriefingAt(fallNow, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 14, 0))

    useAdminToken()
    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      ...settings,
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: true },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    const worker = await FakeWorker.connect(hub, {
      workerId: 'w-prop',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{
        id: 'soren', label: 'Soren', allowedAdapters: ['mock', 'codex', 'claude-code', 'antigravity'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }],
      }],
    })
    cleanups.push(async () => worker.terminate())

    // Two pending proposals in same chat+thread trigger ambiguity guard on text "干"
    await fake.message('m_p1', '从零搭建完整实现模块A并且自动测试验收闭环', 'ou_owner', { chat_id: 'oc_p2p_amb', chat_type: 'p2p', mentions: [] })
    await fake.message('m_p2', '从零搭建完整实现模块B并且自动测试验收闭环', 'ou_owner', { chat_id: 'oc_p2p_amb', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].filter(m => (m.target === 'm_p1' || m.target === 'm_p2') && m.body.type === 'interactive').length >= 2)
    await fake.message('m_amb_go', '干', 'ou_owner', { chat_id: 'oc_p2p_amb', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.body.type === 'text' && m.body.text.includes('当前有多个待确认建议')))

    // Proposal direct click does NOT roll back proposal when task already created even if delivery fails
    const cards = [...fake.messages.entries()].filter(([, m]) => (m.target === 'm_p1' || m.target === 'm_p2') && m.body.type === 'interactive')
    const cardMsgId = cards[0]![0]
    const pid = JSON.stringify(cards[0]![1].body).match(/prp_[0-9A-HJKMNP-TV-Z]{26}/u)![0]!
    const origReply = fake.replyMessage.bind(fake)
    fake.replyMessage = async () => { throw Object.assign(new Error('bad request'), { response: { status: 400 } }) }
    const directClick = await fake.click(cardMsgId, 'ou_owner', { v: 1, a: 'proposal_direct', p: pid })
    fake.replyMessage = origReply
    expect(directClick.toast.type).toBe('success')
    expect(hub.ctx.store.repos.prepare('SELECT status FROM feishu_proposals WHERE id=?').pluck().get(pid)).toBe('accepted')

    // Autopilot conflicting idempotency options returns 409
    const propBinding = { ...bindingFixture, workerId: 'w-prop' }
    const { cookie, csrfToken } = await login(rest(hub))
    const preP = hub.ctx.orchestrator.preflightProject({ workerId: 'w-prop', workspaceId: 'soren', subdir: 'Forma', mode: 'flexible' })
    const pf = await worker.waitFor('project.preflight', 5000)
    await worker.ackCommand(pf, { result: { preflight: { ok: true, binding: propBinding, checks: ['self-check'] } } })
    await preP
    const s1P = rest(hub)('POST', '/api/v1/personal/autopilot', {
      cookie, csrf: csrfToken, origin: ORIGIN,
      payload: { projectId: 'aut_conflict_1', workerId: 'w-prop', workspaceId: 'soren', subdir: 'Forma', inlinePrompt: 'Task 1', autoCommit: true, autoPush: false },
    })
    const pf2 = await worker.waitFor('project.preflight', f => f.id !== pf.id)
    await worker.ackCommand(pf2, { result: { preflight: { ok: true, binding: propBinding, checks: ['self-check'] } } })
    const s1 = await s1P
    expect(s1.status).toBe(201)

    const s2P = rest(hub)('POST', '/api/v1/personal/autopilot', {
      cookie, csrf: csrfToken, origin: ORIGIN,
      payload: { projectId: 'aut_conflict_1', workerId: 'w-prop', workspaceId: 'soren', subdir: 'Forma', inlinePrompt: 'Different task', autoCommit: true, autoPush: false },
    })
    const pf3 = await worker.waitFor('project.preflight', f => f.id !== pf.id && f.id !== pf2.id)
    await worker.ackCommand(pf3, { result: { preflight: { ok: true, binding: propBinding, checks: ['self-check'] } } })
    const s2 = await s2P
    expect(s2.status).toBe(409)
  }, 20_000)

  it('isolates sibling DB artifact stores, restores backups safely for new writes, scopes rotation per store, and verifies backup crash recovery (P1 #2/#3/#4/#5/#6)', async () => {
    const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs')
    const Database = (await import('better-sqlite3')).default
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ArtifactStore } = await import('../src/plugins/store-sqlite/artifacts.js')
    const dir = mkdtempSync(join(tmpdir(), 'art-iso-'))
    const opened: Array<{ close(): void }> = []
    cleanups.push(async () => {
      for (const s of opened.splice(0).reverse()) {
        try { s.close() } catch { /* ignore */ }
      }
      rmSync(dir, { recursive: true, force: true })
    })

    const clock = new FakeClock(1_700_000_000_000)
    const hubStore = openStore({ path: join(dir, 'hub.sqlite') }, clock)
    opened.push(hubStore)
    hubStore.tx(db => {
      db.tasks.insert({
        id: 'tsk_' + '1'.repeat(26), taskNo: 1, version: 0, status: 'queued', source: 'dashboard',
        originJson: { source: 'dashboard' }, requesterType: 'owner', requesterId: 'ou_owner',
        title: 'art task', prompt: 'art task', workspaceId: 'soren', profile: 'edit', priority: 0, timeoutMs: 600_000,
        maxAttempts: 3, policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, queuedAt: 1000, createdAt: 1000, updatedAt: 1000,
      })
    })
    const art = hubStore.artifacts.save({
      taskId: 'tsk_' + '1'.repeat(26), runId: null, kind: 'inbound_image', label: 'a.png',
      mimeType: 'image/png', data: Buffer.from('hub-png-bytes'), now: 1000,
    })
    const hubArtPath = join(dir, 'artifacts', art.storageRelPath)
    expect(existsSync(hubArtPath)).toBe(true)

    // Opening sibling DBs in same directory uses <basename>.artifacts & separates app.sqlite vs app.db
    const siblingStore = openStore({ path: join(dir, 'sibling.sqlite') }, clock)
    opened.push(siblingStore)
    expect(siblingStore.artifacts.root).toBe(join(dir, 'sibling.sqlite.artifacts'))
    expect(existsSync(hubArtPath)).toBe(true)
    expect(readFileSync(hubArtPath).equals(Buffer.from('hub-png-bytes'))).toBe(true)
    const appSqliteStore = openStore({ path: join(dir, 'app.sqlite') }, clock)
    opened.push(appSqliteStore)
    const appDbStore = openStore({ path: join(dir, 'app.db') }, clock)
    opened.push(appDbStore)
    expect(appSqliteStore.artifacts.root).toBe(join(dir, 'app.sqlite.artifacts'))
    expect(appDbStore.artifacts.root).toBe(join(dir, 'app.db.artifacts'))

    // Foreign store pointing at hub's artifacts must refuse writes with ARTIFACT_STORE_OWNERSHIP_MISMATCH
    const foreignArtStore = new ArtifactStore(join(dir, 'hub.sqlite'), () => hubStore.repos, 'foreign-store-id')
    expect(() => foreignArtStore.save({
      taskId: 'tsk_' + '1'.repeat(26), runId: null, kind: 'inbound_image', label: 'bad.png',
      mimeType: 'image/png', data: Buffer.from('bad'), now: 1001, repos: hubStore.repos,
    })).toThrow(/ARTIFACT_STORE_OWNERSHIP_MISMATCH/)

    // Verified backup copies matching DB+artifacts pair, separates sibling backup files, and enforces identity
    const backupDir = join(dir, 'backups')
    await expect(dailyBackup(hubStore.repos, join(dir, 'hub.sqlite'), backupDir, '2026-01-01', hubStore.artifacts.root!)).resolves.toBe(true)
    expect(existsSync(join(backupDir, 'hub-2026-01-01.sqlite'))).toBe(true)
    expect(existsSync(join(backupDir, 'artifacts-2026-01-01', art.storageRelPath))).toBe(true)
    await expect(dailyBackup(siblingStore.repos, join(dir, 'sibling.sqlite'), backupDir, '2026-01-01', siblingStore.artifacts.root!)).resolves.toBe(true)
    expect(existsSync(join(backupDir, 'sibling.sqlite-2026-01-01.sqlite'))).toBe(true)
    expect(existsSync(join(backupDir, 'sibling.sqlite.artifacts-2026-01-01'))).toBe(true)

    // Another store sharing the same backup filename & date rejects with BACKUP_TARGET_OWNER_MISMATCH
    const otherOwnerBackupDir = join(dir, 'other-backups')
    const hubDir2 = join(dir, 'second-hub')
    mkdirSync(hubDir2, { recursive: true })
    const hubStore2 = openStore({ path: join(hubDir2, 'hub.sqlite') }, clock)
    opened.push(hubStore2)
    await expect(dailyBackup(hubStore2.repos, join(hubDir2, 'hub.sqlite'), backupDir, '2026-01-01', hubStore2.artifacts.root!))
      .rejects.toThrow(/BACKUP_TARGET_OWNER_MISMATCH/)

    // Round 4 P1 #3: Restoring published backup DB + artifact directory allows reads AND new artifact saves
    const restoreDir = join(dir, 'restored')
    mkdirSync(restoreDir, { recursive: true })
    copyFileSync(join(backupDir, 'hub-2026-01-01.sqlite'), join(restoreDir, 'hub.sqlite'))
    cpSync(join(backupDir, 'artifacts-2026-01-01'), join(restoreDir, 'artifacts'), { recursive: true })
    const restoreStore = openStore({ path: join(restoreDir, 'hub.sqlite') }, clock)
    opened.push(restoreStore)
    expect(restoreStore.artifacts.readBytes(art)?.equals(Buffer.from('hub-png-bytes'))).toBe(true)
    const art2 = restoreStore.artifacts.save({
      taskId: 'tsk_' + '1'.repeat(26), runId: null, kind: 'inbound_image', label: 'b.png',
      mimeType: 'image/png', data: Buffer.from('restored-new-bytes'), now: 2000, repos: restoreStore.repos,
    })
    expect(restoreStore.artifacts.readBytes(art2)?.equals(Buffer.from('restored-new-bytes'))).toBe(true)

    // Round 4 P1 #4 & Round 5 P1 #4/#5: Unowned DB & non-SQLite stubs untouched, and orphan artifact dir does not evict retained DB's artifacts
    const unownedDb = new Database(join(backupDir, 'hub-2026-01-02.sqlite'))
    unownedDb.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE run_artifacts(id TEXT PRIMARY KEY, storage_rel_path TEXT, bytes INTEGER, sha256 TEXT);')
    unownedDb.close()
    await expect(dailyBackup(hubStore2.repos, join(hubDir2, 'hub.sqlite'), backupDir, '2026-01-02', hubStore2.artifacts.root!))
      .rejects.toThrow(/BACKUP_TARGET_OWNER_MISMATCH/)
    writeFileSync(join(backupDir, 'hub-2026-01-09.sqlite'), 'stub!')
    const store2Id = hubStore2.repos.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() as string
    mkdirSync(join(backupDir, 'artifacts-2026-01-08'), { recursive: true })
    writeFileSync(join(backupDir, 'artifacts-2026-01-08', '.agent-hub-backup.json'), JSON.stringify({ storeId: store2Id, date: '2026-01-08' }))
    for (let day = 10; day <= 17; day++) {
      await expect(dailyBackup(hubStore2.repos, join(hubDir2, 'hub.sqlite'), backupDir, `2026-01-${day}`, hubStore2.artifacts.root!)).resolves.toBe(true)
    }
    expect(existsSync(join(backupDir, 'hub-2026-01-09.sqlite'))).toBe(true)
    expect(existsSync(join(backupDir, 'artifacts-2026-01-08'))).toBe(false)
    expect(existsSync(join(backupDir, 'hub-2026-01-10.sqlite'))).toBe(false)
    expect(existsSync(join(backupDir, 'artifacts-2026-01-10'))).toBe(false)
    for (let day = 11; day <= 17; day++) {
      expect(existsSync(join(backupDir, `hub-2026-01-${day}.sqlite`))).toBe(true)
      expect(existsSync(join(backupDir, `artifacts-2026-01-${day}`))).toBe(true)
    }
    expect(existsSync(join(backupDir, 'hub-2026-01-01.sqlite'))).toBe(true)
    expect(existsSync(join(backupDir, 'artifacts-2026-01-01', art.storageRelPath))).toBe(true)
    expect(existsSync(join(backupDir, 'hub-2026-01-02.sqlite'))).toBe(true)

    // Round 6 P1 #4 & Round 7 P1 #4: Incomplete historical backup (missing file OR mismatched ownership marker) must NOT occupy a 7-day slot to evict an older complete pair
    const rotHubDir = join(dir, 'rot-hub')
    const rotBackupDir = join(dir, 'rot-backups')
    mkdirSync(rotHubDir, { recursive: true })
    const rotStore = openStore({ path: join(rotHubDir, 'hub.sqlite') }, clock)
    opened.push(rotStore)
    rotStore.tx(db => {
      db.tasks.insert({
        id: 'tsk_' + '2'.repeat(26), taskNo: 1, version: 0, status: 'queued', source: 'dashboard',
        originJson: { source: 'dashboard' }, requesterType: 'owner', requesterId: 'ou_owner',
        title: 'rot task', prompt: 'rot task', workspaceId: 'soren', profile: 'edit', priority: 0, timeoutMs: 600_000,
        maxAttempts: 3, policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, queuedAt: 1000, createdAt: 1000, updatedAt: 1000,
      })
    })
    const rotArt = rotStore.artifacts.save({
      taskId: 'tsk_' + '2'.repeat(26), runId: null, kind: 'inbound_image', label: 'r.png',
      mimeType: 'image/png', data: Buffer.from('rot-complete-bytes'), now: 1000,
    })
    for (let day = 10; day <= 15; day++) {
      await expect(dailyBackup(rotStore.repos, join(rotHubDir, 'hub.sqlite'), rotBackupDir, `2026-01-${day}`, rotStore.artifacts.root!)).resolves.toBe(true)
    }
    copyFileSync(join(rotBackupDir, 'hub-2026-01-15.sqlite'), join(rotBackupDir, 'hub-2026-01-16.sqlite'))
    cpSync(join(rotBackupDir, 'artifacts-2026-01-15'), join(rotBackupDir, 'artifacts-2026-01-16'), { recursive: true })
    rmSync(join(rotBackupDir, 'artifacts-2026-01-16', rotArt.storageRelPath))
    // Foreign ownership marker with all artifact bytes intact must also be treated as incomplete (not evicting 2026-01-10)
    copyFileSync(join(rotBackupDir, 'hub-2026-01-15.sqlite'), join(rotBackupDir, 'hub-2026-01-17.sqlite'))
    cpSync(join(rotBackupDir, 'artifacts-2026-01-15'), join(rotBackupDir, 'artifacts-2026-01-17'), { recursive: true })
    writeFileSync(join(rotBackupDir, 'artifacts-2026-01-17', '.agent-hub-backup.json'), JSON.stringify({ storeId: 'foreign-owner', date: '2026-01-17' }))
    // Conflicting markers (matching backup marker + foreign owner marker) must block both verification AND recursive deletion (Round 8 P1 #6)
    const rotStoreId = String(rotStore.repos.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get())
    copyFileSync(join(rotBackupDir, 'hub-2026-01-15.sqlite'), join(rotBackupDir, 'hub-2026-01-09.sqlite'))
    cpSync(join(rotBackupDir, 'artifacts-2026-01-15'), join(rotBackupDir, 'artifacts-2026-01-09'), { recursive: true })
    writeFileSync(join(rotBackupDir, 'artifacts-2026-01-09', '.agent-hub-backup.json'), JSON.stringify({ storeId: rotStoreId, date: '2026-01-09' }))
    writeFileSync(join(rotBackupDir, 'artifacts-2026-01-09', '.agent-hub-owner.json'), JSON.stringify({ storeId: 'foreign-owner' }))
    await expect(dailyBackup(rotStore.repos, join(rotHubDir, 'hub.sqlite'), rotBackupDir, '2026-01-19', rotStore.artifacts.root!)).resolves.toBe(true)
    expect(existsSync(join(rotBackupDir, 'hub-2026-01-10.sqlite'))).toBe(true)
    expect(existsSync(join(rotBackupDir, 'artifacts-2026-01-10', rotArt.storageRelPath))).toBe(true)
    expect(existsSync(join(rotBackupDir, 'hub-2026-01-09.sqlite'))).toBe(false)
    expect(existsSync(join(rotBackupDir, 'artifacts-2026-01-09', rotArt.storageRelPath))).toBe(true)
    await expect(dailyBackup(rotStore.repos, join(rotHubDir, 'hub.sqlite'), rotBackupDir, '2026-01-20', rotStore.artifacts.root!)).resolves.toBe(true)
    expect(existsSync(join(rotBackupDir, 'hub-2026-01-10.sqlite'))).toBe(false)
    expect(existsSync(join(rotBackupDir, 'artifacts-2026-01-10'))).toBe(false)

    // Conflicting markers also prevent deletion during interrupted-publication recovery
    mkdirSync(join(rotBackupDir, 'artifacts-2026-01-22'), { recursive: true })
    writeFileSync(join(rotBackupDir, 'artifacts-2026-01-22', '.agent-hub-backup.json'), JSON.stringify({ storeId: rotStoreId, date: '2026-01-22' }))
    writeFileSync(join(rotBackupDir, 'artifacts-2026-01-22', '.agent-hub-owner.json'), JSON.stringify({ storeId: 'foreign-owner' }))
    await expect(dailyBackup(rotStore.repos, join(rotHubDir, 'hub.sqlite'), rotBackupDir, '2026-01-22', rotStore.artifacts.root!))
      .rejects.toThrow(/BACKUP_ARTIFACT_TARGET_CONFLICT/)
    expect(existsSync(join(rotBackupDir, 'artifacts-2026-01-22', '.agent-hub-owner.json'))).toBe(true)

    // Interrupted publication leaving only matching artifacts-<date> recovers on retry; foreign dir fails closed
    await expect(dailyBackup(hubStore.repos, join(dir, 'hub.sqlite'), backupDir, '2026-01-03', hubStore.artifacts.root!)).resolves.toBe(true)
    rmSync(join(backupDir, 'hub-2026-01-03.sqlite'))
    await expect(dailyBackup(hubStore.repos, join(dir, 'hub.sqlite'), backupDir, '2026-01-03', hubStore.artifacts.root!)).resolves.toBe(true)
    expect(existsSync(join(backupDir, 'hub-2026-01-03.sqlite'))).toBe(true)
    mkdirSync(join(backupDir, 'artifacts-2026-01-04'), { recursive: true })
    await expect(dailyBackup(hubStore.repos, join(dir, 'hub.sqlite'), backupDir, '2026-01-04', hubStore.artifacts.root!))
      .rejects.toThrow(/BACKUP_ARTIFACT_TARGET_CONFLICT/)

    // :memory: store containing artifact rows refuses backup without reader, and succeeds WITH memory artifact reader (Round 8 P2 #10)
    const memStore = openStore({ path: ':memory:' }, clock)
    opened.push(memStore)
    memStore.tx(db => {
      db.tasks.insert({
        id: 'tsk_' + '9'.repeat(26), taskNo: 1, version: 0, status: 'queued', source: 'dashboard',
        originJson: { source: 'dashboard' }, requesterType: 'owner', requesterId: 'ou_owner',
        title: 'mem task', prompt: 'mem task', workspaceId: 'soren', profile: 'edit', priority: 0, timeoutMs: 600_000,
        maxAttempts: 3, policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, queuedAt: 1000, createdAt: 1000, updatedAt: 1000,
      })
    })
    const memArt = memStore.artifacts.save({
      taskId: 'tsk_' + '9'.repeat(26), runId: null, kind: 'inbound_image', label: 'm.png',
      mimeType: 'image/png', data: Buffer.from('mem-png'), now: 1000,
    })
    await expect(dailyBackup(memStore.repos, ':memory:', otherOwnerBackupDir, '2026-01-05')).rejects.toThrow(/BACKUP_ARTIFACTS_UNAVAILABLE/)
    await expect(dailyBackup(memStore.repos, ':memory:', otherOwnerBackupDir, '2026-01-05', undefined, row => memStore.artifacts.readBytes(row as never))).resolves.toBe(true)
    expect(existsSync(join(otherOwnerBackupDir, 'hub-2026-01-05.sqlite'))).toBe(true)
    expect(readFileSync(join(otherOwnerBackupDir, 'artifacts-2026-01-05', memArt.storageRelPath)).equals(Buffer.from('mem-png'))).toBe(true)

    // Batched async reconcile removes orphan & temp artifact files across batches without touching live files (Round 8 P2 #9)
    const recTaskId = 'tsk_' + '8'.repeat(26)
    const recDir = join(dir, 'artifacts', recTaskId)
    mkdirSync(recDir, { recursive: true })
    const orphanFile = join(recDir, 'art_' + '0'.repeat(26) + '.png')
    const tmpFile = join(recDir, 'art_' + '1'.repeat(26) + '.png.tmp-deadbeef')
    writeFileSync(orphanFile, 'orphan')
    writeFileSync(tmpFile, 'tmp')
    await expect(hubStore.artifacts.reconcileAsync(hubStore.repos, { batchFiles: 1 })).resolves.toBe(2)
    expect(existsSync(orphanFile)).toBe(false)
    expect(existsSync(tmpFile)).toBe(false)
    expect(existsSync(hubArtPath)).toBe(true)

    // Corrupting live artifact fails a new backup day BEFORE publishing either DB or artifacts
    writeFileSync(hubArtPath, Buffer.from('corrupt-live-data!'))
    await expect(dailyBackup(hubStore.repos, join(dir, 'hub.sqlite'), backupDir, '2026-01-19', hubStore.artifacts.root!)).rejects.toThrow(/DIGEST_MISMATCH|UNVERIFIED/)
    expect(existsSync(join(backupDir, 'hub-2026-01-19.sqlite'))).toBe(false)
    expect(existsSync(join(backupDir, 'artifacts-2026-01-19'))).toBe(false)

    // Symlinked artifacts directory must be refused cleanly
    const symDir = join(dir, 'symtest')
    const outsideDir = join(dir, 'outside')
    mkdirSync(symDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    let symCreated = false
    try {
      symlinkSync(outsideDir, join(symDir, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
      symCreated = true
    } catch { /* Symlink/junction creation might be restricted on some environments */ }
    if (symCreated) {
      expect(() => openStore({ path: join(symDir, 'hub.sqlite') }, clock)).toThrow(/UNSAFE_ARTIFACT_ROOT/)
    }
  })

  it('requires verify_final checks for flexible autoCommit: false with checks (P1 #7), fails dispatch on unreadable attachments (P1 #12), prevents method suggestion duplicates (P1 #14), merges multi-route visuals (P2 #3), isolates thread proposals (P1 #10), scopes /auto stop (P1 #11), and scopes steward subdirs per worker (P2 #6)', async () => {
    useAdminToken()
    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      ...settings,
      permissions: { autoApproveAll: true },
      workers: { capabilities: ['attachments.v1', 'blackboard.v1', 'checks-digest.v2', 'preflight.v1', 'verify.v1', 'visual.v1'] },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'ws_a',
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: true },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    const { unlinkSync } = await import('node:fs')
    const w1 = await FakeWorker.connect(hub, {
      workerId: 'w-1',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [
        { id: 'ws_a', label: 'Workspace A', allowedAdapters: ['mock', 'codex'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false },
        { id: 'ws_b', label: 'Workspace B', allowedAdapters: ['mock', 'codex'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false },
        { id: 'shared_ws', label: 'Shared WS', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false, projects: [{ dir: 'SubApp', isGitRepo: true }] },
      ],
    })
    cleanups.push(async () => w1.terminate())
    const w2 = await FakeWorker.connect(hub, {
      workerId: 'w-2',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{ id: 'shared_ws', label: 'Shared WS', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false }],
    })
    cleanups.push(async () => w2.terminate())

    // P2 #6: w-1 having SubApp inside shared_ws must NOT suppress w-2's root shared_ws briefing
    const w2Briefings = hub.ctx.orchestrator.runBriefing('manual', { workerId: 'w-2', workspaceId: 'shared_ws' })
    expect(w2Briefings).toHaveLength(1)
    expect(w2Briefings[0]?.workerId).toBe('w-2')
    expect(w2Briefings[0]?.subdir).toBe('')

    // P1 #12: Corrupted/unlinked required inbound attachment fails dispatch cleanly instead of stripping attachment
    const badTask = await hub.ctx.orchestrator.createTask({
      prompt: '根据附件截图排查', workspaceId: 'ws_a', requiredWorkerId: 'w-bad-att',
    }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' }, {
      initialArtifacts: [{ kind: 'inbound_image', label: 'gone.png', mimeType: 'image/png', data: Buffer.from('img2') }],
    })
    const badArt = hub.ctx.store.artifacts.listForTask(badTask.id)[0]!
    unlinkSync((await import('node:path')).join(hub.ctx.store.artifacts.root!, badArt.storageRelPath))
    const wBad = await FakeWorker.connect(hub, {
      workerId: 'w-bad-att',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{ id: 'ws_a', label: 'Workspace A', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false }],
    })
    cleanups.push(async () => wBad.terminate())
    await eventually(() => hub.ctx.orchestrator.getTask(badTask.id)?.status === 'failed')
    expect(wBad.frames.filter(f => f.type === 'run.dispatch' && (f.payload as { taskId: string }).taskId === badTask.id)).toEqual([])

    // P2 #3 & Round 5 P1 #3: Multi-route visual events on Hub merge shots by routeIndex (even when routes redact to identical labels!) & keep aggregate status='failed'
    const visTask = await hub.ctx.orchestrator.createTask({ prompt: '多路由视觉验收', workspaceId: 'ws_a', requiredWorkerId: 'w-1' }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    const vDisp = (await w1.waitFor('run.dispatch', f => (f.payload as { taskId: string }).taskId === visTask.id)).payload as { runId: string; taskId: string }
    const vTs = hub.ctx.clock.now()
    w1.events(vDisp.runId, vDisp.taskId, [
      { seq: 1, ts: vTs, kind: 'started', pid: 40, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: vTs + 1, kind: 'visual', phase: 'after', status: 'failed', shots: [{ routeIndex: 0, route: '/?k=[REDACTED:TOK]', url: 'http://127.0.0.1:4173/?k=[REDACTED:TOK]', statusCode: 500, blankPage: false, consoleErrors: ['500 err'], pageErrors: [], durationMs: 10 }] },
      { seq: 3, ts: vTs + 2, kind: 'visual', phase: 'after', status: 'passed', shots: [{ routeIndex: 1, route: '/?k=[REDACTED:TOK]', url: 'http://127.0.0.1:4173/?k=[REDACTED:TOK]', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [], durationMs: 10 }] },
      { seq: 4, ts: vTs + 3, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 15, summary: 'done' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(visTask.id)?.status === 'succeeded')
    const rec = (hub.ctx.store.repos.runs.get(vDisp.runId)?.harnessJson as { visual?: { after?: { status: string; shots: Array<{ routeIndex?: number; route: string }> } } })
    expect(rec.visual?.after?.status).toBe('failed')
    expect(rec.visual?.after?.shots.map(s => s.routeIndex)).toEqual([0, 1])

    // P1 #10: 12 pending proposals in thread_B must NOT hide 2 ambiguous pending proposals in thread_A
    const nowMs = hub.ctx.clock.now()
    const { createProposal } = await import('../src/plugins/channel-feishu/smart-router.js')
    hub.ctx.store.tx(db => {
      createProposal(db, { kind: 'autopilot', chatId: 'oc_busy', messageId: 'om_a1', actorOpenId: 'ou_owner', payload: { workspaceId: 'ws_a', prompt: 'A1', threadId: 'th_A' }, now: nowMs })
      createProposal(db, { kind: 'autopilot', chatId: 'oc_busy', messageId: 'om_a2', actorOpenId: 'ou_owner', payload: { workspaceId: 'ws_a', prompt: 'A2', threadId: 'th_A' }, now: nowMs + 1 })
      for (let i = 0; i < 12; i++) {
        createProposal(db, { kind: 'autopilot', chatId: 'oc_busy', messageId: `om_b_${i}`, actorOpenId: 'ou_owner', payload: { workspaceId: 'ws_a', prompt: `B${i}`, threadId: 'th_B' }, now: nowMs + 10 + i })
      }
    })
    await fake.message('m_busy_go', '干', 'ou_owner', { chat_id: 'oc_busy', chat_type: 'p2p', root_id: 'th_A', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_busy_go' && m.body.type === 'text' && m.body.text.includes('当前有多个待确认建议')))

    // P1 #11: /auto stop in chat scoped to ws_a must NOT stop active project running in ws_b
    const wsBBinding = { ...bindingFixture, workerId: 'w-1', workspaceId: 'ws_b', subdir: undefined, root: '/ws/b' }
    hub.ctx.store.repos.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,phase,control,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('aut_ws_b', 'w-1', '/ws/b', JSON.stringify(wsBBinding), JSON.stringify(['INLINE_GOAL.md']), 'tsk_' + '8'.repeat(26), 'implementing', 'running', nowMs, 'flexible', JSON.stringify({ autoCommit: true, autoPush: false }))
    await fake.message('m_stop_a', '/auto stop', 'ou_owner', { chat_id: 'oc_scope_a', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_stop_a' && m.body.type === 'text' && m.body.text.includes('当前项目下暂无运行中的自动交付项目')))
    expect(hub.ctx.store.repos.prepare('SELECT control FROM personal_projects WHERE id=?').pluck().get('aut_ws_b')).toBe('running')

    // P1 #14: Method suggestion delivery failure after createTask does NOT release suggestion or create duplicate task
    const { cookie, csrfToken } = await login(rest(hub))
    const mRes = await rest(hub)('POST', '/api/v1/methods', {
      cookie, csrf: csrfToken, origin: ORIGIN,
      payload: {
        name: '唯一方法',
        kind: 'sop',
        scenario: '修复登录验证逻辑，排查原因并补充单测',
        avoid: '',
        keywords: ['修复', '登录'],
        steps: '按步骤排查并补充单测',
        done: '修复完成且测试通过',
      },
    })
    expect(mRes.status).toBe(201)
    await fake.message('m_sug_trig', '帮我修复登录验证逻辑并加测试', 'ou_owner', { chat_id: 'oc_sug', chat_type: 'p2p', mentions: [] })
    const sugCard = await eventually(() => [...fake.messages.entries()].find(([, m]) =>
      m.target === 'm_sug_trig' && m.body.type === 'interactive' && JSON.stringify(m.body.card).includes('method_use')))
    const sugId = JSON.stringify(sugCard![1].body).match(/mss_[0-9A-HJKMNP-TV-Z]{26}/u)![0]!
    const tasksBefore = hub.ctx.orchestrator.listTasks({}).items.length
    const origReply = fake.replyMessage.bind(fake)
    fake.replyMessage = async () => { throw Object.assign(new Error('bad request'), { response: { status: 400 } }) }
    const click1 = await fake.click(sugCard![0], 'ou_owner', { v: 1, a: 'method_use', s: sugId })
    fake.replyMessage = origReply
    expect(click1.toast.type).toBe('success')
    const click2 = await fake.click(sugCard![0], 'ou_owner', { v: 1, a: 'method_use', s: sugId })
    expect(click2.toast.content).toBe('已处理')
    expect(hub.ctx.orchestrator.listTasks({}).items.length).toBe(tasksBefore + 1)

    // P1 #7: autoCommit: false WITH verify checks must enter core_ready & fail acceptance report until verify_final runs
    const { finishGate } = await import('../src/plugins/orchestrator/personal-gates.js')
    const { finishDelivery, deliveryAction } = await import('../src/plugins/orchestrator/personal-delivery.js')
    const { projectReports } = await import('../src/plugins/orchestrator/personal-status.js')
    const noCommitBind = { ...bindingFixture, workerId: 'w-1', workspaceId: 'ws_a', subdir: undefined, root: '/ws/a', autoCommit: false, autoPush: false }
    const planSha = 'b'.repeat(64)
    const treeSha = 'c'.repeat(40)
    const headSha = 'd'.repeat(40)
    const planObj = {
      items: [{ id: 'T01', title: 'Check final verify', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['unit'] }],
      head: headSha, sourceDigest: planSha, tasksDigest: planSha, checksDigest: planSha, checksDigestVersion: 2,
    }
    const cand = { head: headSha, indexTree: treeSha, tree: treeSha }
    const pidNc = 'aut_nc_checks'
    const reviewTaskId = 'tsk_' + '7'.repeat(26)
    const reviewRunId = 'run_' + '7'.repeat(26)
    const implTaskId = 'tsk_' + '6'.repeat(26)
    const implRunId = 'run_' + '6'.repeat(26)
    hub.ctx.store.tx(db => {
      for (const [tid, rid, seq] of [[implTaskId, implRunId, 101], [reviewTaskId, reviewRunId, 102]] as const) {
        db.tasks.insert({
          id: tid, taskNo: seq, version: 0, status: 'succeeded', source: 'dashboard', originJson: { source: 'dashboard' },
          requesterType: 'owner', requesterId: 'ou_owner', title: 'step', prompt: 'step', workspaceId: 'ws_a', profile: 'edit',
          priority: 0, timeoutMs: 600_000, maxAttempts: 1, policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, createdAt: nowMs, updatedAt: nowMs,
        })
        db.prepare('INSERT INTO task_runs(id,task_id,run_seq,attempt,adapter,worker_id,workspace_id,profile,status,not_after,dispatched_at,finished_at,verification_status,verification_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(rid, tid, 1, 1, 'mock', 'w-1', 'ws_a', 'edit', 'succeeded', nowMs + 600_000, nowMs, nowMs + 10, 'passed', JSON.stringify({
            requested: { autoFixMaxRetries: 0 },
            attempts: [{ attempt: 1, commands: ['unit'], startedAt: nowMs, finishedAt: nowMs + 5, status: 'passed', results: [{ id: 'unit', status: 'passed', exitCode: 0, durationMs: 5, tail: 'ok' }] }],
          }))
      }
      db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,plan_json,phase,control,current_item,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(pidNc, 'w-1', '/ws/a', JSON.stringify(noCommitBind), JSON.stringify(['INLINE_GOAL.md']), 'tsk_' + '5'.repeat(26), JSON.stringify(planObj), 'reviewing', 'running', 'T01', nowMs, 'flexible', JSON.stringify({ autoCommit: false, autoPush: false }))
      db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json,status,tested_json) VALUES(?,?,?,?,?,?)')
        .run(pidNc, 'T01', 0, JSON.stringify(planObj.items[0]), 'implementing', JSON.stringify(cand))
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at,result_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(implTaskId, pidNc, 'T01', 'implement', 1, implRunId, nowMs, JSON.stringify({ status: 'succeeded', candidate: cand }))
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(reviewTaskId, pidNc, 'T01', 'review', 1, reviewRunId, nowMs)
      const revReceipt = JSON.stringify({
        taskId: reviewTaskId, runId: reviewRunId, itemId: 'T01', kind: 'review', ordinal: 1,
        head: headSha, tree: treeSha, inputDigest: planSha, judgment: { decision: 'PASS', findings: [] },
      })
      const digest = createHash('sha256').update(revReceipt).digest('hex')
      finishGate(db, db.runs.get(reviewRunId)!, {
        kind: 'finished', seq: 2, ts: nowMs + 10, status: 'succeeded', exitCode: 0, signal: null,
        durationMs: 10, summary: revReceipt, personalResultDigest: digest,
      }, nowMs + 10)
    })
    expect(hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(pidNc)).toBe('core_ready')

    // Report must NOT be complete before verify_final passes; after verify_final + FINAL_READY it becomes complete
    expect(projectReports(hub.ctx.store.repos, pidNc, nowMs + 20)['ACCEPTANCE.md']).toContain('结论：未完成。')
    const delAction = hub.ctx.store.tx(db => deliveryAction(db, pidNc, 'verify_final'))
    expect(delAction.kind).toBe('verify_final')
    expect(delAction.commit).toBeUndefined()
    const vfTaskId = 'tsk_' + '4'.repeat(26)
    const vfRunId = 'run_' + '4'.repeat(26)
    hub.ctx.store.tx(db => {
      db.tasks.insert({
        id: vfTaskId, taskNo: 103, version: 0, status: 'succeeded', source: 'dashboard', originJson: { source: 'dashboard' },
        requesterType: 'owner', requesterId: 'ou_owner', title: 'vf', prompt: 'vf', workspaceId: 'ws_a', profile: 'edit',
        priority: 0, timeoutMs: 600_000, maxAttempts: 1, policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, createdAt: nowMs, updatedAt: nowMs,
      })
      db.prepare('INSERT INTO task_runs(id,task_id,run_seq,attempt,adapter,worker_id,workspace_id,profile,status,not_after,dispatched_at,finished_at,verification_status,verification_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(vfRunId, vfTaskId, 1, 1, 'mock', 'w-1', 'ws_a', 'edit', 'succeeded', nowMs + 600_000, nowMs, nowMs + 10, 'passed', JSON.stringify({
          requested: { autoFixMaxRetries: 0 },
          attempts: [{ attempt: 1, commands: ['unit'], startedAt: nowMs, finishedAt: nowMs + 5, status: 'passed', results: [{ id: 'unit', status: 'passed', exitCode: 0, durationMs: 5, tail: 'ok' }] }],
        }))
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(vfTaskId, pidNc, 'T01', 'verify_final', 1, vfRunId, nowMs)
      db.prepare("UPDATE personal_projects SET phase='verifying_final' WHERE id=?").run(pidNc)
      const vfReceipt = JSON.stringify({ kind: 'verify_final', taskId: vfTaskId, runId: vfRunId, itemId: 'T01', parent: headSha, tree: treeSha })
      const vfDigest = createHash('sha256').update(vfReceipt).digest('hex')
      finishDelivery(db, db.runs.get(vfRunId)!, {
        kind: 'finished', seq: 2, ts: nowMs + 15, status: 'succeeded', exitCode: 0, signal: null, durationMs: 10,
        summary: vfReceipt, personalResultDigest: vfDigest,
        verification: { status: 'passed', attempts: 1, failed: [] },
      }, nowMs + 15)
    })
    expect(hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(pidNc)).toBe('final_ready')
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id=?").run(pidNc)

    // Round 3 P1 #8: failed manual /briefing & manual autopilot proposal replies dismiss their proposals instead of binding inbound message_id
    fake.replyMessage = async (_msgId, body) => {
      if ((body as { type?: string }).type === 'interactive') {
        throw Object.assign(new Error('card send failed'), { response: { status: 400 } })
      }
      return origReply(_msgId, body)
    }
    await expect(fake.message('m_brf_fail', '/briefing ws_a', 'ou_owner', { chat_id: 'oc_prop_fail', chat_type: 'p2p', mentions: [] })).rejects.toThrow()
    await expect(fake.message('m_aut_fail', '帮我在 shared_ws 里的 SubApp 写个独立测试并交付，完成后提交代码', 'ou_owner', { chat_id: 'oc_prop_fail2', chat_type: 'p2p', mentions: [] })).rejects.toThrow()
    fake.replyMessage = origReply
    const leftPending = hub.ctx.store.repos.prepare("SELECT count(*) FROM feishu_proposals WHERE chat_id IN ('oc_prop_fail', 'oc_prop_fail2') AND status = 'pending'").pluck().get()
    expect(leftPending).toBe(0)
    await fake.message('m_confirm_dismissed', '1', 'ou_owner', { chat_id: 'oc_prop_fail', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_confirm_dismissed'))
    expect(hub.ctx.store.repos.prepare("SELECT count(*) FROM personal_projects WHERE id LIKE 'aut_prp_%'").pluck().get()).toBe(0)

    // Round 7 & Round 8 P1 #8: Qualified match beats duplicate bare subdir; missing qualified target NEVER falls back to bare subdir; root workspace never inherits locked subdir
    const wDup = await FakeWorker.connect(hub, {
      workerId: 'w-dup',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [
        { id: 'alpha', label: 'Alpha', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false, projects: [{ dir: 'web', isGitRepo: true }] },
        { id: 'beta', label: 'Beta', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false, projects: [{ dir: 'web', isGitRepo: true }] },
      ],
    })
    cleanups.push(async () => wDup.terminate())
    await fake.message('m_proj_beta', '/project beta/web', 'ou_owner', { chat_id: 'oc_dup', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_proj_beta' && m.body.type === 'text' && m.body.text.includes('beta/web')))
    await fake.message('m_proj_missing', '/project missing/web', 'ou_owner', { chat_id: 'oc_dup_miss', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_proj_missing' && m.body.type === 'text' && m.body.text.includes('未找到项目：missing/web')))
    await fake.message('m_proj_ambig', '/project web', 'ou_owner', { chat_id: 'oc_dup2', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_proj_ambig' && m.body.type === 'text' && m.body.text.includes('存在歧义') && m.body.text.includes('alpha/web') && m.body.text.includes('beta/web')))
    await fake.message('m_free_ambig', '检查 web 页面排版', 'ou_owner', { chat_id: 'oc_dup3', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_free_ambig' && m.body.type === 'text' && m.body.text.includes('存在歧义')))
    await fake.message('m_free_miss', '检查 missing/web 页面排版', 'ou_owner', { chat_id: 'oc_dup_miss_free', chat_type: 'p2p', mentions: [] })
    const missTask = await eventually(() => hub.ctx.orchestrator.listTasks({}).items.find(t => t.title.includes('missing/web')))
    expect(missTask?.workspaceId).toBe('ws_a')
    expect(missTask?.subdir).toBeNull()
    await fake.message('m_root_noleak', '/run --ws ws_a 检查根仓状态', 'ou_owner', { chat_id: 'oc_dup', chat_type: 'p2p', mentions: [] })
    const rootNoLeak = await eventually(() => hub.ctx.orchestrator.listTasks({}).items.find(t => t.title.includes('检查根仓状态')))
    expect(rootNoLeak?.workspaceId).toBe('ws_a')
    expect(rootNoLeak?.subdir).toBeNull()

    // Round 8 P1 #3: Old worker without checks-digest.v2 never receives personal planning/step dispatch, and legacy v1 implementation_ready blocks proactively with resume_phase
    const wLegacyCap = await FakeWorker.connect(hub, {
      workerId: 'w-legacy-v1',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{ id: 'ws_legacy', label: 'Legacy WS', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: true }],
    })
    cleanups.push(async () => wLegacyCap.terminate())
    const legacyCapBind = { ...noCommitBind, workerId: 'w-legacy-v1', workspaceId: 'ws_legacy', root: '/ws/legcap' }
    const legCapPlan = {
      items: [{ id: 'T01', title: 'Leg cap', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['unit'] }],
      head: headSha, sourceDigest: planSha, tasksDigest: planSha, checksDigest: 'e'.repeat(64),
    }
    const legPlanTask = await hub.ctx.orchestrator.createTask({
      prompt: 'legacy worker planning gate', workspaceId: 'ws_legacy', requiredWorkerId: 'w-legacy-v1', profile: 'readonly',
    }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' }, {
      personalPlan: { projectId: 'aut_leg_worker', binding: legacyCapBind, sources: ['INLINE_GOAL.md'], inlinePrompt: 'goal' },
    })
    await eventually(() => hub.ctx.orchestrator.getTask(legPlanTask.id)?.scheduleHint === 'HARNESS_UNSUPPORTED')
    expect(wLegacyCap.frames.some(f => f.type === 'run.dispatch')).toBe(false)
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id='aut_leg_worker'").run()

    // Proactively blocked v1 project at implementation_ready on v2 worker saves resume_phase and never dispatches old digest
    const wRebase = await FakeWorker.connect(hub, {
      workerId: 'w-rebase',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      adapters: (['mock', 'codex', 'claude-code', 'antigravity'] as const).map(id => ({
        id, status: 'ready' as const, version: '0.1.0', features: { resume: true, liveInput: true, structuredOutput: true },
      })),
      workspaces: [{ id: 'ws_rebase', label: 'Rebase WS', allowedAdapters: ['mock', 'codex', 'claude-code', 'antigravity'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: true }],
    })
    cleanups.push(async () => wRebase.terminate())
    const rebaseBind = { ...noCommitBind, workerId: 'w-rebase', workspaceId: 'ws_rebase', subdir: undefined }
    hub.ctx.store.tx(db => {
      db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,plan_json,phase,control,current_item,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('aut_leg_proactive', 'w-rebase', '/ws/a-proactive', JSON.stringify({ ...rebaseBind, root: '/ws/a-proactive' }), JSON.stringify(['INLINE_GOAL.md']),
          'tsk_' + 'C'.repeat(26), JSON.stringify(legCapPlan), 'implementation_ready', 'running', 'T01', nowMs, 'flexible', JSON.stringify({ autoCommit: false, autoPush: false }))
      db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json,status) VALUES(?,?,?,?,?)')
        .run('aut_leg_proactive', 'T01', 0, JSON.stringify(legCapPlan.items[0]), 'pending')
    })
    await hub.ctx.orchestrator.setWorkerDrain('w-rebase', false, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    await eventually(() => hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get('aut_leg_proactive') === 'blocked')
    expect(hub.ctx.store.repos.prepare('SELECT reason,resume_phase FROM personal_projects WHERE id=?').get('aut_leg_proactive')).toEqual({
      reason: 'CHECKS_REBASELINE_REQUIRED', resume_phase: 'implementation_ready',
    })
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id='aut_leg_proactive'").run()

    // Round 8 P1 #1 & #2: REAL worker CHECKS_REBASELINE_REQUIRED failure preserves exact block reason on implement/push/review AND rebaseline resumes cleanly through the next dispatch without UNIQUE conflict or push->delivery_ready regression
    const realImplProj = 'aut_real_impl'
    const realImplTaskId = 'tsk_' + 'D'.repeat(26)
    const realImplRunId = 'run_' + 'D'.repeat(26)
    const realImplBind = { ...rebaseBind, root: '/ws/a-real-impl' }
    const realLegacyPlan = {
      items: [{ id: 'T01', title: 'Real impl rebaseline', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['unit'] }],
      head: headSha, sourceDigest: planSha, tasksDigest: planSha, checksDigest: 'e'.repeat(64),
    }
    hub.ctx.store.tx(db => {
      db.tasks.insert({
        id: realImplTaskId, taskNo: 1001, version: 0, status: 'running', source: 'dashboard', originJson: { source: 'dashboard' },
        requesterType: 'owner', requesterId: 'ou_owner', title: 'impl step', prompt: 'impl step', workspaceId: 'ws_rebase', profile: 'edit',
        priority: 0, workerId: 'w-rebase', adapter: 'mock', currentRunId: realImplRunId, runSeq: 1, attemptCount: 1, timeoutMs: 600_000, maxAttempts: 1,
        policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, createdAt: nowMs, updatedAt: nowMs, startedAt: nowMs,
      })
      db.prepare('INSERT INTO task_runs(id,task_id,run_seq,attempt,adapter,worker_id,workspace_id,profile,status,not_after,dispatched_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realImplRunId, realImplTaskId, 1, 1, 'mock', 'w-rebase', 'ws_rebase', 'edit', 'running', nowMs + 600_000, nowMs, nowMs)
      db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,plan_json,phase,control,current_item,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realImplProj, 'w-rebase', '/ws/a-real-impl', JSON.stringify(realImplBind), JSON.stringify(['INLINE_GOAL.md']),
          'tsk_' + 'E'.repeat(26), JSON.stringify(realLegacyPlan), 'implementing', 'running', 'T01', nowMs, 'flexible', JSON.stringify({ autoCommit: false, autoPush: false }))
      db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json,status) VALUES(?,?,?,?,?)')
        .run(realImplProj, 'T01', 0, JSON.stringify(realLegacyPlan.items[0]), 'implementing')
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(realImplTaskId, realImplProj, 'T01', 'implement', 1, realImplRunId, nowMs)
    })
    wRebase.events(realImplRunId, realImplTaskId, [
      { seq: 1, ts: nowMs + 1, kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null, durationMs: 10, summary: 'CHECKS_REBASELINE_REQUIRED' },
    ])
    await eventually(() => hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(realImplProj) === 'blocked')
    expect(hub.ctx.store.repos.prepare('SELECT reason FROM personal_projects WHERE id=?').pluck().get(realImplProj)).toBe('CHECKS_REBASELINE_REQUIRED')
    const waitRebaselineImpl = wRebase.waitFor('project.rebaseline', 5000, f => (f.payload as { projectId?: string })?.projectId === realImplProj).then(frame =>
      wRebase.ackCommand(frame, { result: { rebaseline: { checksDigest: 'f'.repeat(64), checksDigestVersion: 2 } } }))
    const rebImplRes = await rest(hub)('POST', `/api/v1/personal/projects/${realImplProj}/rebaseline`, { cookie, csrf: csrfToken, origin: ORIGIN, payload: {} })
    await waitRebaselineImpl
    expect(rebImplRes.status).toBe(200)
    expect(rebImplRes.json()).toEqual({ projectId: realImplProj, checksDigest: 'f'.repeat(64), checksDigestVersion: 2 })
    const nextImplDisp = await wRebase.waitFor('run.dispatch', 5000, f => (f.payload as { personal?: { projectId?: string } }).personal?.projectId === realImplProj)
    const nextImplPayload = RunDispatch.parse(nextImplDisp.payload)
    expect(nextImplPayload.personal?.execution?.checksDigestVersion).toBe(2)
    await wRebase.ackCommand(nextImplDisp)
    wRebase.events(nextImplPayload.runId, nextImplPayload.taskId, [
      { seq: 1, ts: nowMs + 2, kind: 'started', pid: 81, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: nowMs + 3, kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: 1, signal: null, durationMs: 5, summary: 'test cleanup' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(nextImplPayload.taskId)?.status === 'failed')
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id=?").run(realImplProj)

    // Real push -> CHECKS_REBASELINE_REQUIRED restores to push_ready (NOT delivery_ready!) and cleanly dispatches next push
    const realPushProj = 'aut_real_push'
    const realPushTaskId = 'tsk_' + 'F'.repeat(26)
    const realPushRunId = 'run_' + 'F'.repeat(26)
    const realPushBind = { ...bindingFixture, workerId: 'w-rebase', workspaceId: 'ws_rebase', subdir: undefined, root: '/ws/a-real-push', autoCommit: true, autoPush: true }
    hub.ctx.store.tx(db => {
      db.tasks.insert({
        id: realPushTaskId, taskNo: 1002, version: 0, status: 'running', source: 'dashboard', originJson: { source: 'dashboard' },
        requesterType: 'owner', requesterId: 'ou_owner', title: 'push step', prompt: 'push step', workspaceId: 'ws_rebase', profile: 'edit',
        priority: 0, workerId: 'w-rebase', adapter: 'mock', currentRunId: realPushRunId, runSeq: 1, attemptCount: 1, timeoutMs: 600_000, maxAttempts: 1,
        policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, createdAt: nowMs, updatedAt: nowMs, startedAt: nowMs,
      })
      db.prepare('INSERT INTO task_runs(id,task_id,run_seq,attempt,adapter,worker_id,workspace_id,profile,status,not_after,dispatched_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realPushRunId, realPushTaskId, 1, 1, 'mock', 'w-rebase', 'ws_rebase', 'edit', 'running', nowMs + 600_000, nowMs, nowMs)
      db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,plan_json,phase,control,current_item,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realPushProj, 'w-rebase', '/ws/a-real-push', JSON.stringify(realPushBind), JSON.stringify(['INLINE_GOAL.md']),
          'tsk_' + 'G'.repeat(26), JSON.stringify(realLegacyPlan), 'pushing', 'running', 'T01', nowMs, 'flexible', JSON.stringify({ autoCommit: true, autoPush: true }))
      db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json,status,tested_json,commit_sha) VALUES(?,?,?,?,?,?,?)')
        .run(realPushProj, 'T01', 0, JSON.stringify(realLegacyPlan.items[0]), 'reviewed', JSON.stringify(cand), headSha)
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(realPushTaskId, realPushProj, 'T01', 'push', 1, realPushRunId, nowMs)
    })
    wRebase.events(realPushRunId, realPushTaskId, [
      { seq: 1, ts: nowMs + 1, kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null, durationMs: 10, summary: 'CHECKS_REBASELINE_REQUIRED' },
    ])
    await eventually(() => hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(realPushProj) === 'blocked')
    expect(hub.ctx.store.repos.prepare('SELECT reason FROM personal_projects WHERE id=?').pluck().get(realPushProj)).toBe('CHECKS_REBASELINE_REQUIRED')
    const waitRebaselinePush = wRebase.waitFor('project.rebaseline', 5000, f => (f.payload as { projectId?: string })?.projectId === realPushProj).then(frame =>
      wRebase.ackCommand(frame, { result: { rebaseline: { checksDigest: 'f'.repeat(64), checksDigestVersion: 2 } } }))
    const rebPushRes = await rest(hub)('POST', `/api/v1/personal/projects/${realPushProj}/rebaseline`, { cookie, csrf: csrfToken, origin: ORIGIN, payload: {} })
    await waitRebaselinePush
    expect(rebPushRes.status).toBe(200)
    const nextPushDisp = await wRebase.waitFor('run.dispatch', 5000, f => (f.payload as { personal?: { projectId?: string } }).personal?.projectId === realPushProj)
    const nextPushPayload = RunDispatch.parse(nextPushDisp.payload)
    expect(nextPushPayload.personal?.delivery?.kind).toBe('push')
    await wRebase.ackCommand(nextPushDisp)
    wRebase.events(nextPushPayload.runId, nextPushPayload.taskId, [
      { seq: 1, ts: nowMs + 2, kind: 'started', pid: 82, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: nowMs + 3, kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: 1, signal: null, durationMs: 5, summary: 'test cleanup' },
    ])
    await eventually(() => hub.ctx.orchestrator.getTask(nextPushPayload.taskId)?.status === 'failed')
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id=?").run(realPushProj)

    // Real review gate -> CHECKS_REBASELINE_REQUIRED preserves exact block reason too
    const realRevProj = 'aut_real_rev'
    const realRevTaskId = 'tsk_' + 'H'.repeat(26)
    const realRevRunId = 'run_' + 'H'.repeat(26)
    hub.ctx.store.tx(db => {
      db.tasks.insert({
        id: realRevTaskId, taskNo: 1003, version: 0, status: 'running', source: 'dashboard', originJson: { source: 'dashboard' },
        requesterType: 'owner', requesterId: 'ou_owner', title: 'rev step', prompt: 'rev step', workspaceId: 'ws_rebase', profile: 'readonly',
        priority: 0, workerId: 'w-rebase', adapter: 'mock', currentRunId: realRevRunId, runSeq: 1, attemptCount: 1, timeoutMs: 600_000, maxAttempts: 1,
        policyDecisionJson: { decision: 'auto_approve', matchedRules: [] }, createdAt: nowMs, updatedAt: nowMs, startedAt: nowMs,
      })
      db.prepare('INSERT INTO task_runs(id,task_id,run_seq,attempt,adapter,worker_id,workspace_id,profile,status,not_after,dispatched_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realRevRunId, realRevTaskId, 1, 1, 'mock', 'w-rebase', 'ws_rebase', 'readonly', 'running', nowMs + 600_000, nowMs, nowMs)
      db.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,plan_json,phase,control,current_item,updated_at,mode,options_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(realRevProj, 'w-rebase', '/ws/a-real-rev', JSON.stringify({ ...rebaseBind, root: '/ws/a-real-rev' }), JSON.stringify(['INLINE_GOAL.md']),
          'tsk_' + 'J'.repeat(26), JSON.stringify(realLegacyPlan), 'reviewing', 'running', 'T01', nowMs, 'flexible', JSON.stringify({ autoCommit: false, autoPush: false }))
      db.prepare('INSERT INTO personal_items(project_id,item_id,ordinal,definition_json,status,tested_json) VALUES(?,?,?,?,?,?)')
        .run(realRevProj, 'T01', 0, JSON.stringify(realLegacyPlan.items[0]), 'awaiting_review', JSON.stringify(cand))
      db.prepare('INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(realRevTaskId, realRevProj, 'T01', 'review', 1, realRevRunId, nowMs)
    })
    wRebase.events(realRevRunId, realRevTaskId, [
      { seq: 1, ts: nowMs + 1, kind: 'finished', status: 'failed', errorCode: 'ADAPTER_ERROR', exitCode: null, signal: null, durationMs: 10, summary: 'CHECKS_REBASELINE_REQUIRED' },
    ])
    await eventually(() => hub.ctx.store.repos.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(realRevProj) === 'blocked')
    expect(hub.ctx.store.repos.prepare('SELECT reason FROM personal_projects WHERE id=?').pluck().get(realRevProj)).toBe('CHECKS_REBASELINE_REQUIRED')
    hub.ctx.store.repos.prepare("UPDATE personal_projects SET phase='stopped',control='closed' WHERE id=?").run(realRevProj)

    // Round 8 P2 #12: Feishu /handoff and /run --from preserve newly attached inbound media on the child task
    const fakeMm = new FakeFeishuTransport()
    const { hub: hubMm, cleanup: cleanupMm } = await openHarness({
      ...settings,
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'ws_a',
        multimodal: { enabled: true },
      },
    }, { feishuTransport: fakeMm })
    cleanups.push(cleanupMm)
    const wMm = await FakeWorker.connect(hubMm, {
      workerId: 'w-mm-ho',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [{ id: 'ws_a', label: 'WS A', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false }],
    })
    cleanups.push(async () => wMm.terminate())
    const parentTask = await hubMm.ctx.orchestrator.createTask({ prompt: '原始任务', workspaceId: 'ws_a', adapter: 'mock' }, { type: 'owner', id: 'ou_owner', channel: 'dashboard' })
    const pDisp = RunDispatch.parse((await wMm.waitFor('run.dispatch')).payload)
    wMm.events(pDisp.runId, pDisp.taskId, [
      { seq: 1, ts: Date.now(), kind: 'started', pid: 50, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' },
      { seq: 2, ts: Date.now() + 1, kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: 'done' },
    ])
    await eventually(() => hubMm.ctx.orchestrator.getTask(parentTask.id)?.status === 'succeeded')
    fakeMm.resources.set('handoff_img', { data: Buffer.from('handoff-png-bytes'), mimeType: 'image/png' })
    await fakeMm.message('m_ho_img', '', 'ou_owner', {
      chat_id: 'oc_ho', chat_type: 'p2p', mentions: [], message_type: 'post',
      content: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: `/handoff --cli mock --from #${parentTask.taskNo} 查看截图继续处理` }, { tag: 'img', image_key: 'handoff_img' }]] } }),
    })
    const hoDisp = RunDispatch.parse((await wMm.waitFor('run.dispatch', 5000, f => (f.payload as { taskId: string }).taskId !== parentTask.id)).payload)
    expect(hoDisp.attachments).toHaveLength(1)
    expect(hoDisp.attachments![0]).toMatchObject({ kind: 'image', mimeType: 'image/png' })
  }, 45_000)

  it('scopes Feishu /auto stop, --dir, /briefing root, and rejects /auto --doc with inline prompt (Round 9 P1-3 / P2-1 / P2-2)', async () => {
    const fake = new FakeFeishuTransport()
    const { hub, cleanup } = await openHarness({
      ...settings,
      permissions: { autoApproveAll: true },
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        chatDefaults: { oc_ctrl_scope: { workspaceId: 'alpha', subdir: 'web' } },
        smartRouting: { enabled: true, rememberProject: true, autoSelectAdapter: true, proposeAutopilot: true },
      },
    }, { feishuTransport: fake })
    cleanups.push(cleanup)

    const wScope = await FakeWorker.connect(hub, {
      workerId: 'w-scope',
      headers: { 'X-Agent-Hub-Capabilities': 'attachments.v1,blackboard.v1,checks-digest.v2,preflight.v1,verify.v1,visual.v1' },
      workspaces: [
        { id: 'alpha', label: 'Alpha', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: true, projects: [{ dir: 'web', isGitRepo: true }] },
        { id: 'beta', label: 'Beta', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: true, projects: [{ dir: 'web', isGitRepo: true }] },
      ],
    })
    cleanups.push(async () => wScope.terminate())

    const nowMs = hub.ctx.clock.now()
    const betaWebBind = { ...bindingFixture, workerId: 'w-scope', workspaceId: 'beta', subdir: 'web', root: '/ws/beta/web' }
    hub.ctx.store.repos.prepare('INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,phase,control,updated_at,mode,options_json,subdir) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('aut_beta_web', 'w-scope', '/ws/beta/web', JSON.stringify(betaWebBind), JSON.stringify(['INLINE_GOAL.md']), 'tsk_' + 'K'.repeat(26), 'implementing', 'running', nowMs, 'flexible', JSON.stringify({ autoCommit: true, autoPush: false }), 'web')

    // 1. After /project beta, /auto stop must NOT mix chatDefaults.subdir ('web') or treat root lock as wildcard to stop beta/web
    await fake.message('m_scope_proj', '/project beta', 'ou_owner', { chat_id: 'oc_ctrl_scope', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_scope_proj' && m.body.type === 'text' && m.body.text.includes('beta')))

    await fake.message('m_scope_stop', '/auto stop', 'ou_owner', { chat_id: 'oc_ctrl_scope', chat_type: 'p2p', mentions: [] })
    const stopMsg = await eventually(() => [...fake.messages.values()].find(m => m.target === 'm_scope_stop' && m.body.type === 'text'))
    expect(stopMsg?.body.type === 'text' ? stopMsg.body.text : '').toContain('当前项目下暂无运行中的自动交付项目')
    expect(hub.ctx.store.repos.prepare('SELECT control FROM personal_projects WHERE id=?').pluck().get('aut_beta_web')).toBe('running')

    // 2. /auto --dir web after /project beta uses remembered workspace 'beta' (not chatDefaults 'alpha')
    const preWait = wScope.waitFor('project.preflight', 5000).then(async frame => {
      await wScope.ackCommand(frame, { result: { preflight: { ok: false, error: 'PROBE_DONE' } } })
      return frame.payload as { workspaceId?: string; subdir?: string }
    })
    await fake.message('m_scope_dir', '/auto --dir web 实现功能', 'ou_owner', { chat_id: 'oc_ctrl_scope', chat_type: 'p2p', mentions: [] })
    expect(await preWait).toMatchObject({ workspaceId: 'beta', subdir: 'web' })

    // 3. /briefing beta targets explicit root beta (subdir: '') instead of beta/web
    await fake.message('m_scope_brf', '/briefing beta', 'ou_owner', { chat_id: 'oc_ctrl_scope', chat_type: 'p2p', mentions: [] })
    await eventually(() => [...fake.messages.values()].some(m => m.target === 'm_scope_brf' && m.body.type === 'interactive'))
    const betaBriefings = hub.ctx.orchestrator.listBriefings({ workerId: 'w-scope', workspaceId: 'beta' })
    expect(betaBriefings.some(b => b.subdir === '')).toBe(true)
    expect(betaBriefings.some(b => b.subdir === 'web')).toBe(false)

    // 4. /auto --doc combined with inline prompt is rejected instead of silently dropping prompt
    await fake.message('m_scope_doc_both', '/auto --doc PRD.md 额外文字', 'ou_owner', { chat_id: 'oc_ctrl_scope', chat_type: 'p2p', mentions: [] })
    const bothMsg = await eventually(() => [...fake.messages.values()].find(m => m.target === 'm_scope_doc_both' && m.body.type === 'text'))
    expect(bothMsg?.body.type === 'text' ? bothMsg.body.text : '').toContain('参数 --doc 与文字目标不可同时使用')
  }, 20_000)
})
