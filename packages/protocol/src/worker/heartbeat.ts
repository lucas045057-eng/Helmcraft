import { z } from 'zod'
import { AdapterId, RunId } from '../common.js'
import { RunResumeState } from './handshake.js'
export const WorkerHeartbeat = z.strictObject({
  activeRuns: z.array(z.strictObject({
    runId: RunId,
    state: RunResumeState.shape.state,
    lastSeq: z.number().int(),
    pid: z.number().int().optional(),
  })).max(64),
  slotsUsed: z.number().int(),
  load: z.strictObject({
    cpuPercent: z.number().min(0).max(100).optional(), // 近 10s 采样
    memFreeMb: z.number().int(),
    memTotalMb: z.number().int(),
  }),
  adapters: z.partialRecord(AdapterId, z.enum(['ready', 'missing', 'error'])),
  bufferedBytes: z.number().int(),          // 未确认事件缓冲总字节
  droppedLogBytesTotal: z.number().int(),   // 自启动以来因背压丢弃的日志字节
})
export const HubHeartbeatAck = z.strictObject({ serverTime: z.number().int() })

export const WorkerState = z.strictObject({ drain: z.boolean(), reason: z.string().max(256).optional() })
export const WorkerBye = z.strictObject({
  reason: z.enum(['shutdown', 'restart', 'upgrade']),
  runningRuns: z.array(RunId),       // 仍在运行、即将被终止的 Run
})

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeat>
export type HubHeartbeatAck = z.infer<typeof HubHeartbeatAck>
export type WorkerState = z.infer<typeof WorkerState>
export type WorkerBye = z.infer<typeof WorkerBye>
