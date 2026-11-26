import type { Context } from 'cordis'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from '@agent-hub/common'
import type { Actor, BoardSnapshot, BriefingAction, BriefingFinding, BriefingHealth, ProjectBriefingView, ProjectOverview, RunBriefingRequest, TaskDetailView, TaskOrigin } from '@agent-hub/protocol'
import type { Orchestrator } from '../../services/orchestrator.js'
import type { Repos } from '../../services/store.js'
import { HubError } from '../../services/errors.js'
import { projectBriefings } from '../store-sqlite/schema.js'

const STALE_BOARD_MS = 7 * 86_400_000

function parseSectionLines(content: string | undefined, sectionHeading: string): string[] {
  if (!content) return []
  const lines = content.split(/\r?\n/u)
  const out: string[] = []
  let active = false
  for (const raw of lines) {
    const line = raw.trim()
    const match = /^##\s+(.+)$/u.exec(line)
    if (match) {
      active = match[1]!.trim().toLowerCase() === sectionHeading.toLowerCase()
      continue
    }
    if (active && line && !/^<!--/.test(line) && !/^(none|无|暂无)$/i.test(line)) {
      out.push(line.replace(/^[-*]\s+|^\d+[.)]\s+/u, '').trim())
    }
  }
  return out
}

export function analyzeProjectHealth(project: ProjectOverview, now: number): {
  health: BriefingHealth
  summary: string
  findings: BriefingFinding[]
  actions: BriefingAction[]
} {
  const findings: BriefingFinding[] = []
  const actions: BriefingAction[] = []
  const label = project.subdir ? `${project.workspaceId}/${project.subdir}` : project.workspaceId
  const board = project.board as BoardSnapshot | null
  const addAction = (title: string, prompt: string, adapter: BriefingAction['adapter'], profile: BriefingAction['profile'] = 'edit') => {
    if (actions.length >= 3) return
    const allowed = project.allowedAdapters
    const chosen = adapter && allowed.includes(adapter) ? adapter : allowed[0]
    actions.push({
      index: actions.length + 1,
      title: title.slice(0, 120),
      prompt: prompt.slice(0, 4000),
      ...(chosen && { adapter: chosen }),
      profile,
    })
  }

  if (project.latestVerification === 'failed' || project.latestVerification === 'unverified') {
    findings.push({
      severity: 'error',
      category: 'verification',
      message: `最近一次任务 (#${project.latestTaskNo ?? '?'}) 验证结果为 ${project.latestVerification === 'failed' ? '失败' : '未验证'}`,
    })
    addAction(
      `修复 #${project.latestTaskNo ?? ''} 的验证问题`,
      `检查项目 ${label} 最近一次任务 #${project.latestTaskNo ?? ''} 的测试/验证失败原因并修复，确保通过检查。`,
      'codex',
      'full',
    )
  }

  if (project.totalTasks > 0 && project.failedTasks > project.succeededTasks) {
    findings.push({
      severity: 'warning',
      category: 'task_health',
      message: `累计失败任务 (${project.failedTasks}) 超过成功任务 (${project.succeededTasks})`,
    })
  }

  if (!board) {
    if (project.totalTasks > 0) {
      findings.push({
        severity: 'warning',
        category: 'board_stale',
        message: '尚未检测到 .board/ 记忆快照，建议补齐项目记忆文件以提升 AI 连续性',
      })
      addAction(
        `初始化 ${project.label} 的 .board/ 项目记忆`,
        `为项目 ${label} 检查代码结构并在 .board/ 初始化或补全 PROJECT_STATE.md、HANDOFF.md、DECISIONS.md、LESSONS.md。`,
        'claude-code',
        'edit',
      )
    }
  } else {
    if (board.dir === 'unsafe' || board.files.some(f => f.status === 'unsafe')) {
      findings.push({ severity: 'error', category: 'board_unsafe', message: '.board/ 存在不安全路径或符号链接，已被拒绝写入' })
    }
    const overBudget = board.files.filter(f => f.overBudget).map(f => f.file)
    if (overBudget.length) {
      findings.push({ severity: 'warning', category: 'board_budget', message: `黑板文件超出预算上限：${overBudget.join('、')}，建议精简归档` })
      addAction(
        '精简超预算的黑板记忆文件',
        `精简项目 ${label} 的 ${overBudget.join('、')}，保留核心事实与近期决策，控制在字符预算内。`,
        'claude-code',
        'edit',
      )
    }
    if (
      project.boardCapturedAt &&
      (now - project.boardCapturedAt > STALE_BOARD_MS ||
        (project.lastActiveAt && project.lastActiveAt - project.boardCapturedAt > STALE_BOARD_MS))
    ) {
      findings.push({ severity: 'info', category: 'board_stale', message: '黑板记忆超过 7 天未更新，可能与代码现状产生漂移' })
      addAction(
        '同步并刷新 .board/ 项目现状',
        `核对项目 ${label} 当前代码与 Git 提交记录，更新 .board/PROJECT_STATE.md 与 .board/HANDOFF.md，消除记忆漂移。`,
        'claude-code',
        'edit',
      )
    }
    const state = board.files.find(f => f.file === 'PROJECT_STATE.md')?.content
    const handoff = board.files.find(f => f.file === 'HANDOFF.md')?.content
    const openQuestions = parseSectionLines(handoff, 'Open Questions')
    if (openQuestions.length) {
      findings.push({ severity: 'info', category: 'open_questions', message: `有 ${openQuestions.length} 个待拍板问题：${openQuestions[0]!.slice(0, 80)}` })
    }
    const debt = parseSectionLines(state, 'Active Tech Debt')
    if (debt.length) {
      findings.push({ severity: 'info', category: 'tech_debt', message: `待处理技术债：${debt[0]!.slice(0, 80)}` })
      addAction(`处理技术债：${debt[0]!.slice(0, 60)}`, `处理项目 ${label} 记录的技术债：${debt[0]!}`, 'codex', 'edit')
    }
    const nextItems = parseSectionLines(handoff, 'Next')
    for (const item of nextItems) {
      if (actions.length >= 3) break
      addAction(item.slice(0, 80), `执行项目 ${label} 黑板交接中的下一步待办：${item}`, 'codex', 'edit')
    }
  }

  const hasError = findings.some(f => f.severity === 'error')
  const hasWarn = findings.some(f => f.severity === 'warning')
  const health: BriefingHealth = hasError ? 'warning' : hasWarn || findings.length > 0 ? 'attention' : 'healthy'
  const summaryParts = [
    `${project.label}: 累计 ${project.totalTasks} 任务 (成功 ${project.succeededTasks} / 失败 ${project.failedTasks})`,
    findings.length ? `发现 ${findings.length} 项关注点` : '项目状态健康，记忆与验证同步良好',
  ]
  return { health, summary: summaryParts.join(' · '), findings, actions }
}

export function runStewardBriefing(
  ctx: Context,
  projects: ProjectOverview[],
  kind: 'morning' | 'manual' | 'patrol',
  filter: RunBriefingRequest = {},
  notifyFeishu = Boolean(filter.notifyFeishu),
): ProjectBriefingView[] {
  const now = ctx.clock.now()
  const hasSubdirs = new Set(projects.filter(p => p.subdir).map(p => `${p.workerId}\0${p.workspaceId}`))
  const targets = projects.filter(p => {
    if (filter.workerId && p.workerId !== filter.workerId) return false
    if (filter.workspaceId && p.workspaceId !== filter.workspaceId) return false
    if (filter.subdir !== undefined) return (p.subdir ?? '') === filter.subdir
    // Avoid duplicate noise on parent workspaces that already contain distinct project subdirs.
    if (!p.subdir && hasSubdirs.has(`${p.workerId}\0${p.workspaceId}`)) return false
    return true
  })
  const created: ProjectBriefingView[] = []
  ctx.store.tx(db => {
    for (const project of targets) {
      const analysis = analyzeProjectHealth(project, now)
      const id = 'brf_' + ulid(now)
      const view: ProjectBriefingView = {
        id,
        workerId: project.workerId,
        workspaceId: project.workspaceId,
        subdir: project.subdir ?? '',
        kind,
        health: analysis.health,
        summary: analysis.summary,
        findings: analysis.findings,
        actions: analysis.actions,
        createdAt: now,
      }
      db.insert(projectBriefings).values({
        id,
        workerId: project.workerId,
        workspaceId: project.workspaceId,
        subdir: project.subdir ?? '',
        kind,
        health: analysis.health,
        summary: analysis.summary,
        findingsJson: JSON.stringify(analysis.findings),
        actionsJson: JSON.stringify(analysis.actions),
        deliveredChatIdsJson: null,
        createdAt: now,
      }).run()
      created.push(view)
    }
  })
  if (created.length) ctx.emit('steward/briefing', created, notifyFeishu)
  return created
}

export function listBriefings(db: Repos, query: { workerId?: string | undefined; workspaceId?: string | undefined; subdir?: string | undefined; limit?: number | undefined } = {}): ProjectBriefingView[] {
  const conditions = []
  if (query.workerId) conditions.push(eq(projectBriefings.workerId, query.workerId))
  if (query.workspaceId) conditions.push(eq(projectBriefings.workspaceId, query.workspaceId))
  if (query.subdir !== undefined) conditions.push(eq(projectBriefings.subdir, query.subdir))
  const rows = db.select().from(projectBriefings)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(projectBriefings.createdAt))
    .limit(Math.min(50, query.limit ?? 20))
    .all()
  return rows.map(row => ({
    id: row.id,
    workerId: row.workerId,
    workspaceId: row.workspaceId,
    subdir: row.subdir,
    kind: row.kind as ProjectBriefingView['kind'],
    health: row.health as BriefingHealth,
    summary: row.summary,
    findings: JSON.parse(row.findingsJson) as BriefingFinding[],
    actions: JSON.parse(row.actionsJson) as BriefingAction[],
    createdAt: row.createdAt,
  }))
}

export async function dispatchBriefingAction(
  ctx: Context,
  orchestrator: Orchestrator,
  briefingId: string,
  index: number,
  actor: Actor,
  opts: { origin?: TaskOrigin; idempotencyKey?: string } = {},
): Promise<TaskDetailView> {
  const row = ctx.store.repos.select().from(projectBriefings).where(eq(projectBriefings.id, briefingId)).get()
  if (!row) throw new HubError('TASK_NOT_FOUND', 404, { reason: 'BRIEFING_NOT_FOUND' })
  const actions = JSON.parse(row.actionsJson) as BriefingAction[]
  const action = actions.find(a => a.index === index)
  if (!action) throw new HubError('VALIDATION_FAILED', 400, { reason: 'ACTION_NOT_FOUND' })
  return orchestrator.createTask({
    prompt: action.prompt,
    workspaceId: row.workspaceId,
    ...(row.subdir && { subdir: row.subdir }),
    requiredWorkerId: row.workerId,
    ...(action.adapter && { adapter: action.adapter }),
    profile: action.profile,
    ...(opts.origin && { origin: opts.origin }),
  }, actor, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {})
}

export function nextDailyBriefingAt(now: number, hour: number, minute: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = (ts: number) => {
    const map = Object.fromEntries(fmt.formatToParts(ts).map(p => [p.type, Number(p.value)]))
    return {
      year: map.year ?? 1970,
      month: map.month ?? 1,
      day: map.day ?? 1,
      hour: (map.hour ?? 0) % 24,
      minute: map.minute ?? 0,
      second: map.second ?? 0,
    }
  }
  const cur = parts(now)
  const curSec = cur.hour * 3600 + cur.minute * 60 + cur.second
  const targetSec = hour * 3600 + minute * 60
  let dayOffset = curSec >= targetSec ? 1 : 0
  for (let attempt = 0; attempt < 3; attempt++) {
    const targetWallAsUtc = Date.UTC(cur.year, cur.month - 1, cur.day + dayOffset, hour, minute, 0, 0)
    let candidate = targetWallAsUtc
    for (let i = 0; i < 3; i++) {
      const p = parts(candidate)
      const diff = targetWallAsUtc - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0)
      if (diff === 0) break
      candidate += diff
    }
    if (candidate > now) return candidate
    dayOffset++
  }
  return now + 86_400_000
}
