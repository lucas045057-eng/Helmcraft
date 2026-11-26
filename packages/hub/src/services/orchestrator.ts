import type { TaskRow } from './store.js'
import type { PersonalPlanRequest, ProjectOverview } from '@agent-hub/protocol'
import type { AcceptRunRequest, HandoffPreview, HandoffPreviewQuery, HandoffTaskRequest, RunHarnessView, WorkspacePointerView, Actor, ApprovalOverrides, CreateTaskRequest, OverviewView, TaskDetailView, TaskOrigin, TaskView, TaskListQuery, TaskListResponse, LogsQuery, LogsResponse, DeliverResultRequest } from '@agent-hub/protocol'
export type CreateTaskInput = Pick<CreateTaskRequest, 'prompt' | 'workspaceId'> & Partial<CreateTaskRequest> & { origin?: TaskOrigin }
export interface CreateOptions { idempotencyKey?: string | undefined; personalPlan?: PersonalPlanRequest; implementProject?: string; gateProject?: string }
export interface VersionOptions { expectedVersion?: number | undefined }
export interface ApprovalOptions extends VersionOptions { overrides?: ApprovalOverrides | undefined; force?: boolean | undefined }
export interface ReasonOptions extends VersionOptions { reason?: string | undefined }
export type ResultSender = (task: TaskRow, summary: string, idempotencyKey: string) => Promise<void>
export type HandoffInput = HandoffTaskRequest & { origin?: TaskOrigin; priority?: number; requiredWorkerId?: string }
export interface Orchestrator {
  handoff(id: string, actor: Actor, input: HandoffInput, opts?: CreateOptions): Promise<TaskDetailView>
  handoffPreview(id: string, actor: Actor, query: HandoffPreviewQuery): HandoffPreview
  runHarness(id: string, runId: string): RunHarnessView
  listWorkspacePointers(): WorkspacePointerView[]
  listProjects(): ProjectOverview[]
  acceptRun(workerId: string, workspaceId: string, actor: Actor, input: AcceptRunRequest): Promise<WorkspacePointerView>
  setResultSender(send: ResultSender): () => void
  metrics(): { verificationOutcomes: Record<'passed' | 'failed' | 'skipped' | 'unverified', number>; harnessDispatches: number; harnessUnnegotiatedEvents: number; pointerCasRejected: number; staleRunEvents: number; mutexKeys: number; timers: number }
  createTask(input: CreateTaskInput, actor: Actor, opts?: CreateOptions): Promise<TaskDetailView>
  approve(id: string, actor: Actor, opts?: ApprovalOptions): Promise<TaskView>
  reject(id: string, actor: Actor, opts?: ReasonOptions): Promise<TaskView>
  cancel(id: string, actor: Actor, opts?: ReasonOptions): Promise<TaskView>
  retry(id: string, actor: Actor, opts?: ApprovalOptions): Promise<TaskView>
  provideInput(id: string, actor: Actor, input: VersionOptions & { requestId: string; answer: string }): Promise<TaskView>
  followUp(id: string, actor: Actor, input: VersionOptions & { prompt: string; origin?: TaskOrigin }, opts?: CreateOptions): Promise<TaskDetailView>
  deliverResult(id: string, actor: Actor, input: DeliverResultRequest): Promise<TaskDetailView>
  getTask(id: string, actor?: Actor): TaskDetailView | undefined
  listTasks(query: TaskListQuery, actor: Actor): TaskListResponse
  logs(id: string, runId: string, query: LogsQuery): LogsResponse
  listWorkers(): import('@agent-hub/protocol').WorkerView[]
  setWorkerDrain(workerId: string, drain: boolean, actor: Actor): Promise<void>
  overview(): OverviewView
  pauseScheduling(): void
}
