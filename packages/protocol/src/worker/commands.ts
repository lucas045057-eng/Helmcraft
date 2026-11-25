import { HarnessDirective } from './harness.js'
import { z } from 'zod'
import { AdapterId, FrameId, Profile, RunId, TaskId } from '../common.js'
import { RunResumeState } from './handshake.js'
export const RunDispatch = z.strictObject({
  harness: HarnessDirective.optional(),
  taskId: TaskId, runId: RunId, taskNo: z.number().int(), attempt: z.number().int().positive(),
  adapter: AdapterId,
  workspaceId: z.string(),
  subdir: z.string().max(256).optional(),       // 相对工作区根目录，Worker 侧做穿越校验（06 §6.3）
  profile: Profile,                             // Worker 侧再 clamp 到 workspace.maxProfile
  prompt: z.string().min(1).max(100_000),
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

export const CmdAck = z.strictObject({
  refId: FrameId,                               // 被确认命令帧的 id
  ok: z.boolean(),
  error: z.strictObject({
    code: z.enum(['NO_SLOT', 'DRAINING', 'WORKSPACE_UNKNOWN', 'WORKSPACE_BUSY', 'ADAPTER_UNAVAILABLE',
      'PROFILE_NOT_ALLOWED', 'PATH_REJECTED', 'EXPIRED', 'INVALID', 'RUN_NOT_FOUND', 'INTERNAL']),
    message: z.string().max(512),
  }).optional(),
  result: z.strictObject({ runState: RunResumeState.shape.state.optional() }).optional(),
})

export type RunDispatch = z.infer<typeof RunDispatch>
export type RunCancel = z.infer<typeof RunCancel>
export type RunInput = z.infer<typeof RunInput>
export type WorkerDrain = z.infer<typeof WorkerDrain>
export type WorkerProbe = z.infer<typeof WorkerProbe>
export type CmdAck = z.infer<typeof CmdAck>
