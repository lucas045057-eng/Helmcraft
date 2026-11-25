import { z } from 'zod'
import { FrameId } from '../common.js'
import { HubChallenge, HubReject, HubWelcome, WorkerHello } from './handshake.js'
import { HubHeartbeatAck, WorkerBye, WorkerHeartbeat, WorkerState } from './heartbeat.js'
import { CmdAck, ProjectRelease, RunCancel, RunDispatch, RunInput, WorkerDrain, WorkerProbe } from './commands.js'
import { RunAckFrame, RunEventsFrame, RunGapFrame, RunResendFrame } from './run-events.js'

export { FrameId, RunId, TaskId, WorkerId } from '../common.js'

export const PROTOCOL_VERSION = 1 as const
export const Envelope = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  id: FrameId,
  type: z.string(),
  ts: z.number().int().nonnegative(),
  payload: z.json(),
})

function frame<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return Envelope.extend({ type: z.literal(type), payload })
}

export const HubCommand = z.discriminatedUnion('type', [
  frame('run.dispatch', RunDispatch),
  frame('run.cancel', RunCancel),
  frame('run.input', RunInput),
  frame('worker.drain', WorkerDrain),
  frame('worker.probe', WorkerProbe),
  frame('project.release', ProjectRelease),
])

export const HubToWorkerFrame = z.discriminatedUnion('type', [
  frame('hub.challenge', HubChallenge),
  frame('hub.welcome', HubWelcome),
  frame('hub.reject', HubReject),
  frame('hub.heartbeat_ack', HubHeartbeatAck),
  HubCommand,
  frame('run.ack', RunAckFrame),
  frame('run.resend', RunResendFrame),
])

export const WorkerToHubFrame = z.discriminatedUnion('type', [
  frame('worker.hello', WorkerHello),
  frame('worker.heartbeat', WorkerHeartbeat),
  frame('worker.state', WorkerState),
  frame('worker.bye', WorkerBye),
  frame('cmd.ack', CmdAck),
  frame('run.events', RunEventsFrame),
  frame('run.gap', RunGapFrame),
])

export type CmdAckPayload = z.infer<typeof CmdAck>


export type Envelope = z.infer<typeof Envelope>
export type HubCommand = z.infer<typeof HubCommand>
export type HubToWorkerFrame = z.infer<typeof HubToWorkerFrame>
export type WorkerToHubFrame = z.infer<typeof WorkerToHubFrame>
