import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  PersonalProjectView,
  ProjectBriefingView,
  ProjectOverview,
  RunArtifactView,
  TaskDetail,
  WorkerView,
} from '@agent-hub/protocol'
import { AutopilotPanel } from '../src/AutopilotPanel.js'
import { BriefingPanel } from '../src/BriefingPanel.js'
import { ProjectHub } from '../src/ProjectHub.js'
import { RelayChain } from '../src/RelayChain.js'
import { VisualCompare, groupVisualArtifacts } from '../src/VisualCompare.js'

const renderWithCache = (node: ReactElement, seed: (client: QueryClient) => void) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(client)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node))
}

const sampleProject: ProjectOverview = {
  workerId: 'w-main',
  workspaceId: 'soren',
  subdir: 'Forma',
  label: 'Forma',
  isGitRepo: true,
  workerOnline: true,
  allowedAdapters: ['codex', 'claude-code'],
  activeTasks: 0,
  totalTasks: 2,
  succeededTasks: 1,
  failedTasks: 1,
  latestTaskId: 'tsk_' + '1'.repeat(26),
  latestTaskNo: 11,
  latestRunId: 'run_' + '1'.repeat(26),
  latestVerification: 'passed',
  board: {
    dir: 'present',
    capturedAt: 1700000000000,
    agentsMd: { status: 'absent', bytes: 0 },
    files: [
      { file: 'PROJECT_STATE.md', status: 'present', bytes: 40, lines: 2, schemaOk: true, overBudget: false, content: '# Forma\nok' },
      { file: 'HANDOFF.md', status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false },
      { file: 'DECISIONS.md', status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false },
      { file: 'LESSONS.md', status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false },
    ],
  },
}

const sampleWorker: WorkerView = {
  id: 'w-main',
  displayName: 'Main Worker',
  connection: 'online',
  status: 'active',
  drain: false,
  maxConcurrency: 2,
  slotsUsed: 0,
  lastSeenAt: 1700000000000,
  version: '0.1.0',
  hostname: 'host',
  os: 'win32',
  capabilities: ['blackboard.v1', 'verify.v1'],
  adapters: [{ id: 'codex', status: 'ready', features: { resume: true, liveInput: false, structuredOutput: true } }],
  workspaces: [{ id: 'soren', label: 'Soren', allowedAdapters: ['codex'], maxProfile: 'full', maxConcurrent: 2, isGitRepo: false }],
  droppedLogBytesTotal: 0,
}

describe('dashboard war-room components', () => {
  it('renders VisualCompare before/after cards, errors, blank-page alerts, and empty fallback', () => {
    const taskId = 'tsk_' + '1'.repeat(26)
    const runId = 'run_' + '1'.repeat(26)
    const artifacts: RunArtifactView[] = [
      {
        id: 'art_' + '1'.repeat(26),
        taskId,
        runId,
        kind: 'visual_before',
        label: '/chart',
        mimeType: 'image/jpeg',
        bytes: 1200,
        sha256: 'a'.repeat(64),
        meta: { route: '/chart', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [] },
        createdAt: 1000,
        url: '/api/v1/artifacts/art_' + '1'.repeat(26),
      },
      {
        id: 'art_' + '2'.repeat(26),
        taskId,
        runId,
        kind: 'visual_after',
        label: '/chart',
        mimeType: 'image/jpeg',
        bytes: 1300,
        sha256: 'b'.repeat(64),
        meta: { route: '/chart', statusCode: 200, blankPage: true, consoleErrors: ['ReferenceError: x is not defined'], pageErrors: [] },
        createdAt: 1005,
        url: '/api/v1/artifacts/art_' + '2'.repeat(26),
      },
    ]

    const html = renderWithCache(
      createElement(VisualCompare, { taskId, runId }),
      client => client.setQueryData(['run-artifacts', taskId, runId], artifacts),
    )
    expect(html).toContain('真机视觉验收对比')
    expect(html).toContain('改前')
    expect(html).toContain('改后')
    expect(html).toContain('白屏告警')
    expect(html).toContain('1 条页面报错')
    expect(html).toContain('ReferenceError: x is not defined')

    const emptyHtml = renderWithCache(
      createElement(VisualCompare, { taskId, runId, showEmpty: true }),
      client => client.setQueryData(['run-artifacts', taskId, runId], []),
    )
    expect(emptyHtml).toContain('最近一次运行暂无视觉验收截图')
  })

  it('renders AutopilotPanel preflight controls, 1-sentence goal form, phase stepper, and active items table', () => {
    const personal: PersonalProjectView[] = [{
      id: 'forma-1',
      phase: 'implementing',
      control: 'running',
      reason: null,
      currentItem: 'T01',
      taskId: 'tsk_' + '9'.repeat(26),
      runId: null,
      lastCommit: null,
      branch: 'main',
      activeMs: 5000,
      workspaceId: 'soren',
      subdir: 'Forma',
      mode: 'flexible',
      autoCommit: true,
      autoPush: false,
      items: [{ id: 'T01', title: '导出表格', status: 'delivering', reviewRounds: 1, commitSha: 'abcdef123456' }],
    }]

    const html = renderWithCache(
      createElement(AutopilotPanel, { project: sampleProject, open: () => undefined }),
      client => client.setQueryData(['personal-projects'], personal),
    )
    expect(html).toContain('一句话启动三角色自动交付')
    expect(html).toContain('在线预检环境')
    expect(html).toContain('forma-1')
    expect(html).toContain('导出表格')
    expect(html).toContain('abcdef12')
  })

  it('renders BriefingPanel health badge, findings, and recommended dispatch buttons', () => {
    const briefings: ProjectBriefingView[] = [{
      id: 'brf_' + '1'.repeat(26),
      workerId: 'w-main',
      workspaceId: 'soren',
      subdir: 'Forma',
      kind: 'manual',
      health: 'warning',
      summary: 'Forma: 累计 2 任务 · 发现 1 项关注点',
      findings: [{ severity: 'warning', category: 'board_budget', message: '黑板文件超出预算上限：HANDOFF.md' }],
      actions: [{ index: 1, title: '精简黑板文件', prompt: '压缩 HANDOFF.md', adapter: 'claude-code', profile: 'edit' }],
      createdAt: 1700000000000,
    }]

    const html = renderWithCache(
      createElement(BriefingPanel, { project: sampleProject, open: () => undefined }),
      client => client.setQueryData(['briefings', 'w-main', 'soren', 'Forma'], briefings),
    )
    expect(html).toContain('需要处理')
    expect(html).toContain('board_budget')
    expect(html).toContain('#1 精简黑板文件')
    expect(html).toContain('派发执行')
  })

  it('scopes AutopilotPanel and BriefingPanel strictly by workerId and selects the latest visual_after shot per route', () => {
    const otherWorkerProject: ProjectOverview = { ...sampleProject, workerId: 'w-other' }
    const multiPersonal: PersonalProjectView[] = [{
      id: 'forma-other',
      phase: 'implementing',
      control: 'running',
      reason: null,
      currentItem: 'T09',
      taskId: null,
      runId: null,
      lastCommit: null,
      branch: 'main',
      activeMs: 1000,
      workerId: 'w-other',
      workspaceId: 'soren',
      subdir: 'Forma',
      mode: 'flexible',
      autoCommit: true,
      autoPush: false,
      items: [{ id: 'T09', title: '不应串号展示', status: 'running', reviewRounds: 0, commitSha: null }],
    }]
    const autopilotHtml = renderWithCache(
      createElement(AutopilotPanel, { project: sampleProject, open: () => undefined }),
      client => client.setQueryData(['personal-projects'], multiPersonal),
    )
    expect(autopilotHtml).not.toContain('forma-other')
    expect(autopilotHtml).not.toContain('不应串号展示')

    const otherHtml = renderWithCache(
      createElement(AutopilotPanel, { project: otherWorkerProject, open: () => undefined }),
      client => client.setQueryData(['personal-projects'], multiPersonal),
    )
    expect(otherHtml).toContain('forma-other')

    const otherBriefings: ProjectBriefingView[] = [{
      id: 'brf_' + '9'.repeat(26),
      workerId: 'w-other',
      workspaceId: 'soren',
      subdir: 'Forma',
      kind: 'manual',
      health: 'warning',
      summary: '其他节点简报',
      findings: [{ severity: 'warning', category: 'verification', message: '来自 w-other' }],
      actions: [],
      createdAt: 1700000001000,
    }]
    const briefingHtml = renderWithCache(
      createElement(BriefingPanel, { project: sampleProject, open: () => undefined }),
      client => client.setQueryData(['briefings', 'w-other', 'soren', 'Forma'], otherBriefings),
    )
    expect(briefingHtml).not.toContain('来自 w-other')

    const otherBriefingHtml = renderWithCache(
      createElement(BriefingPanel, { project: otherWorkerProject, open: () => undefined }),
      client => client.setQueryData(['briefings', 'w-other', 'soren', 'Forma'], otherBriefings),
    )
    expect(otherBriefingHtml).toContain('来自 w-other')

    const taskId = 'tsk_' + '5'.repeat(26)
    const runId = 'run_' + '5'.repeat(26)
    const shots: RunArtifactView[] = [
      {
        id: 'art_' + '1'.repeat(26),
        taskId,
        runId,
        kind: 'visual_before',
        label: '/chart',
        mimeType: 'image/jpeg',
        bytes: 1000,
        sha256: 'a'.repeat(64),
        meta: { route: '/chart', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [] },
        createdAt: 1000,
        url: '/api/v1/artifacts/art_' + '1'.repeat(26),
      },
      {
        id: 'art_' + '2'.repeat(26),
        taskId,
        runId,
        kind: 'visual_after',
        label: '/chart',
        mimeType: 'image/jpeg',
        bytes: 1100,
        sha256: 'b'.repeat(64),
        meta: { route: '/chart', statusCode: 500, blankPage: true, consoleErrors: ['STALE_ERROR_1004'], pageErrors: [] },
        createdAt: 1004,
        url: '/api/v1/artifacts/art_' + '2'.repeat(26),
      },
      {
        id: 'art_' + '3'.repeat(26),
        taskId,
        runId,
        kind: 'visual_after',
        label: '/chart',
        mimeType: 'image/jpeg',
        bytes: 1200,
        sha256: 'c'.repeat(64),
        meta: { route: '/chart', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [] },
        createdAt: 1005,
        url: '/api/v1/artifacts/art_' + '3'.repeat(26),
      },
    ]
    const visualHtml = renderWithCache(
      createElement(VisualCompare, { taskId, runId }),
      client => client.setQueryData(['run-artifacts', taskId, runId], shots),
    )
    expect(visualHtml).toContain('art_' + '3'.repeat(26))
    expect(visualHtml).not.toContain('STALE_ERROR_1004')

    // Round 6 P1 #3: Two distinct routeIndex values sharing one redacted label never cross-pair
    const collisionShots: RunArtifactView[] = [
      {
        id: 'art_' + '7'.repeat(26),
        taskId,
        runId,
        kind: 'visual_before',
        label: '/?token=[REDACTED]',
        mimeType: 'image/jpeg',
        bytes: 900,
        sha256: 'd'.repeat(64),
        meta: { routeIndex: 0, route: '/?token=[REDACTED]', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [] },
        createdAt: 1001,
        url: '/api/v1/artifacts/art_' + '7'.repeat(26),
      },
      {
        id: 'art_' + '8'.repeat(26),
        taskId,
        runId,
        kind: 'visual_after',
        label: '/?token=[REDACTED]',
        mimeType: 'image/jpeg',
        bytes: 910,
        sha256: 'e'.repeat(64),
        meta: { routeIndex: 1, route: '/?token=[REDACTED]', statusCode: 200, blankPage: false, consoleErrors: [], pageErrors: [] },
        createdAt: 1002,
        url: '/api/v1/artifacts/art_' + '8'.repeat(26),
      },
    ]
    const groups = groupVisualArtifacts(collisionShots)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ key: 'idx:0', label: '/?token=[REDACTED] (#1)' })
    expect(groups[0]?.before?.id).toBe('art_' + '7'.repeat(26))
    expect(groups[0]?.after).toBeUndefined()
    expect(groups[1]).toMatchObject({ key: 'idx:1', label: '/?token=[REDACTED] (#2)' })
    expect(groups[1]?.before).toBeUndefined()
    expect(groups[1]?.after?.id).toBe('art_' + '8'.repeat(26))
    const colHtml = renderWithCache(
      createElement(VisualCompare, { taskId, runId }),
      client => client.setQueryData(['run-artifacts', taskId, runId], collisionShots),
    )
    expect(colHtml).toContain('/?token=[REDACTED] (#1)')
    expect(colHtml).toContain('/?token=[REDACTED] (#2)')
    expect(visualHtml).not.toContain('白屏告警')
  })

  it('renders RelayChain upstream/child lineage and method distillation button on succeeded tasks only', () => {
    const parentId = 'tsk_' + '0'.repeat(26)
    const childId = 'tsk_' + '2'.repeat(26)
    const baseTask: TaskDetail = {
      id: 'tsk_' + '1'.repeat(26),
      taskNo: 11,
      title: '修复图表布局',
      status: 'succeeded',
      version: 1,
      prompt: 'fix layout',
      workspaceId: 'soren',
      subdir: 'Forma',
      adapter: 'codex',
      profile: 'edit',
      priority: 0,
      createdAt: 1000,
      updatedAt: 2000,
      finishedAt: 2000,
      origin: { source: 'dashboard' },
      requester: { type: 'owner', id: 'owner', channel: 'dashboard' },
      allowedActions: ['followup'],
      parentTaskId: parentId,
      handoff: { fromTaskId: parentId, fromTaskNo: 10, intent: 'fix' },
      runs: [{
        id: 'run_' + '1'.repeat(26),
        taskId: 'tsk_' + '1'.repeat(26),
        workerId: 'w-main',
        attempt: 1,
        status: 'succeeded',
        adapter: 'codex',
        profile: 'edit',
        dispatchedAt: 1100,
        finishedAt: 2000,
        durationMs: 900,
      }],
      children: [{
        id: childId,
        taskNo: 12,
        title: '后续回归',
        status: 'queued',
        version: 1,
        workspaceId: 'soren',
        profile: 'edit',
        priority: 0,
        createdAt: 2100,
        updatedAt: 2100,
        origin: { source: 'dashboard' },
        requester: { type: 'owner', id: 'owner', channel: 'dashboard' },
        allowedActions: ['cancel'],
        resultDeliveryStatus: 'not_required',
        filesChangedCount: 0,
      }],
      resultSummary: '已修复',
      resultDeliveryStatus: 'not_required',
      filesChanged: [],
      audit: [],
    }

    const succeededHtml = renderWithCache(
      createElement(RelayChain, { task: baseTask, open: () => undefined }),
      () => undefined,
    )
    expect(succeededHtml).toContain('Agent 接力轨迹与经验沉淀')
    expect(succeededHtml).toContain('#10')
    expect(succeededHtml).toContain('#11')
    expect(succeededHtml).toContain('#12')
    expect(succeededHtml).toContain('沉淀为方法卡')

    const failedHtml = renderWithCache(
      createElement(RelayChain, { task: { ...baseTask, status: 'failed' }, open: () => undefined }),
      () => undefined,
    )
    expect(failedHtml).not.toContain('沉淀为方法卡')
  })

  it('renders ProjectHub War Room sub-tabs for a selected project', () => {
    const query = {
      data: [{ ...sampleProject, subdir: undefined, label: 'Soren' }, sampleProject],
      isPending: false,
      isSuccess: true,
      error: null,
    } as unknown as Parameters<typeof ProjectHub>[0]['query']

    const html = renderWithCache(
      createElement(ProjectHub, {
        query,
        workers: [sampleWorker],
        scope: { workspaceId: 'soren', subdir: 'Forma' },
        setScope: () => undefined,
        open: () => undefined,
        create: () => undefined,
      }),
      () => undefined,
    )
    expect(html).toContain('项目管理中心')
    expect(html).toContain('📋 项目黑板')
    expect(html).toContain('🚀 自动交付')
    expect(html).toContain('📸 视觉验收')
    expect(html).toContain('🔍 巡检简报')
  })
})
