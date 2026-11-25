import { allowedActions, BOARD_FILES, composeHarnessPrompt, HANDOFF_DEFAULT_PROMPTS, PREVIEW_NONCE, renderFactsJson } from '@agent-hub/protocol'
import type { Actor, AdapterId, HandoffPreview, HandoffPreviewQuery, WorkerView } from '@agent-hub/protocol'
import { runId } from '@agent-hub/common'
import type { Repos, TaskRow } from '../../services/store.js'
import { HubError } from '../../services/errors.js'
import { buildVerifiedFacts, harnessView } from './harness.js'
import { taskState } from './views.js'

export function handoffSource(db: Repos, task: TaskRow, actor: Actor, query: HandoffPreviewQuery, getWorker: (id: string) => WorkerView | undefined) {
  if (actor.type !== 'owner') throw new HubError('FORBIDDEN', 403)
  if (!allowedActions(taskState(db, task), actor).includes('followup')) throw new HubError('INVALID_TRANSITION', 409)
  const from = query.fromRunId ? db.runs.get(query.fromRunId) : db.runs.forTask(task.id).find(r => r.startedAt !== null && r.finishedAt !== null)
  if (query.fromRunId && from?.taskId !== task.id) throw new HubError('RUN_NOT_FOUND', 404)
  if (!from || from.finishedAt === null || from.startedAt === null) throw new HubError('INVALID_TRANSITION', 409, { reason: 'NO_STARTED_RUN' })
  const worker = getWorker(from.workerId)
  const intent = query.intent ?? 'relay'
  const adapter = query.adapter ?? (intent === 'fix' ? from.adapter as AdapterId : undefined)
  const resume = intent === 'fix' && adapter === from.adapter && !!from.cliSessionId && !!worker?.adapters.find(a => a.id === adapter)?.features.resume
  return { from, adapter, resume, intent, worker }
}

export function preview(db: Repos, task: TaskRow, source: ReturnType<typeof handoffSource>, now: number, order: AdapterId[], boardEnabled: boolean): HandoffPreview {
  const { from, worker, adapter, resume, intent } = source
  const ready = worker?.adapters.filter(a => a.status === 'ready' && worker.workspaces.find(w => w.id === from.workspaceId)?.allowedAdapters.includes(a.id))
  const target = adapter ?? [...(task.adapterPrefsJson ?? []), ...order].find(id => ready?.some(a => a.id === id)) as AdapterId | undefined
  const facts = buildVerifiedFacts(db, { ...task, requesterType: 'owner', handoffFromRunId: from.id, harnessRequestJson: { v: 1, intent } },
    { id: runId(now), workspaceId: from.workspaceId, workerId: from.workerId, adapter: target ?? from.adapter as AdapterId }, now)
  if (!facts) throw new HubError('INVALID_TRANSITION', 409, { reason: 'FACTS_TOO_LARGE' })
  const snapshots = harnessView(db, from).board
  const board = snapshots.post ?? snapshots.pre
  const warnings: HandoffPreview['warnings'] = []
  if (worker?.connection !== 'online') warnings.push('WORKER_OFFLINE')
  if (!worker?.protocolCapabilities?.includes('blackboard.v1')) warnings.push('WORKER_NO_BLACKBOARD')
  if (!ready?.some(a => a.id === target)) warnings.push('ADAPTER_NOT_READY')
  if (facts.continuity) warnings.push(facts.continuity.interleavedUnknown ? 'INTERLEAVED_UNKNOWN' : 'INTERLEAVED')
  if (!board || board.dir !== 'present' || !board.files.some(f => f.content !== undefined)) warnings.push('BOARD_UNAVAILABLE')
  const prefix = '../'.repeat(task.subdir?.split('/').filter(s => s && s !== '.').length ?? 0)
  const boardDir = board?.dir ?? 'absent'
  const agentsMd = board?.agentsMd.status ?? 'absent'
  const promptPreview = composeHarnessPrompt({ adapter: facts.currentRun.adapter, nonce: PREVIEW_NONCE, userPrompt: HANDOFF_DEFAULT_PROMPTS[intent],
    mode: resume ? 'resume' : 'handoff', trust: 'owner', board: !boardEnabled ? 'off' : task.profile === 'readonly' ? 'read' : 'write',
    bootstrap: boardEnabled && task.profile !== 'readonly' && !resume && board?.dir === 'absent', boardDir, agentsMd,
    paths: { board: prefix + '.board', agents: prefix + 'AGENTS.md' }, verifyCommandIds: [],
    factsJson: renderFactsJson(facts, { capturedAt: board?.capturedAt ?? now, cwd: task.subdir ?? '.', agentsMd, board: { dir: boardDir,
      files: board?.files.map(f => ({ file: f.file, bytes: f.bytes, status: f.status, budget: BOARD_FILES[f.file].budgetBytes, overBudget: f.overBudget, schemaOk: f.schemaOk })) ?? [] } }),
    handoff: { fromRunId: from.id, fromTaskNo: task.taskNo, fromAdapter: from.adapter, intent },
    ...(facts.continuity && { continuity: { ...facts.continuity, interleavedUnknown: !!facts.continuity.interleavedUnknown } }),
    boardFiles: boardEnabled && !resume ? board?.files.flatMap(f => f.content === undefined ? [] : [{ file: f.file, content: f.content, bytes: f.bytes,
      overBudget: f.overBudget, truncated: !!f.truncated }]) ?? [] : [] }).text
  return { fromRunId: from.id, workerId: from.workerId, workspaceId: from.workspaceId, adapter: target ?? null, resume, facts, board, promptPreview, warnings }
}
