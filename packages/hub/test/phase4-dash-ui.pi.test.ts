/**
 * Pi 独立验收 · Phase 4 面板 UI 门禁（DASH-1 ~ DASH-8）
 *
 * 真实 Playwright Chromium（系统 Chrome，`channel: 'chrome'`）驱动
 * 真实 Hub 进程内实例（监听真实端口）+ 真实 Worker 进程（mock adapter）+ mock-cli 剧本。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import * as api from '@agent-hub/protocol'
import type { TaskDetail } from '@agent-hub/protocol'
import { ChaosProxy, enrollWorker, eventually, delay, openHarness, seedRun } from './pi/harness.js'
import { expectSchema, onlineWorker, rest, useAdminToken } from './pi/rest.js'
import { capabilities, dispatch, finish, mockPrompt, owner, snapshot } from './pi/phase7.js'
import type { TestHub } from '../src/app.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

useAdminToken()

const ADMIN = 'pi-phase4-admin-token-' + 'k'.repeat(32)
const distDir = fileURLToPath(new URL('../../dashboard/dist/site/', import.meta.url))
let browser: Browser | undefined

beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome' }) }, 120_000)
afterAll(async () => { await browser?.close() })

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

interface Booted {
  hub: TestHub
  origin: string
  cleanup: () => Promise<void>
  workspace: string
}

async function boot(options: { gracePeriodMs?: number } = {}): Promise<Booted> {
  const port = await freePort()
  const origin = 'http://127.0.0.1:' + port
  const { hub, cleanup } = await openHarness({
    server: { host: '127.0.0.1', port, allowInsecureWorker: true, shutdownTimeoutMs: 10_000 },
    dashboard: { allowedOrigins: [origin], distDir },
    ...(options.gracePeriodMs !== undefined && { workers: { gracePeriodMs: options.gracePeriodMs } }),
  })
  const workspace = mkdtempSync(join(tmpdir(), 'pi-dash-ws-'))
  return { hub, origin, workspace,
    cleanup: async () => { await cleanup(); rmSync(workspace, { recursive: true, force: true }) } }
}

function workerUrl(address: string) {
  const url = new URL('/ws/worker', address)
  url.protocol = 'ws:'
  return url.href
}

async function startMockWorker(hub: TestHub, workerId: string, workspace: string, stateDir: string,
  identity?: Awaited<ReturnType<typeof enrollWorker>>, hubUrl?: string) {
  mkdirSync(workspace, { recursive: true })
  const credentials = identity ?? await enrollWorker(hub, workerId)
  const worker = await startWorker(WorkerConfigSchema.parse({
    workerId, hub: { url: hubUrl ?? workerUrl(hub.address!) }, maxConcurrency: 2,
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full' }],
  }), { stateDir, random: () => 0, onWarning: () => undefined,
    identity: { privateKey: credentials.privateKey, publicKey: credentials.publicKey, fingerprint: credentials.fingerprint } })
  await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 20_000, label: workerId + ' online' })
  return { worker, identity: credentials }
}

async function page(origin: string): Promise<Page> {
  const context = await browser!.newContext({ baseURL: origin, viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => {
    const store = window as unknown as { __longTasks: number[] }
    store.__longTasks = []
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) store.__longTasks.push(entry.duration) })
        .observe({ entryTypes: ['longtask'] })
    } catch { /* 不支持 longtask 时保持空数组 */ }
  })
  const created = await context.newPage()
  created.on('pageerror', error => { void error })
  await created.goto(origin)
  return created
}

async function login(page: Page, token: string) {
  await page.getByTestId('login-token').fill(token)
  await page.getByTestId('login-submit').click()
  await pw(page.getByTestId('command-center')).toBeVisible({ timeout: 15_000 })
  await pw(page.getByTestId('dashboard-connection')).toHaveText('实时在线', { timeout: 15_000 })
}

async function apiToken(hub: TestHub, scopes: ('read' | 'operate' | 'admin')[] = ['admin']) {
  return hub.ctx.auth.createApiToken('pi-dash-' + scopes.join('-'), [...scopes])
}

async function waitDetail(hub: TestHub, token: string, id: string, predicate: (task: TaskDetail) => boolean, label: string) {
  return eventually(() => {
    const task = hub.ctx.orchestrator.getTask(id)
    return task && predicate(task) ? task : undefined
  }, { timeoutMs: 30_000, label })
}

it('DASH-1 登录 / 登出 / 会话失效跳转', async () => {
  const booted = await boot()
  try {
    const client = await page(booted.origin)
    try {
      await pw(client.getByTestId('login-page')).toBeVisible()
      // 失败登录展示错误且停留在登录页
      await client.getByTestId('login-token').fill('definitely-wrong')
      await client.getByTestId('login-submit').click()
      await pw(client.getByRole('alert')).toBeVisible({ timeout: 10_000 })
      await pw(client.getByTestId('login-page')).toBeVisible()
      // 成功登录
      await client.getByTestId('login-token').fill(ADMIN)
      await client.getByTestId('login-submit').click()
      await pw(client.getByTestId('command-center')).toBeVisible({ timeout: 15_000 })
      await pw(client.getByTestId('dashboard-connection')).toHaveText('实时在线', { timeout: 15_000 })
      await pw(client.getByTestId('overview-metrics')).toBeVisible()
      // 登出回到登录页
      await client.getByTestId('logout').click()
      await pw(client.getByTestId('login-page')).toBeVisible({ timeout: 15_000 })

      // 会话失效（服务端吊销）→ 跳转登录页
      await login(client, ADMIN)
      const cookies = await client.context().cookies()
      const session = cookies.find(cookie => cookie.name === 'ah_sid')!
      expect(session).toBeTruthy()
      booted.hub.ctx.auth.logout(session.value)
      await pw(client.getByTestId('login-page')).toBeVisible({ timeout: 20_000 })
      // 失效后刷新也不会恢复会话
      await client.reload()
      await pw(client.getByTestId('login-page')).toBeVisible({ timeout: 15_000 })
    } finally { await client.context().close() }
  } finally { await booted.cleanup() }
}, 180_000)

it('shows the latest nonempty project board and dispatches and filters tasks from that workspace', async () => {
  const booted = await boot()
  const { hub } = booted
  const client = await page(booted.origin)
  try {
    const worker = await onlineWorker(hub, 'project-node', { headers: capabilities, workspaces:
      ['forma', 'daily'].map(id => ({ id, label: id === 'forma' ? 'Soren_project' : id, allowedAdapters: ['mock'],
        maxProfile: 'full', maxConcurrent: 2, isGitRepo: true })) })
    const board = snapshot()
    const content = {
      'PROJECT_STATE.md': '# PROJECT STATE\n## Summary\nForma 空间化 AI 创作工作台\n## Modules\n| Module | Status |\n| --- | --- |\n| Canvas | wip |',
      'HANDOFF.md': '## Next\n1. 校验画布导出',
      'DECISIONS.md': '## Active\n### ADR-1 本地渲染',
      'LESSONS.md': '## Rules\n- 保留图层顺序',
    }
    for (const file of board.files) Object.assign(file, { status: 'present', bytes: Buffer.byteLength(content[file.file]),
      lines: content[file.file].split('\n').length, content: content[file.file], schemaOk: true, sha256: 'a'.repeat(64) })
    const makeTask = (workspaceId: string, prompt: string) => hub.ctx.orchestrator.createTask({ workspaceId, prompt, profile: 'edit', adapter: 'mock' }, owner)
    const first = await makeTask('forma', mockPrompt)
    const pre = snapshot('old')
    pre.capturedAt = board.capturedAt - 1
    await finish(hub, worker, await dispatch(worker, first.id), pre, board)
    const latest = await makeTask('forma', mockPrompt)
    const run = await dispatch(worker, latest.id)
    await finish(hub, worker, run, snapshot(), snapshot())
    const daily = await makeTask('daily', '日常任务')

    const read = await apiToken(hub, ['read'])
    const get = (path: string) => rest(hub)('GET', '/api/v1/' + path, { token: read })
    expect((await rest(hub)('GET', '/api/v1/projects')).status).toBe(401)
    const projects = expectSchema(api.ProjectOverview.array(), await get('projects'))
    expect(projects.map(p => p.workspaceId)).toEqual(['forma', 'daily'])
    expect(projects[0]).toMatchObject({ workerId: 'project-node', latestTaskId: latest.id, latestRunId: run.runId,
      pointer: { lastAttempt: { runId: run.runId } }, totalTasks: 2, succeededTasks: 2, boardCapturedAt: board.capturedAt })
    expect(projects[0]!.board?.files.map(f => f.content)).toEqual(board.files.map(f => f.content))
    expect(projects[1]!.board).toBeNull()
    expect(expectSchema(api.TaskListResponse, await get('tasks?workspaceId=forma')).items.map(t => t.id)).toEqual([latest.id, first.id])

    await login(client, ADMIN)
    const center = client.getByTestId('project-hub')
    const forma = center.getByRole('button', { name: /Soren_project.*Forma/u })
    await pw(forma).toHaveAttribute('aria-pressed', 'true')
    await pw(client.getByTestId('worker-fleet')).toHaveCount(0)
    await pw(center.getByRole('table', { name: '项目模块' }).getByRole('row', { name: 'Canvas wip' })).toBeVisible()
    await center.getByRole('button', { name: '交接与下一步' }).click()
    await pw(center.locator('ol li')).toHaveText('校验画布导出')
    await center.getByRole('button', { name: '架构决策' }).click()
    await pw(center.getByRole('heading', { name: 'ADR-1 本地渲染' })).toBeVisible()
    await center.getByRole('button', { name: '踩坑与规则' }).click()
    await pw(center.getByRole('listitem')).toHaveText('保留图层顺序')
    // 项目卡片不再放「换 CLI 接力」，接力只在任务详情的技术详情里
    await pw(center.getByTestId('project-handoff')).toHaveCount(0)

    // 没有子项目时默认看全部工作区；用上方的工作区选择切到 forma
    await pw(center.getByTestId('project-workspace')).toHaveValue('')
    await center.getByTestId('project-workspace').selectOption('forma')
    await pw(client.getByTestId('task-card-' + daily.taskNo)).toHaveCount(0)
    await pw(client.getByTestId('task-card-' + latest.taskNo)).toBeVisible()
    await client.getByTestId('show-history').click()
    const filter = client.getByTestId('task-filter-workspace')
    await pw(filter).toHaveValue('forma')
    await filter.selectOption('daily')
    await pw(center.getByTestId('project-board-tabs')).toHaveCount(0)
    await pw(client.getByTestId('task-row-' + daily.taskNo)).toBeVisible()
    await pw(center.getByTestId('project-workspace')).toHaveValue('daily')
    await center.getByTestId('project-workspace').selectOption('')
    await pw(filter).toHaveValue('')
    await client.getByTestId('back-to-today').click()
    await forma.click()
    await center.getByTestId('project-new-task').click()
    await pw(client.getByTestId('task-workspace')).toHaveValue('forma')
    await pw(client.getByTestId('task-profile')).toHaveValue('full')
    await client.getByTestId('task-prompt').fill('项目派单')
    await client.getByTestId('task-create-submit').click()
    await pw(client.getByTestId('new-task-dialog')).toBeHidden()
    expect(hub.ctx.store.repos.tasks.getByNo(daily.taskNo + 1)).toMatchObject({
      workspaceId: 'forma', profile: 'full', requiredWorkerId: 'project-node', prompt: '项目派单' })
  } finally { await client.context().close(); await booted.cleanup() }
}, 60_000)

it('lists the project folders inside a workspace, scopes the console to it and dispatches into a project folder', async () => {
  const booted = await boot()
  const { hub } = booted
  const client = await page(booted.origin)
  try {
    const worker = await onlineWorker(hub, 'folder-node', { headers: capabilities, workspaces: [
      { id: 'soren', label: 'Soren_project', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false,
        projects: [{ dir: 'Forma', isGitRepo: true }] },
      { id: 'daily', label: 'daily', allowedAdapters: ['mock'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false, projects: [] }] })
    // 新建文件夹后，Worker 在下一次心跳带上新的项目列表
    await worker.heartbeat({ projects: { soren: [{ dir: 'Forma', isGitRepo: true }, { dir: 'Notes', isGitRepo: false }], daily: [] } })
    const read = await apiToken(hub, ['read'])
    const listed = async () => expectSchema(api.ProjectOverview.array(), await rest(hub)('GET', '/api/v1/projects', { token: read }))
    await eventually(async () => (await listed()).some(p => p.subdir === 'Notes'), { timeoutMs: 5000, label: 'Notes listed' })
    const make = (workspaceId: string, prompt: string, subdir?: string) =>
      hub.ctx.orchestrator.createTask({ workspaceId, prompt, profile: 'edit', adapter: 'mock', ...(subdir && { subdir }) }, owner)
    // 黑板按项目分开：Forma 里跑出的黑板只挂在 Forma 卡片上，不算工作区根目录的
    const boarded = await make('soren', mockPrompt, 'Forma')
    const board = snapshot()
    for (const file of board.files) Object.assign(file, { status: 'present', bytes: 9, lines: 1, content: file.file === 'PROJECT_STATE.md'
      ? '# PROJECT STATE\n## Summary\nForma 黑板' : '# x', schemaOk: true, sha256: 'b'.repeat(64) })
    const before = snapshot('old')
    before.capturedAt = board.capturedAt - 1
    await finish(hub, worker, await dispatch(worker, boarded.id), before, board)
    const boards = Object.fromEntries((await listed()).filter(p => p.workspaceId === 'soren').map(p => [p.subdir ?? '', p.board?.files.length ?? 0]))
    expect(boards).toEqual({ '': 0, Forma: board.files.length, Notes: 0 })
    const forma = await make('soren', 'Forma 任务', 'Forma/src')
    const daily = await make('daily', '日常任务')
    expect((await listed()).filter(p => p.workspaceId === 'soren').map(p => [p.subdir ?? null, p.totalTasks]))
      .toEqual(expect.arrayContaining([[null, 2], ['Forma', 2], ['Notes', 0]]))

    await login(client, ADMIN)
    const center = client.getByTestId('project-hub')
    await pw(center.getByTestId('project-workspace')).toHaveValue('soren')
    await pw(center.locator('.project-card')).toHaveCount(2)
    await pw(center.getByRole('button', { name: /^Forma/u })).toContainText('Forma 黑板')
    await pw(client.getByTestId('task-card-' + forma.taskNo)).toBeVisible()
    await pw(client.getByTestId('task-card-' + daily.taskNo)).toHaveCount(0)
    await center.getByRole('button', { name: /^Forma/u }).click()
    await pw(center.getByTestId('project-board-tabs')).toBeVisible()
    await center.getByTestId('project-filter-tasks').click()
    await pw(client.getByTestId('task-card-' + forma.taskNo)).toBeVisible()
    await center.getByRole('button', { name: /^Notes/u }).click()
    await pw(client.getByTestId('task-card-' + forma.taskNo)).toHaveCount(0)
    await center.getByTestId('project-new-task').click()
    await pw(client.getByTestId('task-project')).toHaveValue('Notes')
    await client.getByTestId('task-prompt').fill('写笔记')
    await client.getByTestId('task-create-submit').click()
    await pw(client.getByTestId('new-task-dialog')).toBeHidden()
    expect(hub.ctx.store.repos.tasks.getByNo(daily.taskNo + 1)).toMatchObject({ workspaceId: 'soren', subdir: 'Notes', prompt: '写笔记' })
  } finally { await client.context().close(); await booted.cleanup() }
}, 60_000)

it('DASH-2 手动指定 Worker 派单：看板卡片 queued → running → succeeded 实时移动', async () => {
  const booted = await boot()
  let worker: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    worker = await startMockWorker(booted.hub, 'pi-dash-2', booted.workspace, join(booted.workspace, 'state'))
    await login(client, ADMIN)
    await client.getByTestId('system-tab').click()
    await pw(client.getByTestId('worker-card-pi-dash-2')).toBeVisible({ timeout: 20_000 })
    await client.getByTestId('operations-tab').click()
    await client.getByTestId('new-task').click()
    await pw(client.getByTestId('new-task-dialog')).toBeVisible()
    await client.getByTestId('task-worker').selectOption('pi-dash-2')
    await client.getByTestId('task-workspace').selectOption('sandbox')
    await client.getByTestId('task-adapter').selectOption('mock')
    await client.getByTestId('task-profile').selectOption('edit')
    await client.getByTestId('task-prompt').fill('#scenario: slow ms=4000')
    await client.getByTestId('task-create-submit').click()
    await pw(client.getByTestId('new-task-dialog')).toBeHidden({ timeout: 10_000 })

    const card = client.locator('[data-testid^="task-card-"]').first()
    await pw(card).toBeVisible({ timeout: 15_000 })
    const testId = await card.getAttribute('data-testid')
    const taskNo = Number(String(testId).replace('task-card-', ''))
    expect(Number.isInteger(taskNo)).toBe(true)

    // running 阶段：卡片出现在今日概览的“进行中”
    await pw(client.getByTestId('today-running').locator('[data-testid="task-card-' + taskNo + '"]'))
      .toBeVisible({ timeout: 25_000 })
    await pw(client.getByTestId('task-card-' + taskNo)).toHaveAttribute('data-status', 'running', { timeout: 20_000 })
    await pw(client.getByTestId('task-card-' + taskNo)).toContainText('mock') // 简化后的首页卡片只显示 CLI，不显示 Worker ID
    await pw(client.getByTestId('task-card-' + taskNo)).toHaveAttribute('data-status', 'succeeded', { timeout: 30_000 })
    const detail = booted.hub.ctx.orchestrator.getTask(String(taskNo))!
    expect(detail.status).toBe('succeeded')
    expect(detail.runs[0]!.workerId).toBe('pi-dash-2')
    expect((booted.hub.ctx.store.repos.prepare('SELECT required_worker_id AS w FROM tasks WHERE id = ?').get(detail.id) as { w: string }).w)
      .toBe('pi-dash-2')
  } finally { await client.context().close(); await worker?.worker.close(); await booted.cleanup() }
}, 240_000)

it('DASH-3 抽屉终端 结构化 / Raw 切换内容一致', async () => {
  const booted = await boot()
  let worker: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    worker = await startMockWorker(booted.hub, 'pi-dash-3', booted.workspace, join(booted.workspace, 'state'))
    const token = await apiToken(booted.hub)
    const call = rest(booted.hub)
    const created = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: '#scenario: success n=6', workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
    const done = await waitDetail(booted.hub, token, created.id, task => task.status === 'succeeded', 'succeeded')
    const runId = done.runs[0]!.id
    await login(client, ADMIN)
    await client.getByTestId('show-history').click()
    await client.getByTestId('task-search').fill('#scenario')
    await client.getByTestId('task-row-' + created.taskNo).click()
    await pw(client.getByTestId('mission-drawer')).toBeVisible({ timeout: 15_000 })
    await client.getByTestId('tech-details').locator('summary').click()
    await pw(client.getByTestId('terminal-structured')).toBeVisible({ timeout: 15_000 })
    await pw(client.getByTestId('log-count')).not.toHaveText('0 条记录', { timeout: 20_000 })
    const structuredRows = await client.getByTestId('terminal-structured').locator('.log-row').allInnerTexts()
    const structuredCodesEarly = await client.getByTestId('terminal-structured').locator('.log-row code').allInnerTexts()
    expect(structuredCodesEarly.length).toBeGreaterThan(0)
    expect(structuredRows.join('\n')).toContain('Mock response 6')
    const countText = await client.getByTestId('log-count').innerText()
    const total = Number(countText.replace(/[^0-9]/g, ''))
    // 与 REST 日志条数一致（同一数据源）
    const stored = booted.hub.ctx.store.repos.prepare('SELECT count(*) AS n FROM task_logs WHERE run_id = ?')
      .get(runId) as { n: number }
    expect(total).toBe(stored.n)

    // 切到 Raw：xterm 画布实际完成绘制
    await client.getByTestId('log-view-raw').click()
    await pw(client.getByTestId('terminal-raw')).toBeVisible({ timeout: 15_000 })
    await pw(client.getByTestId('log-view-raw')).toHaveAttribute('aria-pressed', 'true')
    await pw(client.getByTestId('log-count')).toHaveText(countText)
    // Raw 视图必须真正渲染出文本行
    await client.waitForFunction(() => (document.querySelector('[data-testid="terminal-raw"] .xterm-rows')?.textContent ?? '').trim().length > 0,
      undefined, { timeout: 30_000 })
    const rawText = await client.getByTestId('terminal-raw').locator('.xterm-rows').first().innerText()
    const squeeze = (value: string) => value.replace(/\s+/g, '')
    expect(structuredCodesEarly.length).toBeGreaterThan(0)
    // 双向包含：结构化视图的每条文本都出现在 Raw 中，Raw 的每一行也都来自同一数据源
    for (const code of structuredCodesEarly) expect(squeeze(rawText)).toContain(squeeze(code))
    const joinedStructured = squeeze(structuredCodesEarly.join('\n'))
    for (const line of rawText.split('\n').map(item => item.trim()).filter(Boolean)) {
      expect(joinedStructured).toContain(squeeze(line.replace(/^\[[a-z_-]+\]/, '')))
    }
    expect(rawText).toContain('Mock response 6')

    // 切回结构化：条目总数与内容不变
    await client.getByTestId('log-view-structured').click()
    await pw(client.getByTestId('terminal-structured')).toBeVisible()
    await pw(client.getByTestId('log-count')).toHaveText(countText)
    const rowsAgain = await client.getByTestId('terminal-structured').locator('.log-row').allInnerTexts()
    expect(rowsAgain).toEqual(structuredRows)
  } finally { await client.context().close(); await worker?.worker.close(); await booted.cleanup() }
}, 240_000)

it('DASH-4 审批覆写 adapter/prompt 并以覆写值执行，时间线留痕', async () => {
  const booted = await boot()
  let worker: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    worker = await startMockWorker(booted.hub, 'pi-dash-4', booted.workspace, join(booted.workspace, 'state'))
    booted.hub.ctx.policy.replaceRules([{ id: 'pi-dash-approval', name: 'approval', priority: 1, enabled: true,
      match: { promptPattern: '^#scenario' }, effect: { decision: 'require_approval' } }],
    { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' }, 0)
    const token = await apiToken(booted.hub)
    const created = expectSchema(api.TaskDetail, await rest(booted.hub)('POST', '/api/v1/tasks', { token,
      payload: { prompt: '#scenario: success n=2', workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
    expect(created.status).toBe('awaiting_approval')

    await login(client, ADMIN)
    await client.getByTestId('pending-approval').click()
    await client.getByTestId('task-card-' + created.taskNo).click()
    await pw(client.getByTestId('mission-drawer')).toBeVisible({ timeout: 15_000 })
    await client.getByTestId('action-approve').click()
    await pw(client.getByTestId('action-form-approve')).toBeVisible({ timeout: 10_000 })
    await client.getByTestId('task-prompt').fill('#scenario: success n=4')
    await client.getByTestId('task-adapter').selectOption('mock')
    await client.getByTestId('approve-submit').click()

    const executed = await waitDetail(booted.hub, token, created.id, task => task.status === 'succeeded', 'approved+succeeded')
    expect(executed.prompt).toBe('#scenario: success n=4')
    expect(executed.adapter).toBe('mock')
    expect(executed.resultSummary).toBe('Mock response 4')
    expect(executed.timeline.map(entry => entry.event)).toContain('task.approve')
    expect(executed.timeline.some(entry => entry.note?.includes('Prompt 覆写'))).toBe(true)

    // UI 时间线同样留痕（在技术详情里）
    await client.getByTestId('tech-details').locator('summary').click()
    await client.getByTestId('drawer-timeline').click()
    await pw(client.getByTestId('task-timeline')).toContainText('Prompt 覆写', { timeout: 15_000 })
    await pw(client.getByTestId('task-timeline')).toContainText('task.approve')
  } finally { await client.context().close(); await worker?.worker.close(); await booted.cleanup() }
}, 240_000)

it('DASH-5 取消运行中任务：cancelling → cancelled，按钮禁用状态正确', async () => {
  const booted = await boot()
  let worker: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    worker = await startMockWorker(booted.hub, 'pi-dash-5', booted.workspace, join(booted.workspace, 'state'))
    const token = await apiToken(booted.hub)
    const created = expectSchema(api.TaskDetail, await rest(booted.hub)('POST', '/api/v1/tasks', { token,
      payload: { prompt: '#scenario: slow ms=60000', workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
    await waitDetail(booted.hub, token, created.id, task => task.status === 'running', 'running')
    await login(client, ADMIN)
    await client.getByTestId('show-history').click()
    await client.getByTestId('task-search').fill('#scenario')
    await client.getByTestId('task-row-' + created.taskNo).click()
    await pw(client.getByTestId('mission-drawer')).toBeVisible({ timeout: 15_000 })
    await pw(client.getByTestId('action-cancel')).toBeEnabled({ timeout: 15_000 })
    await client.getByTestId('action-cancel').click()

    // cancelling 阶段：不再提供任何可执行操作
    await waitDetail(booted.hub, token, created.id,
      task => task.status === 'cancelling' || task.status === 'cancelled', 'cancelling', )
    await pw(client.getByTestId('task-actions')).toContainText('当前状态无可用操作', { timeout: 20_000 })
    await pw(client.getByTestId('action-cancel')).toHaveCount(0)

    const cancelled = await waitDetail(booted.hub, token, created.id, task => task.status === 'cancelled', 'cancelled')
    expect(cancelled.runs[0]!.status).toBe('cancelled')
    expect(cancelled.allowedActions).toEqual(expect.arrayContaining(['retry', 'followup']))
    expect(cancelled.allowedActions).not.toContain('cancel')
    await pw(client.getByTestId('task-actions')).toContainText('重试', { timeout: 20_000 })
    await pw(client.getByTestId('action-retry')).toBeEnabled()
    await pw(client.getByTestId('action-cancel')).toHaveCount(0)
  } finally { await client.context().close(); await worker?.worker.close(); await booted.cleanup() }
}, 240_000)

it('DASH-6 Worker 断线显示离线 + 宽限期倒计时，恢复后变绿', async () => {
  const booted = await boot({ gracePeriodMs: 30_000 })
  const proxy = await ChaosProxy.start(booted.hub.address!)
  let worker: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    worker = await startMockWorker(booted.hub, 'pi-dash-6', booted.workspace, join(booted.workspace, 'state'), undefined, proxy.url)
    const token = await apiToken(booted.hub)
    const created = expectSchema(api.TaskDetail, await rest(booted.hub)('POST', '/api/v1/tasks', { token,
      payload: { prompt: '#scenario: slow ms=120000', workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
    await waitDetail(booted.hub, token, created.id, task => task.status === 'running', 'running')
    await login(client, ADMIN)
    await client.getByTestId('system-tab').click()
    const pill = client.getByTestId('worker-card-pi-dash-6').getByTestId('worker-connection')
    const grace = client.getByTestId('worker-card-pi-dash-6').getByTestId('worker-grace')
    await pw(pill).toHaveText('在线', { timeout: 25_000 })
    await pw(grace).toHaveCount(0)

    // 彻底断网（Worker 侧不可达）：节点转离线并开始宽限期倒计时
    proxy.down()
    await eventually(() => booted.hub.ctx.workers.get('pi-dash-6')?.connection === 'offline', { timeoutMs: 25_000, label: 'offline' })
    await pw(pill).toHaveText('离线', { timeout: 25_000 })
    await pw(grace).toBeVisible({ timeout: 25_000 })
    const graceText = await grace.innerText()
    expect(graceText).toMatch(/离线宽限期 · \d+s/)
    const seconds = Number(/· (\d+)s/.exec(graceText)![1])
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(31)

    // 网络恢复：同一 Worker 重连上线，节点变绿、宽限期消失
    proxy.up()
    await pw(pill).toHaveText('在线', { timeout: 60_000 })
    await pw(grace).toHaveCount(0, { timeout: 25_000 })
    const recovered = await waitDetail(booted.hub, token, created.id,
      task => task.status === 'running' || task.status === 'cancelling', 'still running')
    expect(recovered.runs[0]!.status).toBe('running')
  } finally { await client.context().close(); await proxy.close(); await worker?.worker.close(); await booted.cleanup() }
}, 300_000)

it('DASH-7 Drain 切换后新任务不派发给该节点', async () => {
  const booted = await boot()
  let drained: Awaited<ReturnType<typeof startMockWorker>> | undefined
  let spare: Awaited<ReturnType<typeof startMockWorker>> | undefined
  const client = await page(booted.origin)
  try {
    drained = await startMockWorker(booted.hub, 'pi-dash-7a', join(booted.workspace, 'a'), join(booted.workspace, 'state-a'))
    spare = await startMockWorker(booted.hub, 'pi-dash-7b', join(booted.workspace, 'b'), join(booted.workspace, 'state-b'))
    const token = await apiToken(booted.hub)
    await login(client, ADMIN)
    await client.getByTestId('system-tab').click()
    const toggle = client.getByTestId('worker-card-pi-dash-7a').getByTestId('worker-drain')
    await pw(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 })
    await toggle.click()
    await pw(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
    await pw(toggle).toContainText('排空中')
    await eventually(() => booted.hub.ctx.workers.get('pi-dash-7a')?.drain === true, { timeoutMs: 10_000, label: 'drained' })

    for (let index = 0; index < 3; index++) {
      const created = expectSchema(api.TaskDetail, await rest(booted.hub)('POST', '/api/v1/tasks', { token,
        payload: { prompt: '#scenario: success n=' + (index + 2), workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
      const done = await waitDetail(booted.hub, token, created.id, task => task.status === 'succeeded', 'task ' + index)
      expect(done.runs[0]!.workerId).toBe('pi-dash-7b')
    }
    await pw(client.getByTestId('worker-card-pi-dash-7a')).toContainText('排空中')
    // 取消 Drain 后恢复可调度
    await toggle.click()
    await pw(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
    await eventually(() => booted.hub.ctx.workers.get('pi-dash-7a')?.drain === false, { timeoutMs: 10_000, label: 'undrained' })
  } finally { await client.context().close(); await drained?.worker.close(); await spare?.worker.close(); await booted.cleanup() }
}, 240_000)

it('DASH-8 10 万行日志抽屉滚动流畅（无 > 200ms 长任务）', async () => {
  const booted = await boot()
  const client = await page(booted.origin)
  try {
    await enrollWorker(booted.hub, 'pi-dash-8')
    const task = booted.hub.ctx.orchestrator.getTask(
      seedRun(booted.hub, { workerId: 'pi-dash-8', taskStatus: 'running', runStatus: 'running' }).taskId)!
    const runId = task.runs[0]!.id
    const total = 100_000
    for (let from = 1; from <= total; from += 5000) {
      const events = Array.from({ length: 5000 }, (_, index) => ({ seq: from + index, ts: booted.hub.ctx.clock.now(),
        kind: 'log' as const, stream: 'stdout' as const, text: 'line ' + (from + index) + ' 中文日志内容 payload' }))
      const job = booted.hub.ctx.store.ingest.enqueue(runId, events)
      await booted.hub.ctx.store.ingest.flush()
      await job
    }
    expect((booted.hub.ctx.store.repos.prepare('SELECT count(*) AS n FROM task_logs WHERE run_id = ?').get(runId) as { n: number }).n)
      .toBe(total)

    await login(client, ADMIN)
    await client.getByTestId('show-history').click()
    await client.getByTestId('task-search').fill('seed')
    await client.getByTestId('task-row-' + task.taskNo).click()
    await pw(client.getByTestId('mission-drawer')).toBeVisible({ timeout: 20_000 })
    await client.getByTestId('tech-details').locator('summary').click()
    await pw(client.getByTestId('log-count')).toHaveText('100,000 条记录', { timeout: 60_000 })

    // 虚拟列表：DOM 行数必须远小于总行数
    const rendered = await client.getByTestId('terminal-structured').locator('.log-row').count()
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(400)

    // 重置长任务记录，只统计滚动期间
    await client.evaluate(() => { (window as unknown as { __longTasks: number[] }).__longTasks = [] })
    await client.getByTestId('terminal-structured').hover()
    for (let index = 0; index < 12; index++) {
      await client.mouse.wheel(0, index % 2 === 0 ? 4000 : -1200)
      await delay(60)
    }
    await client.evaluate(() => {
      const node = document.querySelector('[data-testid="terminal-structured"]') as HTMLElement | null
      if (node) node.scrollTop = 0
    })
    await delay(120)
    const longTasks = await client.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
    expect(Array.isArray(longTasks)).toBe(true)
    expect(Math.max(0, ...longTasks)).toBeLessThan(200)
    await pw(client.getByTestId('terminal-structured')).toBeVisible()
  } finally { await client.context().close(); await booted.cleanup() }
}, 300_000)
