import { z } from 'zod'
import { AdapterId, MIN_WORKER_WINDOW_BYTES, Capability, KNOWN_CAPABILITIES, Profile, WorkspaceId } from '@agent-hub/protocol'
const positive = z.number().int().positive()
const ms = (value: number) => positive.default(value)
const timeout = z.number().int().min(10_000).max(86_400_000)
const AutoFix = z.union([z.literal(0), z.literal(1), z.literal(2)])
const HarnessWorkspacePolicy = z.strictObject({
  enabled: z.boolean().optional(), blackboard: z.boolean().optional(), allowRequesterBlackboard: z.boolean().optional(),
  verify: z.boolean().optional(), allowRequesterVerify: z.boolean().optional(), autoFixMaxRetries: AutoFix.optional(),
})
export const HubConfigSchema = z.strictObject({
  permissions: z.strictObject({
    allowRequesterCommands: z.boolean().default(false), autoApproveAll: z.boolean().default(false),
    disableResultGating: z.boolean().default(false), disableRequesterLimits: z.boolean().default(false),
    allowRequesterAutoAccept: z.boolean().default(false), allowRequesterHandoff: z.boolean().default(false),
  }).prefault({}),
  server: z.strictObject({ host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65_535).default(8080),
    publicUrl: z.url().default('http://localhost:8080'), trustProxy: z.array(z.string()).default([]),
    allowInsecureWorker: z.boolean().default(false), timezone: z.string().refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
    }, 'Invalid IANA timezone').default('Asia/Shanghai'), shutdownTimeoutMs: ms(15_000) }).prefault({}),
  storage: z.strictObject({ path: z.string().default('data/hub.sqlite'), ingest: z.strictObject({
    batchMs: ms(50), batchRows: ms(500), maxQueueRows: ms(50_000),
  }).prefault({}) }).prefault({}),
  harness: z.strictObject({
    enabled: z.boolean().default(true),
    defaults: z.strictObject({
      blackboard: z.boolean().default(true), allowRequesterBlackboard: z.boolean().default(false),
      verify: z.boolean().default(true), allowRequesterVerify: z.boolean().default(false), autoFixMaxRetries: AutoFix.default(0),
    }).prefault({}),
    workspaces: z.record(WorkspaceId, HarnessWorkspacePolicy).default({}),
  }).prefault({}),
  workers: z.strictObject({ capabilities: z.array(Capability).max(16).default([...KNOWN_CAPABILITIES]), path: z.string().regex(/^\/[^?#]+$/).default('/ws/worker'), heartbeatIntervalMs: ms(10_000),
    heartbeatTimeoutMs: ms(30_000), gracePeriodMs: ms(90_000), handshakeTimeoutMs: ms(5000), maxFrameBytes: z.number().int().min(MIN_WORKER_WINDOW_BYTES).max(1 << 20).default(1 << 20),
    maxInFlightBytes: z.number().int().min(MIN_WORKER_WINDOW_BYTES).default(4 << 20), ackIntervalMs: ms(200), cmdAckTimeoutMs: ms(10_000),
    maxResends: z.number().int().nonnegative().default(3),
    rateLimits: z.strictObject({ upgradesPerMinute: ms(20), maxUnauthenticated: ms(64), framesPerSecond: ms(200),
      bytesPerSecond: ms(8 << 20) }).prefault({}), redactionPatterns: z.array(z.string().max(256)).max(64).default([]) }).prefault({}),
  orchestrator: z.strictObject({
    scheduler: z.strictObject({ tickMs: ms(2000), scanLimit: ms(200),
      defaultAdapterOrder: z.array(AdapterId).default(['claude-code', 'codex', 'gemini', 'opencode', 'antigravity', 'mock']),
      refuseBackoffMs: ms(60_000), unschedulableWarnMs: ms(60_000) }).prefault({}),
    tasks: z.strictObject({ defaultTimeoutMs: timeout.default(1_800_000), idleTimeoutMs: timeout.default(600_000),
      approvalTimeoutMs: ms(86_400_000), inputTimeoutMs: ms(3_600_000), cancelAckTimeoutMs: ms(30_000),
      dispatchAckTimeoutMs: ms(10_000), maxDispatchResends: z.number().int().nonnegative().default(3),
      maxAttempts: ms(3), maxPromptChars: z.number().int().min(1).max(32_000).default(32_000) }).prefault({}),
    limits: z.strictObject({ maxActivePerRequester: ms(2), requesterTasksPerHour: ms(20) }).prefault({}),
  }).prefault({}),
  retention: z.strictObject({ sliceIntervalMs: positive.max(2_147_483_647).default(10_000), sliceRows: positive.max(5000).default(5000),
    backupDir: z.string().min(1).optional() }).prefault({}),
  logs: z.strictObject({ maxBytesPerRun: ms(20 << 20), maxDbBytes: ms(10 * 1024 ** 3),
    retentionDays: z.strictObject({ succeeded: ms(30), other: ms(90) }).prefault({}) }).prefault({}),
  dashboard: z.strictObject({ allowedOrigins: z.array(z.url()).default([]), sessionTtlMs: ms(43_200_000), distDir: z.string().min(1).optional() }).prefault({}),
  feishu: z.strictObject({
    enabled: z.boolean().default(false), domain: z.enum(['feishu', 'lark']).default('feishu'),
    ownerOpenIds: z.array(z.string()).default([]), requesterAllowlist: z.array(z.string()).default([]),
    requesterPolicy: z.enum(['allowlist', 'chat']).default('allowlist'), allowedChatIds: z.array(z.string()).default([]),
    requesterReplyPolicy: z.enum(['auto', 'owner_review']).default('auto'), approvalTarget: z.literal('owner_p2p').default('owner_p2p'),
    deliveryMode: z.enum(['hybrid', 'card']).default('card'), groupAudience: z.enum(['requester', 'owner']).default('requester'),
    allowGroupCommands: z.boolean().default(false), defaultProfile: Profile.optional(),
    defaultWorkspaceId: WorkspaceId.optional(), methodSuggestions: z.boolean().default(true), chatDefaults: z.record(z.string(), z.strictObject({
      workspaceId: WorkspaceId.optional(), adapter: AdapterId.optional(), profile: Profile.optional(),
      subdir: z.string().max(128).optional(),            // 本群默认进入的项目文件夹（工作区内一级子目录）
    })).default({}), staleMessageMs: ms(600_000),
    card: z.strictObject({ minPatchIntervalMs: ms(3000), minPatchIntervalHighMs: ms(1000), globalPatchQps: ms(5),
      cardMaxBytes: z.number().int().min(512).max(30 * 1024).default(28 * 1024), cardResultMaxChars: ms(2000) }).prefault({}),
    multimodal: z.strictObject({
      enabled: z.boolean().default(false),
      maxFileBytes: z.number().int().min(1024).max(20 << 20).default(10 << 20),
      inlineMaxBytes: z.number().int().min(1024).max(550_000).default(512_000),
      asrUrl: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Expected HTTP/HTTPS URL').optional(),
      asrModel: z.string().max(128).default('whisper-1'),
      asrApiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).optional(),
      asrTimeoutMs: positive.max(60_000).default(20_000),
    }).prefault({}),
    smartRouting: z.strictObject({
      enabled: z.boolean().default(false),
      autoReplyInThread: z.boolean().default(false),
      rememberProject: z.boolean().default(true),
      autoSelectAdapter: z.boolean().default(true),
      proposeAutopilot: z.boolean().default(true),
    }).prefault({}),
    autopilot: z.strictObject({
      notifyChatIds: z.array(z.string()).default([]),
    }).prefault({}),
  }).prefault({}),
  steward: z.strictObject({
    enabled: z.boolean().default(false),
    patrolIntervalMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
    briefingHour: z.number().int().min(0).max(23).default(9),
    briefingMinute: z.number().int().min(0).max(59).default(0),
    notifyChatIds: z.array(z.string()).default([]),
  }).prefault({}),
})
export type HubConfig = z.output<typeof HubConfigSchema>
export type HubConfigInput = z.input<typeof HubConfigSchema>
