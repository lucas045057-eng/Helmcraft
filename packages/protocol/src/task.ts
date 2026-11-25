import { z } from 'zod'
import { AdapterId, Profile } from './common.js'
import type { Actor, ErrorCode, ResultDeliveryStatus, RunId, TaskAction } from './common.js'
import type { ApprovalOverrides } from './dashboard/rest.js'
import type { TaskView } from './dashboard/dto.js'

export const TaskStatus = z.enum(['awaiting_approval', 'queued', 'dispatching', 'running', 'awaiting_input',
  'cancelling', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled'])
export const RunStatus = z.enum(['dispatching', 'running', 'awaiting_input', 'cancelling',
  'succeeded', 'failed', 'timed_out', 'cancelled', 'refused', 'lost'])
export const TaskEventType = z.enum(["SUBMIT","APPROVE","REJECT","APPROVAL_EXPIRE","DISPATCH","RUN_ACCEPTED","RUN_REFUSED","DISPATCH_LOST","INPUT_REQUEST","INPUT_PROVIDE","INPUT_EXPIRE","CANCEL","RUN_SUCCEEDED","RUN_FAILED","RUN_TIMED_OUT","RUN_CANCELLED","RUN_LOST","RETRY"])
export const PolicyDecision = z.enum(['auto_approve', 'require_approval', 'deny'])
export const PolicyRule = z.strictObject({
  id: z.string(), name: z.string(), priority: z.number(), enabled: z.boolean(),
  match: z.strictObject({
    actorType: z.array(z.enum(['owner', 'requester'])).optional(),
    actorIds: z.array(z.string()).optional(),
    source: z.array(z.enum(['feishu', 'dashboard', 'api'])).optional(),
    chatIds: z.array(z.string()).optional(), workspaceIds: z.array(z.string()).optional(),
    adapters: z.array(z.string()).optional(), profiles: z.array(Profile).optional(),
    promptPattern: z.string().max(256).refine((pattern) => {
      try { new RegExp(pattern, 'i'); return true } catch { return false }
    }).optional(),
  }),
  effect: z.strictObject({
    decision: PolicyDecision, clampProfile: Profile.optional(), approvalTimeoutMs: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(), autoRetryOnWorkerLost: z.boolean().optional(),
    requesterCanRetry: z.boolean().optional(), requesterCanCancelRunning: z.boolean().optional(),
  }),
})

export type TaskStatus = z.infer<typeof TaskStatus>
export type RunStatus = z.infer<typeof RunStatus>
export type TaskEventType = z.infer<typeof TaskEventType>
export type PolicyDecision = z.infer<typeof PolicyDecision>
export type PolicyRule = z.infer<typeof PolicyRule>

export interface TaskState {
  id: string
  status: TaskStatus
  version: number
  requester: Actor
  profile: Profile
  attemptCount: number
  maxAttempts: number
  runSeq: number
  currentRunId: RunId | null
  updatedAt: number
  errorCode?: string | null
  resultDeliveryStatus?: ResultDeliveryStatus
  requesterCanRetry?: boolean
  requesterCanCancelRunning?: boolean
  autoRetryOnWorkerLost?: boolean
  liveInput?: boolean
  inputRequestId?: string | null
}

export type TaskTransition = {
  task: TaskView
  from: TaskStatus | null
  to: TaskStatus
  event: TaskEventType
  actor: Actor
  runId?: RunId
  reason?: string
}

type EventBase = { actor: Actor; expectedVersion?: number }
export type TaskEvent = EventBase & (
  | { type: 'SUBMIT'; decision: PolicyDecision; task: Omit<TaskState, 'status' | 'version' | 'updatedAt' | 'attemptCount' | 'runSeq' | 'currentRunId'> }
  | { type: 'APPROVE'; overrides?: ApprovalOverrides }
  | { type: 'RETRY'; decision?: PolicyDecision; overrides?: ApprovalOverrides; force?: boolean }
  | { type: 'REJECT' | 'CANCEL'; reason?: string }
  | { type: 'APPROVAL_EXPIRE' }
  | { type: 'DISPATCH'; workerId: string; adapter: AdapterId; workspaceId: string }
  | { type: 'INPUT_REQUEST'; runId: RunId; requestId: string; question: string; options?: string[] }
  | { type: 'INPUT_PROVIDE'; requestId: string; answer: string }
  | { type: 'INPUT_EXPIRE'; runId: RunId }
  | { type: 'RUN_ACCEPTED' | 'RUN_REFUSED' | 'DISPATCH_LOST' | 'RUN_LOST'; runId: RunId }
  | { type: 'RUN_SUCCEEDED' | 'RUN_FAILED' | 'RUN_TIMED_OUT' | 'RUN_CANCELLED'; runId: RunId; errorCode?: string }
)

export interface ReduceContext {
  now: number
  newRunId?: RunId
  validateOverrides?: (overrides: ApprovalOverrides, task: TaskState) => ErrorCode | undefined
}

export type TaskWrite =
  | { type: 'run.create'; runId: RunId; runSeq: number; attempt: number; workerId: string; adapter: AdapterId; workspaceId: string; profile: Profile }
  | { type: 'run.update'; runId: RunId; status: RunStatus }
  | { type: 'input.open'; requestId: string; runId: RunId; question: string; options?: string[] }
  | { type: 'input.close'; requestId: string; answer?: string }
  | { type: 'task.overrides'; overrides: ApprovalOverrides }

export type TaskEffect =
  | { type: 'audit.noop'; event: TaskEventType; actor: Actor }
  | { type: 'metric.stale_run_event'; runId: RunId }
  | { type: 'transition'; next: TaskState; from: TaskStatus | null; event: TaskEventType; actor: Actor; reason?: string; implicitAccept?: true; override?: true }
  | { type: 'dispatch'; runId: RunId }
  | { type: 'cancel'; runId: RunId; reason: 'user' | 'input_timeout' }
  | { type: 'input'; runId: RunId; requestId: string; answer: string }
  | { type: 'timer'; timer: 'approval' | 'dispatch' | 'run' | 'input' | 'cancel'; action: 'start' | 'clear' }

export type ReduceResult =
  | { next: TaskState; effects: TaskEffect[]; writes: TaskWrite[] }
  | { error: { code: ErrorCode; status: number; details?: Record<string, unknown> } }

type Cell = TaskStatus | '=' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
export const TRANSITIONS: Readonly<Record<TaskStatus | 'missing', Readonly<Partial<Record<TaskEventType, Cell>>>>> = {
  missing: { SUBMIT: 'A' },
  awaiting_approval: { APPROVE: 'queued', REJECT: 'rejected', APPROVAL_EXPIRE: 'cancelled', CANCEL: 'cancelled' },
  queued: { DISPATCH: 'dispatching', CANCEL: 'cancelled' },
  dispatching: { RUN_ACCEPTED: 'running', RUN_REFUSED: 'queued', DISPATCH_LOST: 'B', INPUT_REQUEST: 'C', CANCEL: 'cancelling', RUN_SUCCEEDED: 'C', RUN_FAILED: 'C', RUN_TIMED_OUT: 'C', RUN_CANCELLED: 'C' },
  running: { RUN_ACCEPTED: '=', INPUT_REQUEST: 'awaiting_input', CANCEL: 'cancelling', RUN_SUCCEEDED: 'succeeded', RUN_FAILED: 'failed', RUN_TIMED_OUT: 'timed_out', RUN_CANCELLED: 'cancelled', RUN_LOST: 'D' },
  awaiting_input: { RUN_ACCEPTED: '=', INPUT_REQUEST: '=', INPUT_PROVIDE: 'running', INPUT_EXPIRE: 'cancelling', CANCEL: 'cancelling', RUN_SUCCEEDED: 'succeeded', RUN_FAILED: 'failed', RUN_TIMED_OUT: 'timed_out', RUN_CANCELLED: 'cancelled', RUN_LOST: 'D' },
  cancelling: { RUN_ACCEPTED: '=', RUN_REFUSED: 'E', DISPATCH_LOST: 'E', INPUT_REQUEST: '=', INPUT_EXPIRE: '=', CANCEL: '=', RUN_SUCCEEDED: 'succeeded', RUN_FAILED: 'cancelled', RUN_TIMED_OUT: 'cancelled', RUN_CANCELLED: 'cancelled', RUN_LOST: 'cancelled' },
  succeeded: {},
  rejected: {},
  failed: { RETRY: 'F' },
  timed_out: { RETRY: 'F' },
  cancelled: { CANCEL: '=', RETRY: 'F' },
}

const initialStatus: Record<PolicyDecision, TaskStatus> = {
  auto_approve: 'queued', require_approval: 'awaiting_approval', deny: 'rejected',
}
const stateTimer: Partial<Record<TaskStatus, Extract<TaskEffect, { type: 'timer' }>['timer']>> = {
  awaiting_approval: 'approval', dispatching: 'dispatch', running: 'run',
  awaiting_input: 'input', cancelling: 'cancel',
}
const workerEvents = new Set<TaskEventType>([
  'RUN_ACCEPTED', 'RUN_REFUSED', 'INPUT_REQUEST', 'RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_TIMED_OUT', 'RUN_CANCELLED',
])
const systemEvents = new Set<TaskEventType>(['DISPATCH', 'APPROVAL_EXPIRE', 'INPUT_EXPIRE', 'DISPATCH_LOST', 'RUN_LOST'])
const completed = new Set<TaskStatus>(['succeeded', 'failed', 'timed_out', 'cancelled'])
const finishEvents: Readonly<Partial<Record<TaskEventType, RunStatus>>> = {
  RUN_SUCCEEDED: 'succeeded', RUN_FAILED: 'failed', RUN_TIMED_OUT: 'timed_out', RUN_CANCELLED: 'cancelled',
}

function canAct(task: TaskState | undefined, type: TaskEventType, actor: Actor): boolean {
  if (workerEvents.has(type)) return actor.type === 'worker'
  if (systemEvents.has(type)) return actor.type === 'system'
  if (type === 'SUBMIT') return actor.type === 'owner' || actor.type === 'requester'
  if (actor.type === 'owner') return true
  if (actor.type === 'system') return type === 'CANCEL' || type === 'RETRY'
  if (!task || actor.type !== 'requester' || task.requester.type !== 'requester' || task.requester.id !== actor.id) return false
  switch (type) {
    case 'INPUT_PROVIDE': return true
    case 'RETRY': return task.requesterCanRetry === true
    case 'CANCEL': return task.status === 'awaiting_approval' || task.status === 'queued'
      || (task.status === 'running' && task.requesterCanCancelRunning !== false)
    default: return false
  }
}

function failure(code: ErrorCode, status: number, details?: Record<string, unknown>): ReduceResult {
  return { error: { code, status, ...(details && { details }) } }
}

function invalid(task: TaskState | undefined, event: TaskEvent): ReduceResult {
  return failure('INVALID_TRANSITION', 409, { from: task?.status ?? null, event: event.type })
}

function advance(task: TaskState, status: TaskStatus, now: number): TaskState {
  return { ...task, status, version: task.version + 1, updatedAt: now }
}

function transitionEffects(task: TaskState, next: TaskState, event: TaskEvent, flags?: { implicitAccept?: true; override?: true }): TaskEffect[] {
  const effects: TaskEffect[] = []
  const previous = stateTimer[task.status]
  const following = stateTimer[next.status]
  // The run backstop spans input waits. It is cleared only when leaving execution.
  const runningToInput = task.status === 'running' && next.status === 'awaiting_input'
  const inputToRunning = task.status === 'awaiting_input' && next.status === 'running'
  if (previous && !runningToInput) effects.push({ type: 'timer', timer: previous, action: 'clear' })
  if (task.status === 'awaiting_input' && !inputToRunning) effects.push({ type: 'timer', timer: 'run', action: 'clear' })
  if (following && !inputToRunning) effects.push({ type: 'timer', timer: following, action: 'start' })
  effects.push({
    type: 'transition', from: task.status, next, event: event.type, actor: event.actor, ...flags,
    ...('reason' in event && event.reason !== undefined && { reason: event.reason }),
  })
  return effects
}

export function reduce(task: TaskState | null | undefined, event: TaskEvent, ctx: ReduceContext): ReduceResult {
  if (!task) {
    if (event.type !== 'SUBMIT') return failure('TASK_NOT_FOUND', 404)
    if (!canAct(undefined, event.type, event.actor)) return failure('FORBIDDEN', 403)
    const status = initialStatus[event.decision]
    const next: TaskState = {
      ...event.task, status, version: 1, updatedAt: ctx.now, attemptCount: 0, runSeq: 0, currentRunId: null,
      errorCode: event.decision === 'deny' ? 'POLICY_DENIED' : null,
    }
    const effects: TaskEffect[] = [{ type: 'transition', next, from: null, event: event.type, actor: event.actor }]
    if (status === 'awaiting_approval') effects.push({ type: 'timer', timer: 'approval', action: 'start' })
    return { next, effects, writes: [] }
  }

  if (event.expectedVersion !== undefined && event.expectedVersion !== task.version) {
    return failure('VERSION_CONFLICT', 409, { current: task })
  }
  const cell = TRANSITIONS[task.status][event.type]
  if (!cell) return invalid(task, event)
  if (!canAct(task, event.type, event.actor)) return failure('FORBIDDEN', 403)
  if (cell === '=') return { next: task, writes: [], effects: [{ type: 'audit.noop', event: event.type, actor: event.actor }] }
  if ('runId' in event && event.runId !== task.currentRunId) {
    return { next: task, writes: [], effects: [{ type: 'metric.stale_run_event', runId: event.runId }] }
  }
  if (event.type === 'INPUT_REQUEST' && task.liveInput !== true) return invalid(task, event)
  if (event.type === 'INPUT_PROVIDE' && task.inputRequestId !== event.requestId) {
    return failure('INPUT_REQUEST_CLOSED', 409)
  }
  if ('overrides' in event && event.overrides) {
    const profile = event.overrides.profile
    if (profile && !Profile.safeParse(profile).success) return failure('PROFILE_NOT_ALLOWED', 422)
    if (event.overrides.adapter && !AdapterId.safeParse(event.overrides.adapter).success) return failure('UNKNOWN_ADAPTER', 422)
    const error = ctx.validateOverrides?.(event.overrides, task)
    if (error) return failure(error, 422)
  }

  if (cell === 'C' && 'runId' in event) {
    const accepted: TaskEvent = { type: 'RUN_ACCEPTED', actor: event.actor, runId: event.runId }
    const first = reduce(task, accepted, ctx)
    if ('error' in first) return first
    const second = reduce(first.next, { ...event, expectedVersion: first.next.version }, ctx)
    if ('error' in second) return second
    return {
      next: second.next,
      writes: [...first.writes, ...second.writes],
      effects: [
        ...first.effects.map((effect): TaskEffect => effect.type === 'transition' ? { ...effect, implicitAccept: true } : effect),
        ...second.effects,
      ],
    }
  }

  let status: TaskStatus
  const attemptAvailable = task.attemptCount < task.maxAttempts
  let override: true | undefined
  switch (cell) {
    case 'B': status = attemptAvailable ? 'queued' : 'failed'; break
    case 'D': status = task.autoRetryOnWorkerLost && task.profile === 'readonly' && attemptAvailable ? 'queued' : 'failed'; break
    case 'E': status = 'cancelled'; break
    case 'F':
      if (!attemptAvailable && event.actor.type !== 'owner') return failure('MAX_ATTEMPTS_REACHED', 409)
      override = attemptAvailable ? undefined : true
      if (event.actor.type === 'requester' && event.type === 'RETRY') {
        if (event.decision === 'deny') return failure('FORBIDDEN', 403, { reason: 'POLICY_DENIED' })
        status = event.decision === 'auto_approve' ? 'queued' : 'awaiting_approval'
      } else {
        status = 'queued'
      }
      break
    case 'A':
    case 'C': return invalid(task, event)
    default: status = cell
  }

  const next = advance(task, status, ctx.now)
  const writes: TaskWrite[] = []
  const effects: TaskEffect[] = []
  let runStatus: RunStatus | undefined
  if ('overrides' in event && event.overrides) {
    writes.push({ type: 'task.overrides', overrides: event.overrides })
    if (event.overrides.profile) next.profile = event.overrides.profile
  }
  switch (event.type) {
    case 'DISPATCH': {
      const runId = ctx.newRunId
      if (!runId) return failure('INTERNAL', 500, { reason: 'newRunId is required' })
      next.currentRunId = runId
      next.runSeq++
      next.attemptCount++
      writes.push({ type: 'run.create', runId, runSeq: next.runSeq, attempt: next.attemptCount,
        workerId: event.workerId, adapter: event.adapter, workspaceId: event.workspaceId, profile: next.profile })
      effects.push({ type: 'dispatch', runId })
      break
    }
    case 'RUN_ACCEPTED': runStatus = 'running'; break
    case 'RUN_REFUSED':
      runStatus = 'refused'
      next.attemptCount--
      break
    case 'DISPATCH_LOST':
    case 'RUN_LOST':
      runStatus = 'lost'
      if (status === 'failed') next.errorCode = 'WORKER_LOST'
      break
    case 'INPUT_REQUEST': {
      const { requestId, runId, question, options } = event
      next.inputRequestId = requestId
      writes.push({ type: 'input.open', requestId, runId, question, ...(options !== undefined && { options }) })
      runStatus = 'awaiting_input'
      break
    }
    case 'INPUT_PROVIDE':
      if (task.currentRunId) effects.push({ type: 'input', runId: task.currentRunId, requestId: event.requestId, answer: event.answer })
      runStatus = 'running'
      break
    case 'CANCEL':
    case 'INPUT_EXPIRE':
      if (status === 'cancelling' && task.currentRunId) {
        runStatus = 'cancelling'
        effects.push({ type: 'cancel', runId: task.currentRunId, reason: event.type === 'INPUT_EXPIRE' ? 'input_timeout' : 'user' })
      }
      break
    case 'RETRY':
      next.errorCode = null
      next.resultDeliveryStatus = 'not_required'
      break
    default:
      runStatus = finishEvents[event.type]
      if ('errorCode' in event && event.errorCode !== undefined) next.errorCode = event.errorCode
      break
  }
  if (task.status === 'awaiting_input' && task.inputRequestId) {
    writes.push({ type: 'input.close', requestId: task.inputRequestId,
      ...(event.type === 'INPUT_PROVIDE' && { answer: event.answer }) })
    next.inputRequestId = null
  }
  if (task.currentRunId && runStatus) writes.push({ type: 'run.update', runId: task.currentRunId, status: runStatus })
  if (completed.has(status) || status === 'queued') next.currentRunId = null
  effects.push(...transitionEffects(task, next, event, override ? { override } : undefined))
  return { next, writes, effects }
}

export function allowedActions(task: TaskState, actor: Actor): TaskAction[] {
  const result: TaskAction[] = []
  const actions = { approve: 'APPROVE', reject: 'REJECT', cancel: 'CANCEL', retry: 'RETRY', input: 'INPUT_PROVIDE' } as const
  for (const [action, event] of Object.entries(actions) as [keyof typeof actions, typeof actions[keyof typeof actions]][]) {
    const cell = TRANSITIONS[task.status][event]
    if (!cell || cell === '=' || !canAct(task, event, actor)) continue
    if (event === 'RETRY' && task.attemptCount >= task.maxAttempts && actor.type !== 'owner') continue
    if (event === 'INPUT_PROVIDE' && !task.inputRequestId) continue
    result.push(action)
  }
  if (completed.has(task.status) && (actor.type === 'owner'
      || (actor.type === 'requester' && task.requester.type === 'requester' && task.requester.id === actor.id))) result.push('followup')
  if (actor.type === 'owner' && task.status === 'succeeded' && task.resultDeliveryStatus === 'pending_review') result.push('deliver_result')
  return result
}
