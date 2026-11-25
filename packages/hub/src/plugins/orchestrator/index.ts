import { Context, Service } from 'cordis'
import { z } from 'zod'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { KeyedMutex, redact, runId, stableHash, taskId, ulid } from '@agent-hub/common'
import { allowedActions, HANDOFF_DEFAULT_PROMPTS, stripBoardContent, CreateTaskRequest, personalRoleSettings, Profile, reduce } from '@agent-hub/protocol'
import type { AcceptRunRequest, HandoffPreviewQuery, Actor, AdapterId, ApprovalOverrides, CmdAckPayload, DeliverResultRequest, HubCommand, LogsQuery,
  RunDispatch, RunEventsFrame, RunGapFrame, TaskEvent, TaskEffect, TaskListQuery, WorkerHello } from '@agent-hub/protocol'
import type { HandoffInput, ApprovalOptions, CreateOptions, CreateTaskInput, Orchestrator, ReasonOptions, ResultSender, VersionOptions } from '../../services/orchestrator.js'
import type { Repos, RunRow, StoredEvent, TaskRow } from '../../services/store.js'
import type { PolicyOutcome } from '../../services/policy.js'
import type { WorkerInboundHandler } from '../../services/workers.js'
import { HubError } from '../../services/errors.js'
import { safeOn, guardAsync } from '../../kernel/safe.js'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'
import { auditLogs, idempotencyKeys, inputRequests, taskRuns, tasks, workers } from '../store-sqlite/schema.js'
import { activeRunStatuses } from '../../services/workers.js'
import { findInput, findRun, findTask, owner, runView, system, taskDetail, taskRunsFor, taskState, taskView } from './views.js'
import { selectWorker } from './scheduler.js'
import { TimerWheel } from './timer-wheel.js'
import { reconcileWorker } from './recovery.js'
import { listTasks, logs, overview } from './queries.js'

import type { HubConfig } from '../../config/schema.js'
import { applyVerifyEvent, finishVerification, applyHarnessEvent, harnessView, planHarness, policyFor, toWireDirective, verificationRecord } from './harness.js'
import type { HarnessRecord } from './harness.js'
import { acceptRun, autoAccept, observeAcceptance, pointerView, rollbackWriteRegistration } from './pointers.js'
import { handoffSource, preview } from './handoff.js'
import { existingPlan, findPlanningTask, recordPlanningTask, recordPlanResult } from './personal-plan.js'
import { beginImplementation, blockProject, executionStep, finishImplementation, managedTask, occupied, projectExecution } from './personal-execution.js'
import { beginGate, finishGate, gatePhases, personalDispatch, planAdvice, prepareGate, stepCanDispatch } from './personal-gates.js'
import { finishDelivery } from './personal-delivery.js'

type Effect = TaskEffect | { type: 'pointer.changed'; workerId: string; workspaceId: string } | { type: 'harness.updated' } | { type: 'verification.outcome'; status: 'passed' | 'failed' | 'unverified' | 'skipped' }
export interface OrchestratorConfig {
  harness: HubConfig['harness']
  scheduler: { tickMs: number; scanLimit: number; defaultAdapterOrder: AdapterId[]; refuseBackoffMs: number; unschedulableWarnMs: number }
  tasks: { defaultTimeoutMs: number; idleTimeoutMs: number; approvalTimeoutMs: number; inputTimeoutMs: number;
    cancelAckTimeoutMs: number; dispatchAckTimeoutMs: number; maxDispatchResends: number; maxAttempts: number; maxPromptChars: number }
  limits: { maxActivePerRequester: number; requesterTasksPerHour: number }
  requesterReplyPolicy: 'auto' | 'owner_review'
  timezone?: string
}
type CommandPayload<T> = T extends HubCommand ? Pick<T, 'type' | 'payload'> : never
type Command = CommandPayload<HubCommand>
const finishedType = { succeeded: 'RUN_SUCCEEDED', failed: 'RUN_FAILED', timed_out: 'RUN_TIMED_OUT', cancelled: 'RUN_CANCELLED' } as const
const workerActor = (id: string): Actor => ({ id, channel: 'system', type: 'worker' })
const version = (opts: VersionOptions) => opts.expectedVersion === undefined ? {} : { expectedVersion: opts.expectedVersion }

export class OrchestratorService extends Service implements Orchestrator, WorkerInboundHandler {
  static inject = ['store', 'policy', 'workers', 'clock']
  static Config = HubConfigSchema.shape.orchestrator.unwrap().extend({
    harness: HubConfigSchema.shape.harness,
    requesterReplyPolicy: z.enum(['auto', 'owner_review']).default('auto'),
    timezone: HubConfigSchema.shape.server.unwrap().shape.timezone,
  })
  private readonly mutex = new KeyedMutex<string>()
  private readonly timers = new TimerWheel()
  private paused = false
  private scheduling = false
  private dirty = false
  private lastTick = 0
  private staleEvents = 0
  private harnessDispatches = 0
  private harnessUnnegotiatedEvents = 0
  private pointerCasRejected = 0
  private pendingScheduling: Promise<unknown> = Promise.resolve()
  private resultSender?: ResultSender
  private feishuStatus?: import('@agent-hub/protocol').OverviewView['feishu']
  private readonly localDate: Intl.DateTimeFormat
  constructor(ctx: Context, private config: OrchestratorConfig) {
    super(ctx, 'orchestrator')
    this.localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone ?? 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit' })
  }
  async [Service.init]() {
    const ctx = this.ctx
    safeOn(ctx, 'feishu/status', status => { this.feishuStatus = status })
    await this.recover()
    // Keep a stable callback identity across Cordis service proxies and fiber disposal.
    const inbound: WorkerInboundHandler = {
      reconcile: (...args) => this.reconcile(...args),
      onRunEvents: (...args) => this.onRunEvents(...args),
      onRunGap: (...args) => this.onRunGap(...args),
      onWorkerOffline: (...args) => this.onWorkerOffline(...args),
      onCommandAck: (...args) => this.onCommandAck(...args),
    }
    ctx.effect(() => ctx.workers.setInboundHandler(inbound), 'orchestrator:inbound')
    ctx.effect(() => ctx.clock.setInterval(() => {
      const now = this.now()
      this.timers.advance(now)
      if (now - this.lastTick >= this.config.scheduler.tickMs) { this.lastTick = now; this.schedule() }
    }, 1000), 'orchestrator:timers')
    safeOn(ctx, 'hub/drain', async () => { this.pauseScheduling(); await this.pendingScheduling })
    safeOn(ctx, 'worker/updated', (worker, previous) => {
      if (worker.connection === 'online' && (previous?.connection !== 'online' || worker.drain !== previous.drain ||
        JSON.stringify(worker.adapters) !== JSON.stringify(previous.adapters))) this.schedule()
    })
    onHotUpdate<OrchestratorConfig>(ctx, ['scheduler', 'tasks', 'limits', 'requesterReplyPolicy', 'harness'], next => { this.config = next; this.schedule() })
    this.schedule()
    ctx.effect(() => async () => { this.pauseScheduling(); await this.pendingScheduling }, 'orchestrator:stop')
  }
  private now() { return this.ctx.clock.now() }
  private get db() { return this.ctx.store.repos }
  private requireTask(ref: string, db = this.db) {
    const task = findTask(db, ref)
    if (!task) throw new HubError('TASK_NOT_FOUND', 404)
    return task
  }
  private view(task: TaskRow, actor: Actor = owner) {
    const run = taskRunsFor(this.db, task.id)[0]
    return taskView(this.db, task, run && this.ctx.workers.get(run.workerId), actor, run)
  }
  getTask(ref: string, actor: Actor = owner) {
    const task = findTask(this.db, ref)
    return task && taskDetail(this.db, task, id => this.ctx.workers.get(id), actor)
  }
  private checkHandoffBinding(task: TaskRow, workspaceId: string, workerId: string | null) {
    if (!task.handoffFromRunId) return
    const source = this.db.runs.get(task.handoffFromRunId)
    if (!source || source.workspaceId !== workspaceId || source.workerId !== workerId) {
      throw new HubError('VALIDATION_FAILED', 400, { reason: 'HANDOFF_BINDING' })
    }
    return source
  }
  private validateOverrides(overrides: ApprovalOverrides, task: TaskRow) {
    this.checkHandoffBinding(task, overrides.workspaceId ?? task.workspaceId, overrides.requiredWorkerId ?? task.requiredWorkerId)
    if (overrides.adapter && !this.ctx.workers.list().some(worker => worker.adapters.some(a => a.id === overrides.adapter))) return 'UNKNOWN_ADAPTER'
    if (overrides.workspaceId && !this.ctx.workers.list().some(worker => worker.workspaces.some(w => w.id === overrides.workspaceId))) return 'UNKNOWN_WORKSPACE'
    const policy = task.policyDecisionJson as PolicyOutcome
    const max = policy.clampedProfile ?? (task.requesterType === 'requester' ? 'edit' : 'full')
    if (overrides.profile && Profile.options.indexOf(overrides.profile) > Profile.options.indexOf(max)) return 'PROFILE_NOT_ALLOWED'
    if ((overrides.timeoutMs !== undefined && !CreateTaskRequest.shape.timeoutMs.safeParse(overrides.timeoutMs).success) ||
      (overrides.subdir !== undefined && !CreateTaskRequest.shape.subdir.safeParse(overrides.subdir).success) ||
      (overrides.prompt?.length ?? 0) > this.config.tasks.maxPromptChars) return 'VALIDATION_FAILED'
    return undefined
  }
  createTask(input: CreateTaskInput, actor: Actor, opts: CreateOptions = {}) { return this.submit(input, actor, opts) }
  private async submit(input: CreateTaskInput, actor: Actor, opts: CreateOptions, parent?: TaskRow, previousRun?: RunRow, expectedParentVersion?: number, handoff?: { fromRunId: string; intent: 'relay' | 'fix'; requestedModel?: string }) {
    const { origin, ...body } = input
    const parsed = CreateTaskRequest.safeParse(body)
    if (!parsed.success || input.prompt.length > this.config.tasks.maxPromptChars) throw new HubError('VALIDATION_FAILED', 400)
    const data = parsed.data
    const source = origin?.source ?? (actor.channel === 'system' ? 'dashboard' : actor.channel)
    const now = this.now()
    const effects: Effect[] = []
    const response = this.ctx.store.tx(db => {
      if (parent && managedTask(db, parent.id)) throw new HubError('INVALID_TRANSITION', 409, { reason: 'WORKFLOW_MANAGED' })
      if (!opts.personalPlan && !opts.implementProject && !opts.gateProject && data.profile !== 'readonly' && occupied(db, data.workspaceId, data.requiredWorkerId)) {
        throw new HubError('INVALID_TRANSITION', 409, { reason: 'PROJECT_OCCUPIED' })
      }
      if (opts.personalPlan) {
        if (actor.type !== 'owner') throw new HubError('FORBIDDEN', 403)
        const existing = existingPlan(db, opts.personalPlan)
        if (existing) {
          const task = this.getTask(existing, actor)
          if (!task) throw new HubError('INVALID_TRANSITION', 409, { reason: 'PLANNING_TASK_UNAVAILABLE' })
          return task
        }
        if (occupied(db,data.workspaceId,data.requiredWorkerId)) throw new HubError('INVALID_TRANSITION',409,{reason:'PROJECT_OCCUPIED'})
      }
      const scope = JSON.stringify([actor.type, actor.id, source, parent?.id ?? 'POST /tasks'])
      const key = opts.idempotencyKey
      const requestHash = stableHash({ data, origin, parent: parent?.id, ...(handoff && { handoff }), expectedParentVersion })
      if (key !== undefined) {
        if (key.length > 64) throw new HubError('VALIDATION_FAILED', 400)
        const condition = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.scope, scope))
        const existing = db.select().from(idempotencyKeys).where(condition).get()
        if (existing && now - existing.createdAt < 86_400_000) {
          if (existing.requestHash !== requestHash) throw new HubError('IDEMPOTENCY_MISMATCH', 409)
          return existing.responseJson as NonNullable<ReturnType<OrchestratorService['getTask']>>
        }
        if (existing) db.delete(idempotencyKeys).where(condition).run()
      }
      if (parent) {
        if (expectedParentVersion !== undefined && parent.version !== expectedParentVersion) {
          throw new HubError('VERSION_CONFLICT', 409, { current: this.view(parent, actor) })
        }
        if (!allowedActions(taskState(db, parent), actor).includes('followup')) throw new HubError('FORBIDDEN', 403)
      }
      if (actor.type === 'requester') {
        const count = db.select({ count: sql<number>`count(*)` }).from(tasks)
          .where(and(eq(tasks.requesterId, actor.id), gte(tasks.createdAt, now - 3_600_000))).get()!.count
        if (count >= this.config.limits.requesterTasksPerHour) throw new HubError('RATE_LIMITED', 429, undefined, 3600)
      }
      const policy = this.ctx.policy.evaluate({ actor, source, workspaceId: data.workspaceId, adapter: data.adapter,
        profile: data.profile, prompt: data.prompt, chatId: origin?.feishu?.chatId })
      const id = taskId(now)
      const result = reduce(null, { type: 'SUBMIT', actor, decision: policy.decision,
        task: { id, requester: actor, profile: policy.clampedProfile ?? data.profile, maxAttempts: policy.maxAttempts ?? this.config.tasks.maxAttempts } }, { now })
      if ('error' in result) throw new HubError(result.error.code, result.error.status)
      const next = result.next
      db.tasks.insert({
        id, status: next.status, version: next.version, profile: next.profile,
        ...(handoff && { handoffFromRunId: handoff.fromRunId, harnessRequestJson: { v: 1, ...handoff } }),
        parentTaskId: parent?.id ?? null, rootTaskId: parent?.rootTaskId ?? id, source, originJson: origin ?? { source },
        requesterType: actor.type as TaskRow['requesterType'], requesterId: actor.id, title: redact(data.prompt).slice(0, 80), prompt: data.prompt,
        adapter: data.adapter ?? null, adapterPrefsJson: data.adapterPrefs ?? null, workspaceId: data.workspaceId,
        subdir: data.subdir ?? null, model: data.model ?? null, requiredWorkerId: data.requiredWorkerId ?? null,
        preferredWorkerId: data.preferredWorkerId ?? null, resumeSessionId: previousRun?.cliSessionId ?? null,
        timeoutMs: data.timeoutMs ?? this.config.tasks.defaultTimeoutMs, maxAttempts: opts.personalPlan || opts.implementProject || opts.gateProject ? 1 : next.maxAttempts,
        policyDecisionJson: policy, errorCode: next.errorCode ?? null, priority: data.priority,
        approvalDeadlineAt: next.status === 'awaiting_approval' ? now + (policy.approvalTimeoutMs ?? this.config.tasks.approvalTimeoutMs) : null,
        queuedAt: next.status === 'queued' ? now : null, finishedAt: next.status === 'rejected' ? now : null, createdAt: now, updatedAt: now,
      })
      if (opts.personalPlan) {
        recordPlanningTask(db, opts.personalPlan, id, now)
        if (next.status === 'rejected') blockProject(db, opts.personalPlan.projectId, 'POLICY_REJECTED', now)
      }
      if (opts.implementProject) {
        beginImplementation(db, opts.implementProject, id, now)
        if (next.status === 'rejected') blockProject(db, opts.implementProject, 'POLICY_REJECTED', now)
      }
      if (opts.gateProject) {
        beginGate(db,opts.gateProject,id,now)
        if (next.status === 'rejected') blockProject(db,opts.gateProject,'POLICY_REJECTED',now)
      }
      this.audit(db, id, actor, 'task.submit', null, next.status, { policy })
      if (handoff) this.audit(db, id, actor, 'task.handoff.created', null, next.status,
        { ...handoff, runId: handoff.fromRunId, fromTaskId: parent!.id, adapter: data.adapter ?? null })
      const task = this.getTask(id, actor)!
      if (key !== undefined) db.insert(idempotencyKeys).values({ key, scope, requestHash, responseJson: task, createdAt: now }).run()
      effects.push(...result.effects)
      return task
    })
    this.after(response.id, effects)
    return response
  }
  async handoff(ref: string, actor: Actor, input: HandoffInput, opts: CreateOptions = {}) {
    const task = this.requireTask(ref)
    const { from, adapter, resume, intent } = handoffSource(this.db, task, actor, input, id => this.ctx.workers.get(id))
    if (input.requiredWorkerId && input.requiredWorkerId !== from.workerId) throw new HubError('VALIDATION_FAILED', 400, { reason: 'HANDOFF_WORKER_MISMATCH' })
    const model = input.model ?? (adapter === from.adapter ? task.model : null)
    return this.submit({ ...(input.priority !== undefined && { priority: input.priority }), prompt: input.prompt ?? HANDOFF_DEFAULT_PROMPTS[intent], workspaceId: from.workspaceId,
      profile: input.profile ?? task.profile, requiredWorkerId: from.workerId, ...(adapter && { adapter }),
      ...(task.adapterPrefsJson && { adapterPrefs: task.adapterPrefsJson as AdapterId[] }),
      ...(model !== null && { model }), ...(task.subdir && { subdir: task.subdir }), ...(input.origin && { origin: input.origin }) },
    actor, opts, task, resume ? from : undefined, input.expectedVersion, { fromRunId: from.id, intent, ...(input.model !== undefined && { requestedModel: input.model }) })
  }
  handoffPreview(ref: string, actor: Actor, query: HandoffPreviewQuery) {
    const task = this.requireTask(ref)
    const source = handoffSource(this.db, task, actor, query, id => this.ctx.workers.get(id))
    const policy = policyFor(this.config.harness, source.from.workspaceId)
    return preview(this.db, task, source, this.now(), this.config.scheduler.defaultAdapterOrder, policy.enabled && policy.blackboard)
  }
  runHarness(ref: string, runId: string) {
    const task = this.requireTask(ref)
    const run = this.db.runs.get(runId)
    if (run?.taskId !== task.id) throw new HubError('RUN_NOT_FOUND', 404)
    return harnessView(this.db, run)
  }
  listWorkspacePointers() { return this.db.pointers.list().map(row => pointerView(this.db, row)) }
  async acceptRun(worker: string, workspace: string, actor: Actor, input: AcceptRunRequest) {
    try {
      const view = this.ctx.store.tx(db => {
        const run = acceptRun(db, worker, workspace, actor, input, this.now())
        this.audit(db, run.taskId, actor, 'task.workspace.accepted', null, null, { runId: run.id, by: actor.id, seq: run.workspaceSeq })
        return pointerView(db, db.pointers.get(worker, workspace)!)
      })
      this.ctx.emit('workspace/pointer', view)
      return view
    } catch (error) {
      if (error instanceof HubError && error.status === 409) this.pointerCasRejected++
      throw error
    }
  }
  async followUp(ref: string, actor: Actor, input: VersionOptions & { prompt: string; origin?: CreateTaskInput['origin'] }, opts: CreateOptions = {}) {
    const task = this.requireTask(ref)
    const previous = taskRunsFor(this.db, task.id).find(run => run.cliSessionId)
    const adapter = previous?.adapter ?? task.adapter
    return this.submit({ prompt: input.prompt, workspaceId: task.workspaceId, profile: task.profile,
      ...(input.origin && { origin: input.origin }), ...(adapter && { adapter: adapter as AdapterId }),
      ...(previous && { requiredWorkerId: previous.workerId }), ...(task.subdir && { subdir: task.subdir }), ...(task.model && { model: task.model }),
    }, actor, opts, task, previous, input.expectedVersion)
  }
  approve(id: string, actor: Actor, opts: ApprovalOptions = {}) {
    return this.transition(id, { type: 'APPROVE', actor, ...version(opts), ...(opts.overrides && { overrides: opts.overrides }) })
  }
  reject(id: string, actor: Actor, opts: ReasonOptions = {}) {
    return this.transition(id, { type: 'REJECT', actor, ...version(opts), ...(opts.reason !== undefined && { reason: opts.reason }) })
  }
  cancel(id: string, actor: Actor, opts: ReasonOptions = {}) {
    return this.transition(id, { type: 'CANCEL', actor, ...version(opts), ...(opts.reason !== undefined && { reason: opts.reason }) })
  }
  retry(id: string, actor: Actor, opts: ApprovalOptions = {}) {
    const task = this.requireTask(id)
    const decision = this.ctx.policy.evaluate({ actor, source: task.source, profile: task.profile, workspaceId: task.workspaceId,
      adapter: task.adapter ?? undefined, prompt: task.prompt, chatId: (task.originJson as CreateTaskInput['origin'])?.feishu?.chatId }).decision
    return this.transition(id, { type: 'RETRY', actor, decision, ...version(opts), ...(opts.overrides && { overrides: opts.overrides }),
      ...(opts.force !== undefined && { force: opts.force }) })
  }
  provideInput(id: string, actor: Actor, input: VersionOptions & { requestId: string; answer: string }) {
    return this.transition(id, { type: 'INPUT_PROVIDE', actor, ...version(input), requestId: input.requestId, answer: input.answer })
  }
  setResultSender(send: ResultSender) {
    this.resultSender = send
    const pending = this.db.select().from(tasks).where(and(eq(tasks.source, 'feishu'), eq(tasks.resultDeliveryStatus, 'delivered'),
      sql`${tasks.resultDeliveredAt} is null`)).all()
    for (const task of pending) void guardAsync(this.ctx, this.deliverResult(task.id, owner, { action: 'send' }), 'resume result delivery')
    return () => { if (this.resultSender === send) delete this.resultSender }
  }
  async deliverResult(ref: string, actor: Actor, input: DeliverResultRequest) {
    const { id } = this.requireTask(ref)
    return this.mutex.runExclusive(id, async () => {
      const task = this.requireTask(id)
      if (actor.type !== 'owner') throw new HubError('FORBIDDEN', 403)
      const status = input.action === 'send' ? 'delivered' : 'suppressed'
      const needsTransport = input.action === 'send' && task.source === 'feishu'
      if (task.resultDeliveryStatus === status && (!needsTransport || task.resultDeliveredAt !== null)) return this.getTask(id, actor)!
      const sender = this.resultSender
      if (needsTransport && !sender) throw new HubError('INVALID_TRANSITION', 409, { reason: 'RESULT_CHANNEL_UNAVAILABLE' })
      const summary = task.resultDeliveryStatus === 'delivered' ? task.resultSummary ?? '' : redact(input.summaryOverride ?? task.resultSummary ?? '')
      if (task.resultDeliveryStatus !== status) {
        if (input.expectedVersion !== undefined && task.version !== input.expectedVersion) {
          throw new HubError('VERSION_CONFLICT', 409, { current: this.view(task, actor) })
        }
        if (task.status !== 'succeeded' || task.resultDeliveryStatus !== 'pending_review') throw new HubError('INVALID_TRANSITION', 409)
        this.ctx.store.tx(db => {
          const now = this.now()
          const changed = db.tasks.casUpdate(id, task.version, { resultDeliveryStatus: status, updatedAt: now,
            version: task.version + 1, resultSummary: status === 'delivered' ? summary : task.resultSummary,
            resultDeliveredAt: status === 'delivered' && !needsTransport ? now : null })
          if (!changed) throw new HubError('VERSION_CONFLICT', 409)
          this.audit(db, id, actor, 'task.result.' + status, task.status, task.status)
        })
        this.ctx.emit('task/result-delivery', id)
      }
      if (needsTransport && sender) {
        const approved = this.requireTask(id)
        await sender(approved, summary, 'task.result:' + id)
        this.ctx.store.tx(db => db.update(tasks).set({ resultDeliveredAt: this.now() }).where(eq(tasks.id, id)).run())
      }
      return this.getTask(id, actor)!
    })
  }
  private async transition(ref: string, event: TaskEvent) {
    const { id } = this.requireTask(ref)
    return this.mutex.runExclusive(id, () => {
      const effects = this.ctx.store.tx(db => this.apply(db, id, event))
      this.after(id, effects)
      return this.view(this.requireTask(id), event.actor)
    })
  }
  private apply(db: Repos, id: string, event: TaskEvent): Effect[] {
    const task = this.requireTask(id, db), now = this.now()
    if (managedTask(db, id) && (event.type === 'RETRY' || event.type === 'INPUT_PROVIDE' || (event.type === 'APPROVE' && event.overrides))) {
      throw new HubError('INVALID_TRANSITION', 409, { reason: 'WORKFLOW_MANAGED' })
    }
    if (event.type === 'RETRY' && task.profile !== 'readonly' && occupied(db, task.workspaceId, task.requiredWorkerId)) {
      throw new HubError('INVALID_TRANSITION', 409, { reason: 'PROJECT_OCCUPIED' })
    }
    if ('runId' in event && event.runId !== task.currentRunId) return [{ type: 'metric.stale_run_event', runId: event.runId }]
    const result = reduce(taskState(db, task), event, { now,
      ...(event.type === 'DISPATCH' && { newRunId: runId(now) }),
      validateOverrides: overrides => this.validateOverrides(overrides, task),
    })
    if ('error' in result) throw new HubError(result.error.code, result.error.status,
      result.error.code === 'VERSION_CONFLICT' ? { current: this.view(task, event.actor) } : result.error.details)
    const next = result.next
    const changes: Partial<TaskRow> = {
      status: next.status, version: next.version, updatedAt: next.updatedAt, profile: next.profile, currentRunId: next.currentRunId,
      attemptCount: next.attemptCount, runSeq: next.runSeq, errorCode: next.errorCode ?? null,
      ...(next.status === 'queued' && next.version !== task.version && { queuedAt: now, scheduleHint: null, startedAt: null, finishedAt: null }),
      ...(result.effects.some(effect => effect.type === 'transition' && effect.event === 'RUN_ACCEPTED') && { startedAt: task.startedAt ?? now }),
      ...((event.type === 'APPROVE' || event.type === 'REJECT') && { decidedBy: event.actor.id, decidedAt: now,
        ...(event.type === 'REJECT' && { rejectReason: event.reason ? redact(event.reason) : null }) }),
      ...(event.type === 'RETRY' && { resultSummary: null, resultDeliveryStatus: 'not_required', resultDeliveredAt: null,
        errorMessage: null, finishedAt: null, ...(next.status === 'awaiting_approval' && { approvalDeadlineAt: now + this.config.tasks.approvalTimeoutMs }) }),
      ...(!next.currentRunId && ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'].includes(next.status) && { finishedAt: now }),
    }
    const extras: Effect[] = []
    for (const write of result.writes) {
      switch (write.type) {
        case 'task.overrides': {
          const { prompt, harness, ...fields } = write.overrides
          if (task.handoffFromRunId && fields.adapter && fields.adapter !== (task.adapter ?? db.runs.forTask(task.id)[0]?.adapter ?? fields.adapter)) {
            changes.model = null
            if (task.harnessRequestJson?.requestedModel !== undefined) {
              changes.harnessRequestJson = { ...task.harnessRequestJson }
              delete changes.harnessRequestJson.requestedModel
            }
          }
          if (fields.adapter && task.handoffFromRunId && fields.adapter !== db.runs.get(task.handoffFromRunId)?.adapter) {
            changes.resumeSessionId = null
          }
          if (harness) changes.harnessRequestJson = { v: 1, ...(changes.harnessRequestJson ?? task.harnessRequestJson),
            overrides: { ...task.harnessRequestJson?.overrides, ...harness } }
          for (const [key, value] of Object.entries(fields)) if (value !== undefined) Object.assign(changes, { [key]: value })
          if (prompt !== undefined) Object.assign(changes, { prompt, title: redact(prompt).slice(0, 80) })
          break
        }
        case 'run.create': {
          const source = this.checkHandoffBinding(task, write.workspaceId, write.workerId)
          if (source && source.adapter !== write.adapter && task.resumeSessionId) {
            task.resumeSessionId = null
            changes.resumeSessionId = null
          }
          // Automatic adapter selection is only final in the dispatch transaction.
          if (source) {
            changes.model = task.harnessRequestJson?.requestedModel ??
              (write.adapter === source.adapter ? db.tasks.get(source.taskId)?.model ?? null : null)
          }
          const step = executionStep(db, id)
          if (step) db.prepare('UPDATE personal_steps SET run_id=? WHERE task_id=? AND run_id IS NULL').run(write.runId, id)
          const planning = db.prepare("UPDATE personal_projects SET plan_run_id=? WHERE plan_task_id=? AND phase='planning'").run(write.runId, id).changes > 0
          const harness: HarnessRecord | null = planning || (step && !['implement','repair','verify_final'].includes(step.kind)) ? null : step ? { v: 1, directive: { v: 1, board: 'off', bootstrap: false,
            inject: 'none', trust: 'owner', verify: { autoFixMaxRetries: 0 } } } : planHarness(db, task, { ...write, id: write.runId }, this.config.harness,
            this.ctx.workers.capabilities(write.workerId), now, () => this.audit(db, id, system, 'task.harness.facts_dropped', null, null, { runId: write.runId }))
          if (harness) this.harnessDispatches++
          db.insert(taskRuns).values({ id: write.runId, taskId: id, runSeq: write.runSeq, attempt: write.attempt,
            adapter: write.adapter, workerId: write.workerId, workspaceId: write.workspaceId, profile: write.profile,
            harnessJson: harness, ...(harness?.directive?.verify && { verificationStatus: 'pending' as const,
              verificationJson: { requested: harness.directive.verify, attempts: [] } }), status: 'dispatching', dispatchCount: 0, dispatchedAt: now, notAfter: now + this.config.tasks.dispatchAckTimeoutMs * (this.config.tasks.maxDispatchResends + 1) }).run()
          db.update(workers).set({ lastDispatchAt: now }).where(eq(workers.id, write.workerId)).run()
          break
        }
        case 'run.update': {
          const prior = findRun(db, write.runId)!
          if ((event.type === 'RUN_LOST' || event.type === 'DISPATCH_LOST') &&
              (prior.verificationStatus === 'pending' || prior.verificationStatus === 'running')) {
            const outcome = finishVerification(db, prior, undefined, 'RUN_LOST')!
            extras.push({ type: 'verification.outcome', status: outcome.status })
            this.audit(db, id, system, 'task.harness.verification', null, null, { runId: prior.id, ...outcome })
          }
          const accepting = write.status === 'running' && prior.status === 'dispatching'
          if (accepting) {
            observeAcceptance(db, prior, now)
            extras.push({ type: 'pointer.changed', workerId: prior.workerId, workspaceId: prior.workspaceId })
          }
          if (!accepting && prior.status !== write.status) {
            const pointer = db.pointers.get(prior.workerId, prior.workspaceId)
            if (pointer?.lastAttemptRunId === prior.id || pointer?.lastAcceptedRunId === prior.id) {
              extras.push({ type: 'pointer.changed', workerId: prior.workerId, workspaceId: prior.workspaceId })
            }
          }
          const connection = accepting ? db.select({ epoch: workers.connectionEpoch }).from(workers).where(eq(workers.id, event.actor.id)).get() : undefined
          db.update(taskRuns).set({ status: write.status,
            ...(accepting && { ackedAt: now, startedAt: now, connectionEpoch: connection?.epoch ?? null }),
            ...(write.status === 'cancelling' && { cancelRequestedAt: now, cancelReason: event.type === 'INPUT_EXPIRE' ? 'input_timeout' :
              event.type === 'CANCEL' && event.reason === 'hub_backstop' ? 'hub_backstop' : 'user' }),
            ...(!activeRunStatuses.some(status => status === write.status) && { finishedAt: now }),
          }).where(eq(taskRuns.id, write.runId)).run()
          break
        }
        case 'input.open':
          db.insert(inputRequests).values({ id: write.requestId, runId: write.runId, taskId: id, question: write.question,
            optionsJson: write.options ?? null, status: 'open', createdAt: now, expiresAt: now + this.config.tasks.inputTimeoutMs }).run()
          break
        case 'input.close':
          db.update(inputRequests).set(write.answer === undefined
            ? { status: event.type === 'INPUT_EXPIRE' ? 'expired' : 'cancelled' }
            : { status: 'answered', answer: write.answer, answeredAt: now, answeredBy: event.actor.id }).where(eq(inputRequests.id, write.requestId)).run()
          break
      }
    }
    if (next.version !== task.version) {
      if (['RUN_REFUSED','DISPATCH_LOST','RUN_LOST','INPUT_REQUEST','CANCEL'].includes(event.type) ||
          ['failed','timed_out','cancelled','rejected'].includes(next.status)) {
        const step = executionStep(db,id)
        const project = step?.project_id ?? findPlanningTask(db,id)?.id
        // The terminal delivery receipt includes the Git operation and its precise stopping reason.
        const deliveryResult = step && ['commit','push','verify_final'].includes(step.kind) && event.type === finishedType.failed
        if (project && !deliveryResult) blockProject(db, project, next.errorCode ?? event.type, now)
      }
      if (!db.tasks.casUpdate(id, task.version, changes)) {
        throw new HubError('VERSION_CONFLICT', 409, { current: this.view(this.requireTask(id), event.actor) })
      }
      for (const effect of result.effects) if (effect.type === 'transition') {
        this.audit(db, id, event.actor, 'task.' + effect.event.toLowerCase(), effect.from, effect.next.status, {
          ...(effect.implicitAccept && { implicitAccept: true }), ...(effect.override && { override: true }),
          ...('overrides' in event && event.overrides?.prompt && { before: task.title, after: changes.title }),
        })
      }
    } else if (result.effects.some(effect => effect.type === 'audit.noop')) this.audit(db, id, event.actor, 'task.noop', task.status, task.status, { event: event.type })
    return [...result.effects, ...extras]
  }
  private audit(db: Repos, id: string, actor: Actor, action: string, from: string | null, to: string | null, detail?: unknown) {
    db.insert(auditLogs).values({ ts: this.now(), actorType: actor.type, actorId: actor.id, channel: actor.channel,
      action, targetType: 'task', targetId: id, fromStatus: from, toStatus: to, detailJson: detail ?? null }).run()
  }
  private after(id: string, effects: Effect[]) {
    if (!effects.length) return
    const task = this.requireTask(id)
    const latest = taskRunsFor(this.db, task.id)[0]
    const publishedPointers = new Set<string>()
    for (const effect of effects) {
      switch (effect.type) {
        case 'verification.outcome': this.verificationOutcomes[effect.status]++; break
        case 'pointer.changed': {
          const key = effect.workerId + '/' + effect.workspaceId
          if (publishedPointers.has(key)) break
          publishedPointers.add(key)
          const pointer = this.db.pointers.get(effect.workerId, effect.workspaceId)
          if (pointer) this.ctx.emit('workspace/pointer', pointerView(this.db, pointer))
          break
        }
        case 'transition': {
          const view = this.view(task)
          if (effect.from === null) this.ctx.emit('task/created', view)
          const run = effect.next.currentRunId ?? latest?.id
          this.ctx.emit('task/transitioned', { task: { ...view, status: effect.next.status, version: effect.next.version },
            from: effect.from, to: effect.next.status, event: effect.event, actor: effect.actor, ...(run && { runId: run }),
            ...(effect.reason !== undefined && { reason: redact(effect.reason) }) })
          this.schedule()
          break
        }
        case 'dispatch': this.dispatch(task, findRun(this.db, effect.runId)!); break
        case 'cancel': this.sendCancel(findRun(this.db, effect.runId)!); break
        case 'input': {
          const run = findRun(this.db, effect.runId)!
          this.send(run, { type: 'run.input', payload: { runId: run.id, requestId: effect.requestId, answer: effect.answer } })
          break
        }
        case 'timer':
          if (effect.action === 'clear') this.timers.delete(effect.timer + ':' + id)
          else this.taskTimers(task)
          break
        case 'metric.stale_run_event': this.staleEvents++; break
      }
    }
    if (latest) this.ctx.emit('run/updated', runView(latest, this.db))
  }
  private dispatch(task: TaskRow, run: RunRow) {
    const source = this.checkHandoffBinding(task, run.workspaceId, run.workerId)
    const harness = run.harnessJson ? toWireDirective(run.harnessJson as HarnessRecord) : undefined
    const plan = findPlanningTask(this.db, task.id)
    const step = executionStep(this.db, task.id)
    const payload: RunDispatch = { taskId: task.id, taskNo: task.taskNo, runId: run.id, attempt: run.attempt,
      adapter: run.adapter as AdapterId, workspaceId: run.workspaceId, profile: task.profile, prompt: task.prompt,
      timeoutMs: task.timeoutMs, idleTimeoutMs: this.config.tasks.idleTimeoutMs, notAfter: run.notAfter,
      ...(plan ? { personal: { role: 'main' as const, projectId: plan.id, binding: JSON.parse(plan.binding_json), planSources: JSON.parse(plan.sources_json) } } :
        step ? { personal: personalDispatch(this.db,step), ...(harness && { harness }) } : harness && { harness }),
      origin: { source: task.source, actorType: task.requesterType },
      ...(task.subdir && { subdir: task.subdir }), ...(task.model && { model: task.model }),
      ...(task.resumeSessionId && (!source || source.adapter === run.adapter) && { resume: { cliSessionId: task.resumeSessionId } }),
    }
    this.send(run, { type: 'run.dispatch', payload })
  }
  private sendCancel(run: RunRow, force = false) {
    const reason = run.cancelReason === 'input_timeout' || run.cancelReason === 'hub_backstop' ? run.cancelReason : 'user'
    this.send(run, { type: 'run.cancel', payload: { runId: run.id, reason, force, graceMs: 5000 } })
  }
  private send(run: RunRow, content: Command) {
    const ts = this.now()
    const frame: HubCommand = { v: 1, id: ulid(ts), ts, ...content }
    const delivery = this.ctx.workers.send(run.workerId, frame).catch(async () => {
      if (!this.paused && frame.type === 'run.dispatch' && findRun(this.db, run.id)?.status === 'dispatching' &&
        this.ctx.workers.isOnline(run.workerId)) await this.lost(run)
    })
    void guardAsync(this.ctx, delivery, content.type)
  }
  onCommandAck(id: string, command: HubCommand, ack: CmdAckPayload) {
    void guardAsync(this.ctx, this.applyCommandAck(id, command, ack), 'worker command acknowledgement')
  }
  private async applyCommandAck(id: string, command: HubCommand, ack: CmdAckPayload) {
    if (!('runId' in command.payload)) return
    const run = findRun(this.db, command.payload.runId)
    if (!run || run.workerId !== id) return
    const actor = workerActor(id)
    if (command.type === 'run.dispatch') {
      if (run.status !== 'dispatching' && (run.status !== 'cancelling' || ack.ok)) return
      await this.transition(run.taskId, { type: ack.ok ? 'RUN_ACCEPTED' : 'RUN_REFUSED', actor, runId: run.id })
    } else if (command.type === 'run.input' && ack.ok) {
      this.ctx.store.tx(db => db.update(inputRequests).set({ status: 'delivered', deliveredAt: this.now() })
        .where(and(eq(inputRequests.id, command.payload.requestId), eq(inputRequests.runId, run.id), eq(inputRequests.status, 'answered'))).run())
    } else if (command.type === 'run.cancel' && !ack.ok && ack.error?.code === 'RUN_NOT_FOUND' && run.status === 'cancelling') await this.lost(run)
  }
  onRunEvents(id: string, frame: RunEventsFrame) { return this.ingest(id, frame.runId, frame.events) }
  onRunGap(id: string, frame: RunGapFrame) {
    return this.ingest(id, frame.runId, [{ kind: 'gap', reason: 'worker_evicted', seq: frame.fromSeq, toSeq: frame.toSeq, ts: this.now() }])
  }
  private async ingest(workerId: string, id: string, events: StoredEvent[]) {
    const run = findRun(this.db, id)
    if (!run || run.workerId !== workerId) throw new HubError('RUN_NOT_FOUND', 404)
    const effects: Effect[] = []
    let persisted: StoredEvent[] = []
    const stateful = events.some(event => event.kind !== 'log' && event.kind !== 'agent' && event.kind !== 'gap')
    const enqueue = () => this.ctx.store.ingest.enqueue(id, events, (db, accepted) => {
      persisted = accepted
      if (stateful) for (const event of accepted) this.applyRunEvent(db, run, event, effects)
    })
    const stored = stateful ? await this.mutex.runExclusive(run.taskId, async () => {
      const result = await enqueue()
      this.after(run.taskId, effects)
      return result
    }) : await enqueue()
    if (persisted.length) this.ctx.emit('run/events', id, run.taskId, persisted.map(stripBoardContent))
    return { ackSeq: stored.lastSeq }
  }
  private applyRunEvent(db: Repos, run: RunRow, event: StoredEvent, effects: Effect[]) {
    const task = this.requireTask(run.taskId, db)
    if (task.currentRunId !== run.id) {
      if (event.kind === 'started' || event.kind === 'input_request' || event.kind === 'finished') effects.push({ type: 'metric.stale_run_event', runId: run.id })
      return
    }
    const actor = workerActor(run.workerId)
    const updateRun = (patch: Partial<RunRow>) => db.update(taskRuns).set(patch).where(eq(taskRuns.id, run.id)).run()
    if (event.kind === 'started') {
      if (task.status === 'dispatching') {
        updateRun({ profile: event.effectiveProfile })
        effects.push(...this.apply(db, task.id, { type: 'RUN_ACCEPTED', actor, runId: run.id }))
      } else if (event.effectiveProfile === 'readonly') {
        const registered = findRun(db, run.id)!
        if (registered.profile !== 'readonly' && rollbackWriteRegistration(db, registered, this.now())) {
          effects.push({ type: 'pointer.changed', workerId: run.workerId, workspaceId: run.workspaceId })
        }
      }
      updateRun({ pid: event.pid, profile: event.effectiveProfile, cliVersion: event.cliVersion ?? null, commandSummary: event.commandSummary })
      if (event.clampedFrom) this.audit(db, task.id, actor, 'run.profile_clamped', task.status, task.status, { from: event.clampedFrom, to: event.effectiveProfile })
    } else if (event.kind === 'session') updateRun({ cliSessionId: event.cliSessionId })
    else if (event.kind === 'progress') db.update(tasks).set({ lastProgress: (event.detail ?? event.phase).slice(0, 200) }).where(eq(tasks.id, task.id)).run()
    else if (event.kind === 'harness' || event.kind === 'workspace') {
      const fresh = findRun(db, run.id)!
      if (!this.ctx.workers.capabilities(run.workerId).includes('blackboard.v1')) this.harnessUnnegotiatedEvents++
      applyHarnessEvent(db, fresh, event, this.ctx.store.retention.storageLevel === 'critical',
        action => this.audit(db, task.id, actor, action, null, null, { runId: run.id }))
      effects.push({ type: 'harness.updated' })
    } else if (event.kind === 'verify') {
      applyVerifyEvent(db, findRun(db, run.id)!, event)
      const step = executionStep(db, task.id)
      if (step && event.phase === 'started') {
        const changed = db.prepare("UPDATE personal_projects SET phase='verifying',updated_at=? WHERE id=? AND phase='implementing' AND current_item=?").run(this.now(), step.project_id, step.item_id)
        if (changed.changes) db.prepare("UPDATE personal_items SET status='verifying' WHERE project_id=? AND item_id=?").run(step.project_id, step.item_id)
      }
      effects.push({ type: 'harness.updated' })
      if (!this.ctx.workers.capabilities(run.workerId).includes('verify.v1')) this.harnessUnnegotiatedEvents++
    } else if (event.kind === 'input_request') {
      effects.push(...this.apply(db, task.id, { type: 'INPUT_REQUEST', actor, runId: run.id, requestId: event.requestId,
        question: event.question, ...(event.options && { options: event.options }) }))
    } else if (event.kind === 'finished') {
      recordPlanResult(db, task.id, run.id, event, this.now())
      effects.push(...this.apply(db, task.id, { type: finishedType[event.status], actor, runId: run.id,
        ...(event.errorCode && { errorCode: event.errorCode }) }))
      updateRun({ summary: event.summary, exitCode: event.exitCode, signal: event.signal, errorCode: event.errorCode ?? null,
        errorMessage: event.errorMessage ?? null, usageJson: event.usage ?? null, filesChangedJson: event.filesChanged ?? null,
        ...((event.cliSessionId || event.verification?.autoFix?.attempts) && { cliSessionId: event.cliSessionId ?? null }) })
      const fresh = findRun(db, run.id)!
      const record = fresh.harnessJson as HarnessRecord | null
      finishImplementation(db, fresh, event, this.now())
      finishGate(db,fresh,event,this.now())
      finishDelivery(db,fresh,event,this.now())
      const outcome = finishVerification(db, fresh, event.verification, event.errorCode === 'WORKER_RESTARTED' ? 'WORKER_RESTARTED' : 'INTERNAL')
      if (outcome) {
        effects.push({ type: 'verification.outcome', status: outcome.status })
        this.audit(db, task.id, actor, 'task.harness.verification', null, null, { runId: run.id, ...outcome })
      }
      const boardDeleted = record?.boardDiff?.some(f => f.change === 'deleted') || (record?.pre?.board?.dir === 'present' && record.post?.board?.dir === 'unsafe')
      const gate = task.requesterType === 'requester' && event.status === 'succeeded' && record &&
        (boardDeleted ? 'BOARD_DELETED' : outcome?.status === 'unverified' || outcome?.status === 'failed' ? 'VERIFICATION'
          : outcome?.reason === 'TAMPER_RISK' || outcome?.reason === 'CONFIG_EXPOSED' ? 'TAMPER_RISK' : undefined)
      if (gate) {
        updateRun({ harnessJson: { ...record, gated: gate } })
        this.audit(db, task.id, actor, 'task.harness.result_gated', null, null, { runId: run.id, reason: gate })
      }
      const acceptance = autoAccept(db, fresh, task.requesterType, this.now(), !!record?.directive?.verify || !!outcome, outcome,
        verificationRecord(fresh).attempts.some(attempt => attempt.status === 'failed'))
      if (acceptance === 'accepted') {
        this.audit(db, task.id, system, 'task.workspace.accepted', null, null, { runId: run.id, seq: fresh.workspaceSeq, by: 'auto' })
        effects.push({ type: 'pointer.changed', workerId: run.workerId, workspaceId: run.workspaceId })
      } else if (acceptance === 'stale') this.pointerCasRejected++
      db.update(tasks).set({ resultSummary: event.summary, errorMessage: event.errorMessage ?? null,
        ...(event.status === 'succeeded' && { cliSessionId: event.cliSessionId ?? findRun(db, run.id)?.cliSessionId ?? null,
          resultDeliveryStatus: (gate || task.requesterType === 'requester' && this.config.requesterReplyPolicy === 'owner_review') ? 'pending_review' : 'not_required' }),
      }).where(eq(tasks.id, task.id)).run()
    }
  }
  private activeRuns(workerId?: string) {
    return this.db.runs.active(workerId)
  }
  private async lost(run: RunRow) {
    return this.mutex.runExclusive(run.taskId, () => {
      const current = findRun(this.db, run.id)
      if (!current || !activeRunStatuses.some(status => status === current.status)) return
      const effects = this.ctx.store.tx(db => this.apply(db, run.taskId, {
        type: current.status === 'dispatching' ? 'DISPATCH_LOST' : 'RUN_LOST', actor: system, runId: run.id,
      }))
      this.after(run.taskId, effects)
    })
  }
  async reconcile(workerId: string, hello: WorkerHello) {
    this.timers.delete('grace:' + workerId)
    return reconcileWorker(workerId, hello, this.activeRuns(workerId), id => findRun(this.db, id),
      run => this.lost(run), run => this.transition(run.taskId, { type: 'RUN_ACCEPTED', actor: workerActor(workerId), runId: run.id }), this.now())
  }
  onWorkerOffline(id: string, at: number, revoked = false) {
    if (this.paused) return
    const grace = this.ctx.workers.gracePeriodMs
    const loseRuns = () => {
      if (!revoked && this.ctx.workers.isOnline(id)) return
      for (const run of this.activeRuns(id)) void guardAsync(this.ctx, this.lost(run), 'worker lost')
    }
    if (revoked) { this.timers.delete('grace:' + id); loseRuns() }
    else this.timers.set('grace:' + id, at + grace, loseRuns)
  }
  private async recover() {
    const now = this.now()
    this.ctx.store.tx(db => {
      const active = db.prepare("SELECT id FROM personal_projects WHERE phase NOT IN ('done','stopped','blocked')").all() as { id: string }[]
      for (const project of active) blockProject(db, project.id, 'HUB_RESTART_INSPECT', now)
    })
    for (const worker of this.db.select().from(workers).all()) {
      if (worker.connection === 'offline' && this.activeRuns(worker.id).length) {
        this.onWorkerOffline(worker.id, Math.max(worker.disconnectedAt ?? 0, this.ctx.workers.startedAt), worker.status === 'revoked')
      }
    }
    for (const task of this.db.select().from(tasks).where(inArray(tasks.status, ['awaiting_approval', ...activeRunStatuses])).all()) {
      this.taskTimers(task)
      const run = task.currentRunId && findRun(this.db, task.currentRunId)
      if (!run) continue
      if (managedTask(this.db, task.id)) continue
      if (run.status === 'dispatching') {
        if (run.notAfter < now) await this.lost(run)
        else this.dispatch(task, run)
      } else if (run.status === 'cancelling') this.sendCancel(run)
      for (const input of this.db.select().from(inputRequests).where(and(eq(inputRequests.runId, run.id), eq(inputRequests.status, 'answered'))).all()) {
        this.send(run, { type: 'run.input', payload: { runId: run.id, requestId: input.id, answer: input.answer ?? '' } })
      }
    }
  }
  private taskTimers(task: TaskRow) {
    const id = task.id
    const set = (name: string, at: number, fn: () => Promise<unknown>) => this.timers.set(name + ':' + id, at, () => {
      void guardAsync(this.ctx, fn(), name + ' deadline')
    })
    if (task.status === 'awaiting_approval' && task.approvalDeadlineAt !== null)
      set('approval', task.approvalDeadlineAt, () => this.transition(id, { type: 'APPROVAL_EXPIRE', actor: system }))
    const run = task.currentRunId && findRun(this.db, task.currentRunId)
    if (!run) return
    if (task.status === 'dispatching') set('dispatch', run.notAfter, async () => {
      if (this.ctx.workers.isOnline(run.workerId) && findRun(this.db, run.id)?.status === 'dispatching') await this.lost(run)
    })
    if (task.status === 'running' || task.status === 'awaiting_input') set('run',
      (run.startedAt ?? this.now()) + task.timeoutMs + 2 * this.ctx.workers.gracePeriodMs,
      () => this.cancel(id, system, { reason: 'hub_backstop' }))
    if (task.status === 'awaiting_input') {
      const input = findInput(this.db, id)
      if (input) set('input', input.expiresAt, () => this.transition(id, { type: 'INPUT_EXPIRE', actor: system, runId: run.id }))
    }
    if (task.status === 'cancelling') set('cancel', (run.cancelRequestedAt ?? this.now()) + this.config.tasks.cancelAckTimeoutMs,
      async () => { if (findRun(this.db, run.id)?.status === 'cancelling' && this.ctx.workers.isOnline(run.workerId)) this.sendCancel(run, true) })
  }
  pauseScheduling() { this.paused = true }
  private schedule() {
    if (this.paused) return
    if (this.scheduling) { this.dirty = true; return }
    this.scheduling = true
    this.pendingScheduling = guardAsync(this.ctx, Promise.resolve().then(async () => {
      do { this.dirty = false; await this.schedulePass() } while (this.dirty && !this.paused)
    }).finally(() => { this.scheduling = false }), 'schedule tasks')
  }
  private async schedulePass() {
    if (this.paused) return
    const phases = ['implementation_ready',...gatePhases]
    const ready = this.db.prepare('SELECT id,phase FROM personal_projects WHERE phase IN ('+phases.map(()=>'?').join(',')+')').all(...phases) as { id: string; phase:string }[]
    for (const { id,phase } of ready) {
      try {
        if (phase !== 'implementation_ready') {
          const gate = prepareGate(this.db,id)
          await this.submit(gate.input,owner,{gateProject:id})
          continue
        }
        const { binding, item, execution, timeout } = projectExecution(this.db, id)
        if (timeout < 10000) throw new Error('TIME_BUDGET')
        if (item.status !== 'pending') throw new Error('FIXED_ITEM_UNAVAILABLE')
        const prompt = ['Implement only the following fixed task in the current repository. Read the cited requirements.',
          'Keep the plan and requirement files unchanged. Leave Git commit and push to the delivery step.',
          JSON.stringify({item:execution.item,planAdvice:planAdvice(this.db,id)})].join('\n')
        await this.submit({ prompt, requiredWorkerId: binding.workerId, workspaceId: binding.workspaceId,
          ...personalRoleSettings.main, timeoutMs: timeout }, owner, { implementProject: id })
      } catch (error) {
        const reason = error instanceof HubError ? (error.details?.reason ?? error.code) : error instanceof Error ? error.message : ''
        this.ctx.store.tx(db => blockProject(db,id,typeof reason === 'string' && /^[A-Z_]{1,80}$/u.test(reason) ? reason : 'PROJECT_SCHEDULING_UNCONFIRMED',this.now()))
      }
    }
    const queue = this.db.tasks.listQueued(this.config.scheduler.scanLimit)
    for (const candidate of queue) {
      if (this.paused) break
      await this.mutex.runExclusive(candidate.id, () => {
        const task = this.requireTask(candidate.id)
        if (task.status !== 'queued' || this.paused) return
        const project = findPlanningTask(this.db, task.id)
        const step = executionStep(this.db, task.id)
        if (project && project.phase !== 'planning') return
        if (step) {
          const phase = this.db.prepare('SELECT phase FROM personal_projects WHERE id=?').pluck().get(step.project_id)
          if (typeof phase !== 'string' || !stepCanDispatch(step.kind,phase)) return
        }
        if (!project && !step && task.profile !== 'readonly' && occupied(this.db, task.workspaceId, task.requiredWorkerId)) return
        const active = this.activeRuns()
        const now = this.now()
        const concurrent = task.requesterType === 'requester' && this.db.select({ count: sql<number>`count(*)` }).from(tasks)
          .where(and(eq(tasks.requesterType, 'requester'), eq(tasks.requesterId, task.requesterId), inArray(tasks.status, activeRunStatuses))).get()!.count
        const prior = taskRunsFor(this.db, task.id)
        const refused = new Set(prior.filter(run => run.status === 'refused' &&
          now - (run.finishedAt ?? 0) < this.config.scheduler.refuseBackoffMs).map(run => run.workerId))
        const workerRows = this.db.select().from(workers).all()
        const selected = concurrent !== false && concurrent >= this.config.limits.maxActivePerRequester
          ? { hint: 'REQUESTER_LIMIT', chosen: undefined }
          : selectWorker(task, this.ctx.workers.list(), active, this.config.scheduler.defaultAdapterOrder,
            id => refused.has(id), id => workerRows.find(worker => worker.id === id)?.lastDispatchAt ?? 0)
        if (!selected.chosen) {
          if ((selected.hint === 'HARNESS_UNSUPPORTED' || now - (task.queuedAt ?? now) >= this.config.scheduler.unschedulableWarnMs) && task.scheduleHint !== selected.hint) {
            this.ctx.store.tx(db => db.update(tasks).set({ scheduleHint: selected.hint! }).where(eq(tasks.id, task.id)).run())
          }
          return
        }
        const { worker, adapter } = selected.chosen
        const effects = this.ctx.store.tx(db => this.apply(db, task.id,
          { type: 'DISPATCH', actor: system, workerId: worker.id, workspaceId: task.workspaceId, adapter }))
        this.after(task.id, effects)
      })
    }
  }
  listTasks(query: TaskListQuery, actor: Actor) { return listTasks(this.db, query, task => this.view(task, actor)) }
  logs(ref: string, id: string, query: LogsQuery) { return logs(this.db, this.requireTask(ref).id, id, query) }
  listWorkers() { return this.ctx.workers.list() }
  setWorkerDrain(id: string, drain: boolean, actor: Actor) { return this.ctx.workers.setDrain(id, drain, actor) }
  overview() {
    const view = overview(this.db, this.ctx.workers, this.now(), this.paused, this.localDate)
    view.hub.storageLevel = this.ctx.store.retention.storageLevel
    if (this.feishuStatus) view.feishu = this.feishuStatus
    return view
  }
  private readonly verificationOutcomes = { passed: 0, failed: 0, skipped: 0, unverified: 0 }
  metrics() { return { verificationOutcomes: { ...this.verificationOutcomes }, harnessDispatches: this.harnessDispatches, harnessUnnegotiatedEvents: this.harnessUnnegotiatedEvents, pointerCasRejected: this.pointerCasRejected, staleRunEvents: this.staleEvents, mutexKeys: this.mutex.size, timers: this.timers.size } }
}
