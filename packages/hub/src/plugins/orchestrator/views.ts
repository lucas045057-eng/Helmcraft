import { and, eq } from 'drizzle-orm'
import { harnessSummary } from './harness.js'
import { allowedActions } from '@agent-hub/protocol'
import { redact } from '@agent-hub/common'
import type { Actor, RunView, TaskState, TaskDetailView, TaskView, TaskOrigin, WorkerView } from '@agent-hub/protocol'
import type { PolicyOutcome } from '../../services/policy.js'
import type { Repos, RunRow, TaskRow } from '../../services/store.js'
import { auditLogs, tasks } from '../store-sqlite/schema.js'

export const owner: Actor = { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' }
export const system: Actor = { type: 'system', id: 'hub', channel: 'system' }
export const findTask = (db: Repos, ref: string) => /^#?\d+$/.test(ref) ? db.tasks.getByNo(Number(ref.replace('#', ''))) : db.tasks.get(ref)
export const findRun = (db: Repos, id: string) => db.runs.get(id)
export const findInput = (db: Repos, id: string) => db.inputs.openFor(id)
export const taskRunsFor = (db: Repos, id: string) => db.runs.forTask(id)

export function taskState(db: Repos, task: TaskRow): TaskState {
  const run = task.currentRunId ? findRun(db, task.currentRunId) : undefined
  const policy = task.policyDecisionJson as PolicyOutcome
  const worker = run && db.workers.get(run.workerId)
  return { id: task.id, status: task.status, version: task.version, profile: task.profile,
    requester: { id: task.requesterId, type: task.requesterType, channel: task.source }, attemptCount: task.attemptCount,
    maxAttempts: task.maxAttempts, runSeq: task.runSeq, currentRunId: task.currentRunId, updatedAt: task.updatedAt,
    errorCode: task.errorCode, resultDeliveryStatus: task.resultDeliveryStatus,
    requesterCanRetry: policy.requesterCanRetry ?? false, requesterCanCancelRunning: policy.requesterCanCancelRunning ?? true,
    ...(policy.autoRetryOnWorkerLost !== undefined && { autoRetryOnWorkerLost: policy.autoRetryOnWorkerLost }),
    liveInput: (worker?.capabilitiesJson as WorkerView['adapters'] | undefined)?.some(a => a.id === run?.adapter && a.features.liveInput) ?? false,
    inputRequestId: task.status === 'awaiting_input' ? findInput(db, task.id)?.id ?? null : null,
  }
}

export function runView(run: RunRow, db?: Repos): RunView {
  const harness = harnessSummary(run, db)
  const usage = run.usageJson as RunView['usage']
  return { ...(harness && { harness }), id: run.id, taskId: run.taskId, attempt: run.attempt, workerId: run.workerId, adapter: run.adapter,
    workspaceId: run.workspaceId, profile: run.profile, status: run.status, pid: run.pid, cliVersion: run.cliVersion,
    cliSessionId: run.cliSessionId, exitCode: run.exitCode, errorCode: run.errorCode, errorMessage: run.errorMessage,
    summary: run.summary, usage: usage && { ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }), ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }) },
    lastSeq: run.lastSeq, logBytes: run.logBytes, logDroppedBytes: run.logDroppedBytes,
    dispatchedAt: run.dispatchedAt, startedAt: run.startedAt, finishedAt: run.finishedAt }
}

export function taskView(db: Repos, task: TaskRow, worker: WorkerView | undefined, actor: Actor = owner, latest?: RunRow, allowRequesterCommands = false): TaskView {
  const state = taskState(db, task)
  return { ...(latest?.verificationStatus && { verification: latest.verificationStatus }), id: task.id, taskNo: task.taskNo, version: task.version, title: task.title, status: task.status,
    priority: task.priority, requester: { ...state.requester, ...(task.requesterName && { name: task.requesterName }) },
    origin: task.originJson as TaskOrigin, adapter: task.adapter ?? latest?.adapter ?? null,
    workspaceId: task.workspaceId, profile: task.profile, workerId: latest?.workerId ?? null, attempt: task.attemptCount,
    maxAttempts: task.maxAttempts, parentTaskId: task.parentTaskId, lastProgress: task.lastProgress, scheduleHint: task.scheduleHint,
    workerConnection: worker?.connection ?? null, graceUntil: task.currentRunId ? worker?.graceUntil ?? null : null,
    errorCode: task.errorCode, resultDeliveryStatus: task.resultDeliveryStatus, createdAt: task.createdAt, updatedAt: task.updatedAt,
    startedAt: task.startedAt, finishedAt: task.finishedAt, allowedActions: allowedActions(state, actor, allowRequesterCommands) }
}
export function taskDetail(db: Repos, task: TaskRow, getWorker: (id: string) => WorkerView | undefined, actor: Actor, allowRequesterCommands = false): TaskDetailView {
  const runs = taskRunsFor(db, task.id)
  const view = taskView(db, task, runs[0] && getWorker(runs[0].workerId), actor, runs[0], allowRequesterCommands)
  const input = findInput(db, task.id)
  const policy = task.policyDecisionJson as PolicyOutcome
  const base = task.handoffFromRunId ? db.runs.get(task.handoffFromRunId) : undefined
  return { ...view, ...(base && { handoff: { fromRunId: base.id, fromTaskId: base.taskId,
    fromTaskNo: db.tasks.get(base.taskId)!.taskNo, intent: task.harnessRequestJson?.intent ?? 'relay' } }), prompt: redact(task.prompt), resultSummary: task.resultSummary,
    runs: runs.map(run => runView(run, db)),
    inputRequest: input ? { requestId: input.id, question: input.question,
      ...(Array.isArray(input.optionsJson) && { options: input.optionsJson as string[] }), expiresAt: input.expiresAt } : null,
    policyDecision: { ruleId: policy.ruleId, decision: policy.decision, ...(policy.clampedProfile && { clampedProfile: policy.clampedProfile }) },
    timeline: db.select().from(auditLogs).where(and(eq(auditLogs.targetId, task.id), eq(auditLogs.targetType, 'task'))).orderBy(auditLogs.id)
      .all().map(row => {
        const details = row.detailJson as { before?: string; after?: string; override?: boolean } | null
        const note = details?.after !== undefined ? 'Prompt 覆写 · ' + (details.before ?? '') + ' → ' + details.after
          : details?.override ? '应用审批覆写' : undefined
        return { ts: row.ts, event: row.action, from: row.fromStatus, to: row.toStatus,
          actor: { id: row.actorId, type: row.actorType, channel: row.channel }, ...(note && { note }) }
      }),
    children: db.select({ id: tasks.id, taskNo: tasks.taskNo, status: tasks.status }).from(tasks).where(eq(tasks.parentTaskId, task.id)).all(),
  }
}
