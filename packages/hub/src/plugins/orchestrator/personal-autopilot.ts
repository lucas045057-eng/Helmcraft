import type { Context } from 'cordis'
import { projectOf, suggestMethods, renderMethodBlock } from '@agent-hub/protocol'
import type { Actor, AutopilotPreflightRequest, AutopilotPreflightResponse, AutopilotStartRequest, BoardSnapshot, MethodCard, TaskDetailView, TaskOrigin } from '@agent-hub/protocol'
import { ulid } from '@agent-hub/common'
import type { Orchestrator } from '../../services/orchestrator.js'
import { HubError } from '../../services/errors.js'
import { listMethods } from './methods.js'

function pickWorker(ctx: Context, input: { workerId?: string | undefined; workspaceId: string }) {
  const workers = ctx.workers.list()
  if (input.workerId) {
    const w = workers.find(item => item.id === input.workerId)
    if (!w) throw new HubError('WORKER_NOT_FOUND', 404)
    if (w.connection !== 'online') throw new HubError('WORKER_OFFLINE', 409)
    return w
  }
  const candidates = workers.filter(w => w.workspaces.some(ws => ws.id === input.workspaceId))
  if (!candidates.length) throw new HubError('UNKNOWN_WORKSPACE', 400)
  const online = candidates.find(w => w.connection === 'online')
  if (!online) throw new HubError('WORKER_OFFLINE', 409)
  return online
}

export async function requestPreflight(ctx: Context, input: AutopilotPreflightRequest): Promise<AutopilotPreflightResponse> {
  const worker = pickWorker(ctx, input)
  if (!ctx.workers.capabilities(worker.id).includes('preflight.v1')) {
    return {
      ok: false,
      workerId: worker.id,
      checks: [],
      error: '该 Worker 版本不支持在线预检（缺少 preflight.v1 能力），请升级 Worker',
    }
  }
  const ts = ctx.clock.now()
  const ack = await ctx.workers.send(worker.id, {
    v: 1,
    id: ulid(ts),
    ts,
    type: 'project.preflight',
    payload: {
      workspaceId: input.workspaceId,
      mode: input.mode,
      ...(input.subdir && { subdir: input.subdir }),
      ...(input.autoCommit !== undefined && { autoCommit: input.autoCommit }),
      ...(input.autoPush !== undefined && { autoPush: input.autoPush }),
    },
  })
  if (!ack.ok) {
    return {
      ok: false,
      workerId: worker.id,
      checks: [],
      error: ack.error?.message ?? '预检命令执行失败',
    }
  }
  const res = ack.result?.preflight
  if (!res) {
    return { ok: false, workerId: worker.id, checks: [], error: 'Worker 未返回预检结果（请升级 Worker）' }
  }
  return {
    ok: res.ok,
    workerId: worker.id,
    checks: res.checks ?? [],
    ...(res.binding && { binding: res.binding }),
    ...(res.noChecks && { noChecks: res.noChecks }),
    ...(res.error && { error: res.error }),
  }
}

function summarizeBoard(snapshot: BoardSnapshot | undefined): string | undefined {
  if (!snapshot || snapshot.dir !== 'present') return undefined
  const parts: string[] = []
  for (const file of snapshot.files) {
    if (file.status === 'present' && file.content) {
      parts.push('### ' + file.file + '\n' + file.content.slice(0, 3000))
    }
  }
  return parts.length ? parts.join('\n\n').slice(0, 14_000) : undefined
}

function matchMethodBlock(ctx: Context, text: string): string | undefined {
  const cards = ctx.store.tx(db => listMethods(db)) as MethodCard[]
  const [top] = suggestMethods(text, cards, 1)
  if (!top) return undefined
  const card = cards.find(c => c.id === top.id)
  return card ? renderMethodBlock(card) : undefined
}

export async function startAutopilot(
  ctx: Context,
  orchestrator: Orchestrator,
  input: AutopilotStartRequest,
  actor: Actor,
  origin?: TaskOrigin,
): Promise<{ projectId: string; task: TaskDetailView }> {
  const pre = await requestPreflight(ctx, {
    ...(input.workerId && { workerId: input.workerId }),
    workspaceId: input.workspaceId,
    ...(input.subdir && { subdir: input.subdir }),
    mode: 'flexible',
    autoCommit: input.autoCommit,
    autoPush: input.autoPush,
  })
  if (!pre.ok || !pre.binding) {
    throw new HubError('INVALID_TRANSITION', 409, { reason: 'PREFLIGHT_FAILED', error: pre.error ?? '在线预检未通过' })
  }
  const now = ctx.clock.now()
  const projectKey = projectOf(input.subdir)
  const slug = (projectKey ?? input.workspaceId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'proj'
  const projectId = input.projectId ?? (slug + '_' + ulid(now).slice(-8))
  const goalText = input.inlinePrompt ?? ('按需求文档规划执行：' + (input.sources ?? []).join(', '))
  const boardSnapshot = input.boardSync
    ? ctx.store.repos.snapshots.latestForWorkspace(pre.workerId, input.workspaceId, projectKey)?.snapshot as BoardSnapshot | undefined
    : undefined
  const boardContext = summarizeBoard(boardSnapshot)
  const methodBlock = matchMethodBlock(ctx, goalText)
  const mainAdapter = pre.binding.adapters?.main ?? 'codex'
  const task = await orchestrator.createTask({
    prompt: '自动交付规划 [' + (projectKey ?? input.workspaceId) + ']：' + goalText.slice(0, 200),
    workspaceId: input.workspaceId,
    ...(input.subdir && { subdir: input.subdir }),
    requiredWorkerId: pre.workerId,
    adapter: mainAdapter,
    profile: 'readonly',
    timeoutMs: 30 * 60_000,
    ...(origin && { origin }),
  }, actor, {
    personalPlan: {
      projectId,
      binding: pre.binding,
      sources: input.sources?.length ? input.sources : ['INLINE_GOAL.md'],
      ...(input.inlinePrompt && { inlinePrompt: input.inlinePrompt }),
      ...(boardContext && { boardContext }),
      ...(methodBlock && { methodBlock }),
      ...(pre.noChecks && { noChecks: true as const }),
      ...(input.notifyFeishuChatId && { notifyFeishuChatId: input.notifyFeishuChatId }),
    },
  })
  return { projectId, task }
}
