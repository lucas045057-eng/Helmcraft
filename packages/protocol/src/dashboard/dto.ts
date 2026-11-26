import { TaskMethod } from './methods.js'
import { RunHarnessSummary } from './harness.js'
import { Capability } from '../worker/capabilities.js'
import { VerificationState } from '../harness/enums.js'
import { z } from 'zod'
import { ResultDeliveryStatus, TaskAction, RunId, TaskId } from '../common.js'
import { TaskStatus, RunStatus } from '../task.js'
import { AdapterCapability, WorkspaceDecl } from '../worker/handshake.js'
export const ActorView = z.strictObject({
  type: z.enum(['owner', 'requester', 'system', 'worker']),
  id: z.string(), name: z.string().optional(),
  channel: z.enum(['feishu', 'dashboard', 'api', 'system']),
})

export const TaskOrigin = z.strictObject({
  source: z.enum(['feishu', 'dashboard', 'api']),
  feishu: z.strictObject({ chatId: z.string(), chatType: z.enum(['p2p', 'group']), chatName: z.string().optional(),
    messageId: z.string() }).optional(),
})

export const TaskSummary = z.strictObject({
  verification: VerificationState.optional(),
  id: z.string(), taskNo: z.number().int(), version: z.number().int(),
  title: z.string(),                         // prompt 前 80 字符（脱敏）
  status: TaskStatus,
  priority: z.number().int(),
  requester: ActorView, origin: TaskOrigin,
  adapter: z.string().nullable(), workspaceId: z.string(), profile: z.enum(['readonly', 'edit', 'full']),
  subdir: z.string().nullable().optional(),  // 工作区内的项目子目录；null = 工作区根
  workerId: z.string().nullable(),           // 当前/最后一次 Run 的 Worker
  attempt: z.number().int(), maxAttempts: z.number().int(),
  parentTaskId: z.string().nullable(),
  lastProgress: z.string().nullable(),       // 最新一行进展（≤ 200 字符）
  scheduleHint: z.string().nullable(),       // 不可调度原因
  workerConnection: z.enum(['online', 'suspect', 'offline']).nullable(), // 当前 Run 所在 Worker 的连接状态
  graceUntil: z.number().int().nullable(),   // 宽限期截止
  errorCode: z.string().nullable(),
  resultDeliveryStatus: ResultDeliveryStatus,
  createdAt: z.number().int(), updatedAt: z.number().int(),
  startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
  allowedActions: z.array(TaskAction), // 由共享 reducer 计算
})

export const RunView = z.strictObject({
  harness: RunHarnessSummary.optional(),
  id: z.string(), taskId: z.string(), attempt: z.number().int(),
  workerId: z.string(), adapter: z.string(), workspaceId: z.string(), profile: z.string(),
  status: RunStatus, pid: z.number().int().nullable(), cliVersion: z.string().nullable(),
  cliSessionId: z.string().nullable(),
  exitCode: z.number().int().nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
  usage: z.strictObject({ inputTokens: z.number().optional(), outputTokens: z.number().optional(),
    costUsd: z.number().optional() }).nullable(),
  lastSeq: z.number().int(), logBytes: z.number().int(), logDroppedBytes: z.number().int(),
  dispatchedAt: z.number().int(), startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
})

export const TaskDetail = TaskSummary.extend({
  method: TaskMethod.omit({ block: true }).optional(),
  handoff: z.strictObject({ fromRunId: RunId, fromTaskId: TaskId, fromTaskNo: z.number().int(), intent: z.enum(['relay', 'fix']) }).optional(),
  prompt: z.string(),
  resultSummary: z.string().nullable(),
  runs: z.array(RunView),
  inputRequest: z.strictObject({ requestId: z.string(), question: z.string(), options: z.array(z.string()).optional(),
    expiresAt: z.number().int() }).nullable(),
  policyDecision: z.strictObject({ ruleId: z.string().nullable(), decision: z.string(), clampedProfile: z.string().optional() }),
  timeline: z.array(z.strictObject({ ts: z.number().int(), event: z.string(), from: z.string().nullable(),
    to: z.string().nullable(), actor: ActorView, note: z.string().optional() })),  // 来自 audit_logs
  children: z.array(z.strictObject({ id: z.string(), taskNo: z.number().int(), status: TaskStatus })),
})

export const LogEntry = z.strictObject({
  seq: z.number().int(), ts: z.number().int(),
  kind: z.enum(['started', 'log', 'agent', 'session', 'progress', 'input_request', 'dropped', 'gap', 'finished', 'system', 'harness', 'workspace', 'verify']),
  stream: z.enum(['stdout', 'stderr', 'system']).nullable(),
  text: z.string().nullable(),
  data: z.json(),              // agent 事件、finished 详情、gap 区间等
})

export const WorkerView = z.strictObject({
  protocolCapabilities: z.array(Capability).max(16).optional(),
  id: z.string(), displayName: z.string(),
  status: z.enum(['active', 'revoked']),
  connection: z.enum(['online', 'suspect', 'offline']),
  drain: z.boolean(), drainSource: z.enum(['hub', 'worker']).nullable(),
  hostname: z.string().nullable(), os: z.string().nullable(), arch: z.string().nullable(), agentVersion: z.string().nullable(),
  maxConcurrency: z.number().int(), slotsUsed: z.number().int(),
  rttMs: z.number().nullable(),
  load: z.strictObject({ cpuPercent: z.number().optional(), memFreeMb: z.number(), memTotalMb: z.number() }).nullable(),
  adapters: z.array(AdapterCapability),      // 见 03
  workspaces: z.array(WorkspaceDecl),
  activeRunIds: z.array(z.string()),
  graceUntil: z.number().int().nullable(),
  bufferedBytes: z.number().int(), droppedLogBytesTotal: z.number().int(),
  lastSeenAt: z.number().int().nullable(), connectedAt: z.number().int().nullable(),
})

export const StorageLevel = z.enum(['ok', 'warning', 'critical'])
export type StorageLevel = z.infer<typeof StorageLevel>

export const Overview = z.strictObject({
  workersOnline: z.number().int(), workersTotal: z.number().int(),
  slotsUsed: z.number().int(), slotsTotal: z.number().int(),
  counts: z.record(TaskStatus, z.number().int()),      // 当前各状态任务数
  today: z.strictObject({ succeeded: z.number().int(), failed: z.number().int(), cancelled: z.number().int(),
    successRate: z.number().nullable(), p50DurationMs: z.number().nullable(), p90DurationMs: z.number().nullable() }),
  feishu: z.strictObject({ state: z.enum(['disabled', 'connecting', 'connected', 'reconnecting', 'failed']), since: z.number().int() }),
  hub: z.strictObject({ bootId: z.string(), startedAt: z.number().int(), version: z.string(), draining: z.boolean(),
    restartRequired: z.boolean(), configError: z.string().nullable(), storageLevel: StorageLevel.optional() }),
})
export const HubSystemStatus = Overview.shape.hub.extend({ feishu: Overview.shape.feishu })
export type HubSystemStatus = z.infer<typeof HubSystemStatus>

export type ActorView = z.infer<typeof ActorView>
export type TaskOrigin = z.infer<typeof TaskOrigin>
export type TaskSummary = z.infer<typeof TaskSummary>
export type RunView = z.infer<typeof RunView>
export type TaskDetail = z.infer<typeof TaskDetail>
export type LogEntry = z.infer<typeof LogEntry>
export type WorkerView = z.infer<typeof WorkerView>
export type Overview = z.infer<typeof Overview>

export type TaskView = TaskSummary
export type TaskDetailView = TaskDetail
export type OverviewView = Overview
