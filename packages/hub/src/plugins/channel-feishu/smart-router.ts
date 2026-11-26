import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { ulid } from '@agent-hub/common'
import type { AdapterId, Profile, ProjectOverview } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { feishuChatState, feishuProposals } from '../store-sqlite/schema.js'

export interface ChatProjectState {
  chatId: string
  threadId: string
  workspaceId: string | null
  subdir: string | null
  adapter: string | null
  profile: string | null
  lastTaskId: string | null
  lastMessageId: string | null
  updatedAt: number
}

export function getChatState(db: Repos, chatId: string, threadId = ''): ChatProjectState | undefined {
  return db.select().from(feishuChatState)
    .where(and(eq(feishuChatState.chatId, chatId), eq(feishuChatState.threadId, threadId))).get()
    ?? (threadId ? db.select().from(feishuChatState).where(and(eq(feishuChatState.chatId, chatId), eq(feishuChatState.threadId, ''))).get() : undefined)
}

export function saveChatState(
  db: Repos,
  chatId: string,
  threadId: string,
  patch: Partial<Pick<ChatProjectState, 'workspaceId' | 'subdir' | 'adapter' | 'profile' | 'lastTaskId' | 'lastMessageId'>>,
  now: number,
) {
  const existing = db.select().from(feishuChatState).where(and(eq(feishuChatState.chatId, chatId), eq(feishuChatState.threadId, threadId))).get()
  const row = {
    chatId,
    threadId,
    workspaceId: patch.workspaceId !== undefined ? patch.workspaceId : existing?.workspaceId ?? null,
    subdir: patch.subdir !== undefined ? patch.subdir : existing?.subdir ?? null,
    adapter: patch.adapter !== undefined ? patch.adapter : existing?.adapter ?? null,
    profile: patch.profile !== undefined ? patch.profile : existing?.profile ?? null,
    lastTaskId: patch.lastTaskId !== undefined ? patch.lastTaskId : existing?.lastTaskId ?? null,
    lastMessageId: patch.lastMessageId !== undefined ? patch.lastMessageId : existing?.lastMessageId ?? null,
    updatedAt: now,
  }
  db.insert(feishuChatState).values(row).onConflictDoUpdate({
    target: [feishuChatState.chatId, feishuChatState.threadId],
    set: row,
  }).run()
}

export function resolveProjectFromText(
  text: string,
  projects: ProjectOverview[],
): { match?: { workspaceId: string; subdir?: string }; ambiguous?: string[] } {
  const unique = new Map<string, { workspaceId: string; subdir?: string }>()
  for (const p of projects) {
    const key = p.subdir ? `${p.workspaceId}\0${p.subdir}` : p.workspaceId
    if (!unique.has(key)) unique.set(key, { workspaceId: p.workspaceId, ...(p.subdir && { subdir: p.subdir }) })
  }
  const deduped = [...unique.values()]
  const trimmed = text.trim()
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const subProjects = deduped.filter((p): p is { workspaceId: string; subdir: string } => Boolean(p.subdir))
  const qualifiedMatches = subProjects
    .filter(p => new RegExp(`(?:^|[^A-Za-z0-9_./\\\\-])${esc(p.workspaceId)}[/\\\\]${esc(p.subdir)}(?:$|[^A-Za-z0-9_./\\\\-])`, 'i').test(text))
    .sort((a, b) => (b.workspaceId.length + b.subdir.length) - (a.workspaceId.length + a.subdir.length))
  if (qualifiedMatches.length) {
    const maxLen = qualifiedMatches[0]!.workspaceId.length + qualifiedMatches[0]!.subdir.length
    const best = qualifiedMatches.filter(p => p.workspaceId.length + p.subdir.length === maxLen)
    if (best.length === 1) return { match: { workspaceId: best[0]!.workspaceId, subdir: best[0]!.subdir } }
    return { ambiguous: best.map(p => `${p.workspaceId}/${p.subdir}`).sort() }
  }

  const rootProjects = deduped.filter(p => !p.subdir)
  const exactRoot = rootProjects.find(p => p.workspaceId.toLowerCase() === trimmed.toLowerCase())
  if (exactRoot) return { match: { workspaceId: exactRoot.workspaceId } }

  const bareMatches = subProjects
    .filter(p => {
      const escaped = esc(p.subdir)
      const re = /^[A-Za-z0-9._-]+$/.test(p.subdir)
        ? new RegExp(`(?:^|[^A-Za-z0-9_./\\\\-])${escaped}(?:$|[^A-Za-z0-9_./\\\\-])`, 'i')
        : new RegExp(escaped, 'i')
      return re.test(text)
    })
    .sort((a, b) => b.subdir.length - a.subdir.length)
  if (bareMatches.length) {
    const maxLen = bareMatches[0]!.subdir.length
    const best = bareMatches.filter(p => p.subdir.length === maxLen)
    if (best.length === 1) return { match: { workspaceId: best[0]!.workspaceId, subdir: best[0]!.subdir } }
    return { ambiguous: best.map(p => `${p.workspaceId}/${p.subdir}`).sort() }
  }

  const lower = text.toLowerCase()
  const wsMatches = rootProjects.filter(p => {
    const ws = p.workspaceId.toLowerCase()
    return ws.length >= 3 && (lower.includes(ws + ' ') || lower.includes(' ' + ws) || lower.includes('[' + ws + ']'))
  })
  if (wsMatches.length === 1) return { match: { workspaceId: wsMatches[0]!.workspaceId } }
  if (wsMatches.length > 1) return { ambiguous: wsMatches.map(p => p.workspaceId).sort() }
  return {}
}

export function resolveExplicitProjectTarget(
  target: string,
  projects: ProjectOverview[],
): { match?: { workspaceId: string; subdir?: string }; ambiguous?: string[] } {
  const unique = new Map<string, { workspaceId: string; subdir?: string }>()
  for (const p of projects) {
    const key = p.subdir ? `${p.workspaceId}\0${p.subdir}` : p.workspaceId
    if (!unique.has(key)) unique.set(key, { workspaceId: p.workspaceId, ...(p.subdir && { subdir: p.subdir }) })
  }
  const deduped = [...unique.values()]
  const trimmed = target.trim()
  if (!trimmed) return {}
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    const normalized = trimmed.replaceAll('\\', '/')
    const slash = normalized.indexOf('/')
    if (slash <= 0 || normalized.indexOf('/', slash + 1) !== -1) return {}
    const ws = normalized.slice(0, slash).toLowerCase()
    const sub = normalized.slice(slash + 1).toLowerCase()
    const exact = deduped.find(p => p.subdir && p.workspaceId.toLowerCase() === ws && p.subdir.toLowerCase() === sub)
    return exact ? { match: exact } : {}
  }
  const lower = trimmed.toLowerCase()
  const exactRoot = deduped.find(p => !p.subdir && p.workspaceId.toLowerCase() === lower)
  if (exactRoot) return { match: { workspaceId: exactRoot.workspaceId } }
  const subMatches = deduped.filter(p => p.subdir && p.subdir.toLowerCase() === lower)
  const firstSubMatch = subMatches[0]
  if (subMatches.length === 1 && firstSubMatch) return { match: firstSubMatch }
  if (subMatches.length > 1) return { ambiguous: subMatches.map(p => `${p.workspaceId}/${p.subdir}`).sort() }
  return {}
}

export function matchProjectFromText(text: string, projects: ProjectOverview[]): { workspaceId: string; subdir?: string } | undefined {
  return resolveProjectFromText(text, projects).match
}

export interface SmartRouteDecision {
  intent: 'quick_qa' | 'standard' | 'autopilot_candidate'
  recommendedAdapter?: AdapterId
  recommendedProfile?: Profile
}

const visualKeywords = /页面|样式|ui|界面|布局|截图|组件|弹窗|按钮|图标|动画|css|html|前端|视觉|预览|rendering/iu
const reviewKeywords = /为什么|是什么|架构|设计|方案|评估|审查|review|文档|总结|解释|排查原因/iu
const codeKeywords = /修复|修一下|实现|新增|开发|改造|重构|写个|单测|测试|bug|fix|feat|refactor|api|接口/iu
const multiStepKeywords = /全自动|自动交付|闭环|完整实现|从零搭建|做一个.*模块|重做|重构整个/iu

export function classifyAndRoute(
  text: string,
  allowedAdapters: AdapterId[],
  isOwner: boolean,
  opts: { autoSelectAdapter: boolean; proposeAutopilot: boolean },
): SmartRouteDecision {
  const trimmed = text.trim()
  const isQuestion = (/^(为什么|怎么|如何|解释|帮我看下|分析|查询|有哪些)/u.test(trimmed) || /[?？]$/u.test(trimmed)) &&
    !codeKeywords.test(trimmed)

  let intent: SmartRouteDecision['intent'] = 'standard'
  if (isQuestion) {
    intent = 'quick_qa'
  } else if (isOwner && opts.proposeAutopilot && (multiStepKeywords.test(trimmed) || (trimmed.length >= 60 && codeKeywords.test(trimmed)))) {
    intent = 'autopilot_candidate'
  }

  let recommendedAdapter: AdapterId | undefined
  if (opts.autoSelectAdapter && allowedAdapters.length) {
    const pick = (order: AdapterId[]) => order.find(a => allowedAdapters.includes(a))
    if (visualKeywords.test(trimmed)) recommendedAdapter = pick(['antigravity', 'claude-code', 'codex', ...allowedAdapters])
    else if (reviewKeywords.test(trimmed)) recommendedAdapter = pick(['claude-code', 'codex', 'antigravity', ...allowedAdapters])
    else if (codeKeywords.test(trimmed)) recommendedAdapter = pick(['codex', 'claude-code', 'antigravity', ...allowedAdapters])
  }

  return {
    intent,
    ...(recommendedAdapter && { recommendedAdapter }),
    ...(intent === 'quick_qa' && { recommendedProfile: 'readonly' as const }),
  }
}

export interface StoredProposal {
  id: string
  kind: 'autopilot' | 'briefing'
  chatId: string
  messageId: string | null
  actorOpenId: string
  payload: Record<string, unknown>
  status: string
  createdAt: number
  expiresAt: number
}

export function createProposal(
  db: Repos,
  input: { kind: 'autopilot' | 'briefing'; chatId: string; messageId?: string; actorOpenId: string; payload: unknown; ttlMs?: number; now: number },
): string {
  const id = 'prp_' + ulid(input.now)
  db.insert(feishuProposals).values({
    id,
    kind: input.kind,
    chatId: input.chatId,
    messageId: input.messageId ?? null,
    actorOpenId: input.actorOpenId,
    payloadJson: JSON.stringify(input.payload),
    status: 'pending',
    createdAt: input.now,
    expiresAt: input.now + (input.ttlMs ?? 15 * 60_000),
  }).run()
  return id
}

export function setProposalMessageId(db: Repos, id: string, messageId: string) {
  db.update(feishuProposals).set({ messageId }).where(eq(feishuProposals.id, id)).run()
}

function toStoredProposal(row: typeof feishuProposals.$inferSelect): StoredProposal {
  return {
    id: row.id,
    kind: row.kind as StoredProposal['kind'],
    chatId: row.chatId,
    messageId: row.messageId,
    actorOpenId: row.actorOpenId,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export function getProposalByMessageId(db: Repos, chatId: string, messageId: string): StoredProposal | undefined {
  const row = db.select().from(feishuProposals)
    .where(and(eq(feishuProposals.chatId, chatId), eq(feishuProposals.messageId, messageId))).get()
  return row ? toStoredProposal(row) : undefined
}

export function latestPendingProposal(
  db: Repos,
  chatId: string,
  now: number,
  threadId = '',
): { proposal?: StoredProposal; ambiguous?: boolean } {
  const rows = db.select().from(feishuProposals)
    .where(and(
      eq(feishuProposals.chatId, chatId),
      eq(feishuProposals.status, 'pending'),
      isNotNull(feishuProposals.messageId),
      gte(feishuProposals.expiresAt, now),
      sql`coalesce(json_extract(${feishuProposals.payloadJson}, '$.threadId'), '') = ${threadId}`,
    ))
    .orderBy(desc(feishuProposals.createdAt))
    .limit(2)
    .all()
  if (rows.length > 1) return { ambiguous: true }
  const first = rows[0]
  return first ? { proposal: toStoredProposal(first) } : {}
}

export function getProposal(db: Repos, id: string): StoredProposal | undefined {
  const row = db.select().from(feishuProposals).where(eq(feishuProposals.id, id)).get()
  return row ? toStoredProposal(row) : undefined
}

export function claimProposal(db: Repos, id: string, now: number, nextStatus = 'accepted'): 'claimed' | 'expired' | 'used' {
  const row = db.select().from(feishuProposals).where(eq(feishuProposals.id, id)).get()
  if (!row) return 'expired'
  if (row.status !== 'pending') return 'used'
  if (row.expiresAt < now) {
    db.update(feishuProposals).set({ status: 'expired' }).where(and(eq(feishuProposals.id, id), eq(feishuProposals.status, 'pending'))).run()
    return 'expired'
  }
  const changed = db.update(feishuProposals).set({ status: nextStatus })
    .where(and(eq(feishuProposals.id, id), eq(feishuProposals.status, 'pending'))).run().changes
  return changed ? 'claimed' : 'used'
}

export function releaseProposal(db: Repos, id: string) {
  db.update(feishuProposals).set({ status: 'pending' })
    .where(and(eq(feishuProposals.id, id), eq(feishuProposals.status, 'accepted'))).run()
}
