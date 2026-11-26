import { HarnessDirective } from './harness.js'
import { z } from 'zod'
import { AdapterId, ArtifactId, FrameId, Profile, RunId, TaskId, WorkspaceId } from '../common.js'
import { RunResumeState } from './handshake.js'
import { PersonalItemExecution, PersonalPlanReceipt, PlanSources } from './personal-plan.js'
import { PersonalGate } from './personal-gates.js'
import { PersonalDelivery } from './personal-delivery.js'

export const RunAttachment = z.strictObject({
  id: ArtifactId,
  kind: z.enum(['image', 'audio', 'file']),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  mimeType: z.string().min(1).max(128),
  encoding: z.literal('base64'),
  data: z.string().max(800_000),
})
export type RunAttachment = z.infer<typeof RunAttachment>

export const PersonalBinding = z.strictObject({
  workerId: z.string().min(1), workspaceId: z.string().min(1),
  root: z.string().min(1), branch: z.string().min(1), remote: z.string().min(1), ref: z.string().startsWith('refs/heads/'),
  destination: z.string().regex(/^[0-9a-f]{64}$/u),
  executables: z.strictObject({ main: z.string().min(1), reviewer: z.string().min(1), advisor: z.string().min(1) }),
  subdir: z.string().max(256).optional(),
  mode: z.enum(['strict', 'flexible']).optional(),
  allowVersionDrift: z.boolean().optional(),
  autoCommit: z.boolean().optional(),
  autoPush: z.boolean().optional(),
  adapters: z.strictObject({ main: AdapterId, reviewer: AdapterId, advisor: AdapterId }).optional(),
  models: z.strictObject({ main: z.string().max(128).optional(), reviewer: z.string().max(128).optional(), advisor: z.string().max(128).optional() }).optional(),
})
export type PersonalBinding = z.infer<typeof PersonalBinding>
export const PersonalPlanRequest = z.strictObject({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u), binding: PersonalBinding, sources: PlanSources,
  inlinePrompt: z.string().min(1).max(16_000).optional(),
  boardContext: z.string().max(16_000).optional(),
  methodBlock: z.string().max(8_000).optional(),
  noChecks: z.literal(true).optional(),
  notifyFeishuChatId: z.string().max(128).optional(),
})
export type PersonalPlanRequest = z.infer<typeof PersonalPlanRequest>
export const RunDispatch = z.strictObject({
  personal: z.strictObject({ role: z.enum(['main', 'reviewer', 'advisor']), binding: PersonalBinding,
    projectId: PersonalPlanRequest.shape.projectId.optional(), planSources: PlanSources.optional(), execution: PersonalItemExecution.optional(),
    gate: PersonalGate.optional(), delivery: PersonalDelivery.optional(), repair: z.literal(true).optional(),
    inlinePrompt: z.string().max(16_000).optional(), boardContext: z.string().max(16_000).optional(),
    methodBlock: z.string().max(8_000).optional(), noChecks: z.literal(true).optional(),
    expectedTree: PersonalPlanReceipt.shape.head.optional() }).optional(),
  harness: HarnessDirective.optional(),
  taskId: TaskId, runId: RunId, taskNo: z.number().int(), attempt: z.number().int().positive(),
  adapter: AdapterId,
  workspaceId: z.string(),
  subdir: z.string().max(256).optional(),       // 相对工作区根目录，Worker 侧做穿越校验（06 §6.3）
  profile: Profile,                             // Worker 侧再 clamp 到 workspace.maxProfile
  prompt: z.string().min(1).max(100_000),
  attachments: z.array(RunAttachment).max(8).optional(),
  resume: z.strictObject({ cliSessionId: z.string().max(256) }).optional(),
  model: z.string().max(128).optional(),
  timeoutMs: z.number().int().min(10_000).max(24 * 3600_000),
  idleTimeoutMs: z.number().int().min(10_000),
  notAfter: z.number().int(),                   // Hub 时钟；Worker 校正偏移后若 now > notAfter 则拒单 EXPIRED
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(4096)).optional(), // 仅 Worker 白名单键生效
  extraArgs: z.array(z.string().max(512)).max(32).optional(),   // 仅 Worker 白名单参数生效
  origin: z.strictObject({ source: z.enum(['feishu', 'dashboard', 'api']), actorType: z.enum(['owner', 'requester']) }),
})

export const RunCancel = z.strictObject({
  runId: RunId,
  reason: z.enum(['user', 'input_timeout', 'stale_run', 'hub_backstop', 'worker_revoked']),
  force: z.boolean(),                           // true = 跳过优雅期直接强杀进程树
  graceMs: z.number().int().min(0).max(60_000), // 默认 5000
})

export const RunInput = z.strictObject({ runId: RunId, requestId: z.string(), answer: z.string().max(20_000) })
export const WorkerDrain = z.strictObject({ drain: z.boolean(), reason: z.string().max(256).optional() })
export const WorkerProbe = z.strictObject({ adapters: z.array(AdapterId).optional() })
export const ProjectRelease = z.strictObject({ projectId: PersonalPlanRequest.shape.projectId, workspaceId: z.string().min(1), root: z.string().min(1), subdir: z.string().max(256).optional() })
export const ProjectPreflight = z.strictObject({
  workspaceId: WorkspaceId,
  subdir: z.string().max(256).optional(),
  mode: z.enum(['strict', 'flexible']).optional(),
  autoCommit: z.boolean().optional(),
  autoPush: z.boolean().optional(),
})
export const ProjectRebaseline = z.strictObject({
  projectId: PersonalPlanRequest.shape.projectId,
  binding: PersonalBinding,
  legacyChecksDigest: PersonalPlanReceipt.shape.checksDigest,
  noChecks: z.literal(true).optional(),
})

export const CmdAck = z.strictObject({
  refId: FrameId,                               // 被确认命令帧的 id
  ok: z.boolean(),
  error: z.strictObject({
    code: z.enum(['NO_SLOT', 'DRAINING', 'WORKSPACE_UNKNOWN', 'WORKSPACE_BUSY', 'ADAPTER_UNAVAILABLE',
      'PROFILE_NOT_ALLOWED', 'PATH_REJECTED', 'EXPIRED', 'INVALID', 'RUN_NOT_FOUND', 'INTERNAL']),
    message: z.string().max(512),
  }).optional(),
  result: z.strictObject({
    runState: RunResumeState.shape.state.optional(),
    releasedProject: PersonalPlanRequest.shape.projectId.optional(),
    preflight: z.strictObject({
      ok: z.boolean(),
      binding: PersonalBinding.optional(),
      checks: z.array(z.string().max(64)).max(16).optional(),
      noChecks: z.boolean().optional(),
      error: z.string().max(512).optional(),
    }).optional(),
    rebaseline: z.strictObject({
      checksDigest: PersonalPlanReceipt.shape.checksDigest,
      checksDigestVersion: z.literal(2),
    }).optional(),
  }).optional(),
})

export type RunDispatch = z.infer<typeof RunDispatch>
export type RunCancel = z.infer<typeof RunCancel>
export type RunInput = z.infer<typeof RunInput>
export type WorkerDrain = z.infer<typeof WorkerDrain>
export type WorkerProbe = z.infer<typeof WorkerProbe>
export type ProjectPreflight = z.infer<typeof ProjectPreflight>
export type ProjectRebaseline = z.infer<typeof ProjectRebaseline>
export type CmdAck = z.infer<typeof CmdAck>
