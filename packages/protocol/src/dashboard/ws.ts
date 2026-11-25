import { WorkspacePointerView } from './harness.js'
import { z } from 'zod'
import { ErrorCode } from '../common.js'
import { HubSystemStatus, LogEntry, Overview, RunView, TaskDetail, TaskSummary, WorkerView } from './dto.js'

export const Topic = z.union([
  z.literal('overview'), z.literal('workers'), z.literal('tasks'),
  z.string().regex(/^task:tsk_[0-9A-HJKMNP-TV-Z]{26}$/),
])

export const DashClientFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('hello'), resume: z.strictObject({ bootId: z.string(), eventSeq: z.number().int() }).optional() }),
  z.strictObject({ t: z.literal('subscribe'), topics: z.array(Topic).max(32) }),
  z.strictObject({ t: z.literal('unsubscribe'), topics: z.array(Topic).max(32) }),
  z.strictObject({ t: z.literal('follow'), runId: z.string(), fromSeq: z.number().int().nonnegative() }),  // 日志跟随
  z.strictObject({ t: z.literal('unfollow'), runId: z.string() }),
  z.strictObject({ t: z.literal('ping'), n: z.number().int() }),
])

export const DashEventType = z.enum([
  'task.created',        // data: TaskSummary              topic: tasks（及 task:<id>）
  'task.updated',        // data: TaskSummary              topic: tasks, task:<id>
  'task.detail',         // data: TaskDetail               topic: task:<id>（仅订阅了该任务详情的连接）
  'run.updated',         // data: RunView                  topic: task:<id>
  'workspace.updated',
  'worker.updated',      // data: WorkerView               topic: workers
  'worker.removed',      // data: { id }                   topic: workers
  'overview.updated',    // data: Overview（≤1 次/秒节流）  topic: overview
  'system.status',       // data: Overview['hub'] & { feishu } topic: overview
])

const EventBase = z.strictObject({ t: z.literal('event'), eventSeq: z.number().int(), topic: z.string() })
function event<const T extends DashEventType, P extends z.ZodType>(type: T, data: P) {
  return EventBase.extend({ type: z.literal(type), data })
}

export const DashEventFrame = z.discriminatedUnion('type', [
  event('task.created', TaskSummary),
  event('task.updated', TaskSummary),
  event('task.detail', TaskDetail),
  event('run.updated', RunView),
  event('workspace.updated', WorkspacePointerView),
  event('worker.updated', WorkerView),
  event('worker.removed', z.strictObject({ id: z.string() })),
  event('overview.updated', Overview),
  event('system.status', HubSystemStatus),
])

const DashControlFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('welcome'), bootId: z.string(), eventSeq: z.number().int(), serverTime: z.number().int(),
    resumed: z.boolean() }),             // resumed=true 表示随后补发错过的事件；false 表示客户端需重新拉快照
  z.strictObject({ t: z.literal('snapshot'), eventSeq: z.number().int(), overview: Overview,
    workers: z.array(WorkerView), activeTasks: z.array(TaskSummary) }),   // subscribe 'overview'/'workers'/'tasks' 后发送
  z.strictObject({ t: z.literal('logs'), runId: z.string(), entries: z.array(LogEntry), live: z.boolean() }),
  z.strictObject({ t: z.literal('logs.reset'), runId: z.string(), reason: z.enum(['slow_consumer', 'run_not_found', 'server_restart']),
    resumeFromSeq: z.number().int() }),
  z.strictObject({ t: z.literal('resync'), reason: z.enum(['gap_too_large', 'slow_consumer', 'boot_changed']) }),
  z.strictObject({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number().int() }),
  z.strictObject({ t: z.literal('error'), code: ErrorCode, message: z.string() }),
])


export const DashServerFrame = z.union([DashControlFrame, DashEventFrame])

export const DASHBOARD_SUBPROTOCOL = 'agent-hub.dashboard.v1'
export const DashboardCloseCode = { GOING_AWAY: 1001, SESSION_EXPIRED: 4001, TIMEOUT: 4008, RATE_LIMITED: 4029 } as const


export type Topic = z.infer<typeof Topic>
export type DashClientFrame = z.infer<typeof DashClientFrame>
export type DashEventType = z.infer<typeof DashEventType>
export type DashEventFrame = z.infer<typeof DashEventFrame>
export type DashServerFrame = z.infer<typeof DashServerFrame>
