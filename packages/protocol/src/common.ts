import { z } from 'zod'

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/
export const TASK_ID_PATTERN = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/
export const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/
export const FrameId = z.string().regex(ULID_PATTERN)
export const RunId = z.string().regex(RUN_ID_PATTERN)
export const TaskId = z.string().regex(TASK_ID_PATTERN)
export const WorkerId = z.string().regex(WORKER_ID_PATTERN)
export const WorkspaceId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
export const TaskRef = z.union([TaskId, z.string().regex(/^#?\d+$/)])

export const AdapterId = z.enum(['claude-code', 'codex', 'gemini', 'opencode', 'antigravity', 'mock'])
export const Profile = z.enum(['readonly', 'edit', 'full'])
export const Source = z.enum(['feishu', 'dashboard', 'api'])
export const ActorType = z.enum(['owner', 'requester', 'system', 'worker'])
export const ActorChannel = z.enum(['feishu', 'dashboard', 'api', 'system'])
export const Actor = z.strictObject({ type: ActorType, id: z.string(), channel: ActorChannel })
export const ResultDeliveryStatus = z.enum(['not_required', 'pending_review', 'delivered', 'suppressed'])
export const TaskAction = z.enum(['approve', 'reject', 'cancel', 'retry', 'input', 'followup', 'deliver_result'])
export const ErrorCode = z.enum([
  'VALIDATION_FAILED', 'UNAUTHENTICATED', 'CSRF_FAILED', 'FORBIDDEN',
  'TASK_NOT_FOUND', 'RUN_NOT_FOUND', 'WORKER_NOT_FOUND', 'INVALID_TRANSITION', 'VERSION_CONFLICT',
  'IDEMPOTENCY_MISMATCH', 'MAX_ATTEMPTS_REACHED', 'INPUT_REQUEST_CLOSED', 'WORKER_OFFLINE',
  'UNKNOWN_ADAPTER', 'UNKNOWN_WORKSPACE', 'PROFILE_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED', 'HUB_SHUTTING_DOWN', 'INTERNAL',
])

export type UlidGenerator = (now: number) => string
export type RunIdGenerator = () => RunId


export type FrameId = z.infer<typeof FrameId>
export type RunId = z.infer<typeof RunId>
export type TaskId = z.infer<typeof TaskId>
export type WorkerId = z.infer<typeof WorkerId>
export type WorkspaceId = z.infer<typeof WorkspaceId>
export type TaskRef = z.infer<typeof TaskRef>
export type AdapterId = z.infer<typeof AdapterId>
export type Profile = z.infer<typeof Profile>
export type Source = z.infer<typeof Source>
export type ActorType = z.infer<typeof ActorType>
export type ActorChannel = z.infer<typeof ActorChannel>
export type Actor = z.infer<typeof Actor>
export type ResultDeliveryStatus = z.infer<typeof ResultDeliveryStatus>
export type TaskAction = z.infer<typeof TaskAction>
export type ErrorCode = z.infer<typeof ErrorCode>
