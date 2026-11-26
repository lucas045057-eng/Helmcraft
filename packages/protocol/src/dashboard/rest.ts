import { MethodId } from './methods.js'
import { z } from 'zod'
import { AdapterId, ErrorCode, FrameId, RunId, Source, TaskId, WorkerId, WorkspaceId } from '../common.js'
import { PolicyRule, TaskStatus } from '../task.js'
import { ActorView, LogEntry, Overview, RunView, TaskDetail, TaskSummary, WorkerView } from './dto.js'

export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string(),              // 面向人的中文描述
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: FrameId,
  }),
})

export const CreateTaskRequest = z.strictObject({
  prompt: z.string().min(1).max(32_000),
  workspaceId: z.string(),
  subdir: z.string().max(256).optional(),
  adapter: AdapterId.optional(),              // 不填则按 adapterPrefs / 全局默认顺序
  adapterPrefs: z.array(AdapterId).max(5).optional(),
  profile: z.enum(['readonly', 'edit', 'full']).default('edit'),
  requiredWorkerId: z.string().optional(),     // 手动派单到指定 Worker
  preferredWorkerId: z.string().optional(),
  priority: z.number().int().min(-10).max(10).default(0),
  timeoutMs: z.number().int().min(60_000).max(24 * 3600_000).optional(),
  model: z.string().max(128).optional(),
  notifyFeishuChatId: z.string().optional(),   // 可选：结果同时推送到某飞书会话
  methodId: MethodId.optional(),               // 可选：本次任务使用的方法卡（docs/specs/10）
})

export const ApprovalOverrides = z.strictObject({
  harness: z.strictObject({ blackboard: z.boolean().optional(), verify: z.boolean().optional() }).optional(),
  adapter: AdapterId.optional(), workspaceId: z.string().optional(), subdir: z.string().optional(),
  profile: z.enum(['readonly', 'edit', 'full']).optional(),
  prompt: z.string().min(1).max(32_000).optional(),   // 改写需求（原 prompt 保留在审计中）
  requiredWorkerId: z.string().optional(), timeoutMs: z.number().int().optional(),
})


const Version = z.number().int()
const Prompt = CreateTaskRequest.shape.prompt
const Cursor = z.string().optional()
const commaList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z.string().transform((value) => value.split(',')).pipe(z.array(item).min(1))
const unsigned = z.string().regex(/^\d+$/).transform(Number)
const pageLimit = (max: number, fallback: number) =>
  unsigned.pipe(z.number().int().min(1).max(max)).default(fallback)

export const RestTaskRef = z.union([TaskId, z.string().regex(/^\d+$/)])
export const TaskPath = z.strictObject({ ref: RestTaskRef })
export const RunPath = TaskPath.extend({ runId: RunId })
export const WorkerPath = z.strictObject({ id: WorkerId })
export const IdempotencyKey = z.string().max(64)
export const HealthResponse = z.strictObject({ ok: z.literal(true) })
export const ReadyResponse = z.strictObject({ ready: z.boolean() })
export const LoginRequest = z.strictObject({ token: z.string() })
export const LoginResponse = z.strictObject({ csrfToken: z.string(), expiresAt: z.number().int() })
export const Scope = z.enum(['read', 'operate', 'admin'])
export const Principal = z.strictObject({
  type: z.literal('owner'),
  via: z.enum(['session', 'token']),
  scopes: z.array(Scope),
})
export const AuthMeResponse = z.strictObject({ principal: Principal, csrfToken: z.string().optional() })
export const MetricsResponse = z.record(z.string(), z.json())
export const FibersResponse = z.array(z.strictObject({ name: z.string(), state: z.string(), error: z.string().optional() }))

export const TaskListQuery = z.strictObject({
  status: commaList(TaskStatus).optional(), workerId: WorkerId.optional(), workspaceId: WorkspaceId.optional(),
  adapter: AdapterId.optional(), source: Source.optional(), requesterId: z.string().optional(),
  q: z.string().optional(), parentTaskId: TaskId.optional(), from: unsigned.optional(),
  to: unsigned.optional(), limit: pageLimit(200, 50), cursor: Cursor,
})
export const TaskListResponse = z.strictObject({ items: z.array(TaskSummary), nextCursor: Cursor })
export const ApproveTaskRequest = z.strictObject({ expectedVersion: Version.optional(), overrides: ApprovalOverrides.optional() })
export const RejectTaskRequest = z.strictObject({ expectedVersion: Version.optional(), reason: z.string().max(500).optional() })
export const CancelTaskRequest = z.strictObject({ expectedVersion: Version.optional(), reason: z.string().optional() })
export const RetryTaskRequest = ApproveTaskRequest.extend({ force: z.boolean().optional() })
export const TaskInputRequest = z.strictObject({ expectedVersion: Version.optional(), requestId: z.string(), answer: z.string().max(20_000) })
export const FollowupTaskRequest = z.strictObject({ prompt: Prompt, expectedVersion: Version.optional() })
export const DeliverResultRequest = z.strictObject({
  expectedVersion: Version.optional(), action: z.enum(['send', 'suppress']),
  summaryOverride: z.string().max(20_000).optional(),
})
export const LogsQuery = z.strictObject({
  afterSeq: unsigned.pipe(z.number().int()).default(0),
  limit: pageLimit(1000, 500), kinds: commaList(LogEntry.shape.kind).optional(),
})
export const LogsResponse = z.strictObject({
  entries: z.array(LogEntry), lastSeq: z.number().int(), hasMore: z.boolean(), runFinished: z.boolean(),
})
export const WorkerListResponse = z.array(WorkerView)
export const WorkerDetail = WorkerView.extend({ recentRuns: z.array(RunView) })
export const DrainWorkerRequest = z.strictObject({ drain: z.boolean(), reason: z.string().optional() })
export const RevokeWorkerRequest = z.strictObject({ confirm: WorkerId })
export const EnrollTokenRequest = z.strictObject({ suggestedWorkerId: WorkerId.optional() })
export const EnrollTokenResponse = z.strictObject({ token: z.string(), expiresAt: z.number().int(), command: z.string() })
export const WorkerEnrollRequest = z.strictObject({
  token: z.string(), workerId: WorkerId, publicKey: z.string(),
  hostname: z.string().max(255), os: z.enum(['win32', 'darwin', 'linux']),
})
export const WorkerEnrollResponse = z.strictObject({ workerId: WorkerId, keyFingerprint: z.string() })

export const AuditQuery = z.strictObject({
  targetType: z.string().optional(), targetId: z.string().optional(),
  actorId: z.string().optional(), action: z.string().optional(), limit: pageLimit(200, 50), cursor: Cursor,
})
export const AuditEntry = z.strictObject({
  ts: z.number().int(), actor: ActorView, action: z.string(), targetType: z.string(),
  targetId: z.string().nullable(), details: z.json().optional(),
})
export const AuditResponse = z.strictObject({ items: z.array(AuditEntry), nextCursor: Cursor })
export const PoliciesResponse = z.array(PolicyRule)
export const ReplacePoliciesRequest = z.strictObject({ rules: z.array(PolicyRule), expectedRevision: z.number().int() })
export const ReplacePoliciesResponse = z.strictObject({ revision: z.number().int() })

export const ApiTokenView = z.strictObject({
  id: z.string(), name: z.string(), scopes: z.array(Scope), createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(), revokedAt: z.number().int().nullable(),
})
export const CreateApiTokenRequest = z.strictObject({ name: z.string(), scopes: z.array(Scope).min(1), expiresAt: z.number().int().optional() })
export const CreateApiTokenResponse = ApiTokenView.extend({ token: z.string().regex(/^ahk_[A-Za-z0-9_-]+$/) })
export const ApiTokensResponse = z.array(ApiTokenView)

export const API_PREFIX = '/api/v1'
export const SESSION_COOKIE = 'ah_sid'
export { Overview as OverviewResponse, TaskDetail as TaskResponse }


export type ApiError = z.infer<typeof ApiError>
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>
export type ApprovalOverrides = z.infer<typeof ApprovalOverrides>
export type RestTaskRef = z.infer<typeof RestTaskRef>
export type TaskPath = z.infer<typeof TaskPath>
export type RunPath = z.infer<typeof RunPath>
export type WorkerPath = z.infer<typeof WorkerPath>
export type IdempotencyKey = z.infer<typeof IdempotencyKey>
export type HealthResponse = z.infer<typeof HealthResponse>
export type ReadyResponse = z.infer<typeof ReadyResponse>
export type LoginRequest = z.infer<typeof LoginRequest>
export type LoginResponse = z.infer<typeof LoginResponse>
export type Scope = z.infer<typeof Scope>
export type Principal = z.infer<typeof Principal>
export type AuthMeResponse = z.infer<typeof AuthMeResponse>
export type MetricsResponse = z.infer<typeof MetricsResponse>
export type TaskListQuery = z.infer<typeof TaskListQuery>
export type TaskListResponse = z.infer<typeof TaskListResponse>
export type ApproveTaskRequest = z.infer<typeof ApproveTaskRequest>
export type RejectTaskRequest = z.infer<typeof RejectTaskRequest>
export type CancelTaskRequest = z.infer<typeof CancelTaskRequest>
export type RetryTaskRequest = z.infer<typeof RetryTaskRequest>
export type TaskInputRequest = z.infer<typeof TaskInputRequest>
export type FollowupTaskRequest = z.infer<typeof FollowupTaskRequest>
export type DeliverResultRequest = z.infer<typeof DeliverResultRequest>
export type LogsQuery = z.infer<typeof LogsQuery>
export type LogsResponse = z.infer<typeof LogsResponse>
export type WorkerDetail = z.infer<typeof WorkerDetail>
export type DrainWorkerRequest = z.infer<typeof DrainWorkerRequest>
export type RevokeWorkerRequest = z.infer<typeof RevokeWorkerRequest>
export type EnrollTokenRequest = z.infer<typeof EnrollTokenRequest>
export type EnrollTokenResponse = z.infer<typeof EnrollTokenResponse>
export type WorkerEnrollRequest = z.infer<typeof WorkerEnrollRequest>
export type WorkerEnrollResponse = z.infer<typeof WorkerEnrollResponse>
export type AuditQuery = z.infer<typeof AuditQuery>
export type AuditEntry = z.infer<typeof AuditEntry>
export type AuditResponse = z.infer<typeof AuditResponse>
export type ReplacePoliciesRequest = z.infer<typeof ReplacePoliciesRequest>
export type ReplacePoliciesResponse = z.infer<typeof ReplacePoliciesResponse>
export type ApiTokenView = z.infer<typeof ApiTokenView>
export type CreateApiTokenRequest = z.infer<typeof CreateApiTokenRequest>
export type CreateApiTokenResponse = z.infer<typeof CreateApiTokenResponse>
