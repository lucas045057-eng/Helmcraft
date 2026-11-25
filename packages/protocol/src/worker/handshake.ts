import { Capability } from './capabilities.js'
import { z } from 'zod'
import { AdapterId, Profile, RunId, TaskId, WorkerId, WorkspaceId } from '../common.js'
export const HubChallenge = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),            // 32B base64url
  hubBootId: z.string().min(8).max(64),
  serverTime: z.number().int(),
  protocolVersions: z.array(z.number().int()).nonempty(),
})

export const AdapterCapability = z.strictObject({
  id: AdapterId,
  status: z.enum(['ready', 'missing', 'error']),
  version: z.string().max(64).optional(),
  binPath: z.string().max(512).optional(),      // 仅用于面板诊断展示
  features: z.strictObject({
    resume: z.boolean(),
    liveInput: z.boolean(),
    structuredOutput: z.boolean(),
  }),
  error: z.string().max(512).optional(),
})

export const WorkspaceDecl = z.strictObject({
  id: WorkspaceId,
  label: z.string().max(128),
  // 注意：绝不上报本机绝对路径（仅上报 label），路径只存在于 worker.yaml
  allowedAdapters: z.array(AdapterId).nonempty(),
  maxProfile: Profile,
  maxConcurrent: z.number().int().min(1).max(16),
  isGitRepo: z.boolean(),
})

export const RunResumeState = z.strictObject({
  runId: RunId,
  taskId: TaskId,
  state: z.enum(['starting', 'running', 'awaiting_input', 'cancelling', 'finished']),
  lastSeq: z.number().int().nonnegative(),      // Worker 已生成的最大 seq
  oldestBufferedSeq: z.number().int().nonnegative(), // Worker 缓冲中最小的可补发 seq（0=无缓冲）
})

export const WorkerHello = z.strictObject({
  auth: z.strictObject({
    workerId: WorkerId,
    keyFingerprint: z.string().max(32),
    clientNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),    // 16B base64url
    signature: z.string().max(128),
  }),
  agent: z.strictObject({
    version: z.string().max(32),
    hostname: z.string().max(255),
    os: z.enum(['win32', 'darwin', 'linux']),
    arch: z.string().max(16),
    nodeVersion: z.string().max(32),
    pid: z.number().int(),
  }),
  maxConcurrency: z.number().int().min(1).max(32),
  adapters: z.array(AdapterCapability).max(16),
  workspaces: z.array(WorkspaceDecl).max(128),
  runs: z.array(RunResumeState).max(64),
  drain: z.boolean(),
  lastHubBootId: z.string().optional(),
})

export const ResumeDirective = z.strictObject({
  runId: RunId,
  action: z.enum(['resume', 'discard', 'cancel']),
  ackSeq: z.number().int().nonnegative(),       // Hub 已持久化的最大连续 seq
})

export const MIN_WORKER_WINDOW_BYTES = 64 << 10
export const HubWelcome = z.strictObject({
  capabilities: z.array(Capability).max(16).optional(),
  sessionId: z.string(),
  connectionEpoch: z.number().int().positive(),
  serverTime: z.number().int(),
  heartbeatIntervalMs: z.number().int(),        // 默认 10000
  heartbeatTimeoutMs: z.number().int(),         // 默认 30000
  ackIntervalMs: z.number().int(),              // 默认 200
  maxFrameBytes: z.number().int(),              // 默认 1 MiB
  maxInFlightBytes: z.number().int(),           // 默认 4 MiB
  maxLogEntryBytes: z.number().int(),           // 默认 16 KiB
  resume: z.array(ResumeDirective),
  drain: z.boolean(),                           // Hub 侧 drain 状态
  redactionPatterns: z.array(z.string()).max(64), // Hub 下发的附加脱敏正则（与本地内置合并）
})

export const HubReject = z.strictObject({
  code: z.enum(['AUTH_FAILED', 'WORKER_REVOKED', 'UNSUPPORTED_VERSION', 'RATE_LIMITED', 'BAD_FRAME', 'HUB_ERROR']),
  message: z.string().max(256),
  retryAfterMs: z.number().int().optional(),
})

export type HubChallenge = z.infer<typeof HubChallenge>
export type AdapterCapability = z.infer<typeof AdapterCapability>
export type WorkspaceDecl = z.infer<typeof WorkspaceDecl>
export type RunResumeState = z.infer<typeof RunResumeState>
export type WorkerHello = z.infer<typeof WorkerHello>
export type ResumeDirective = z.infer<typeof ResumeDirective>
export type HubWelcome = z.infer<typeof HubWelcome>
export type HubReject = z.infer<typeof HubReject>
