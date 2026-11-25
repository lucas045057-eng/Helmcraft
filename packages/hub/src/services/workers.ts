import type { Actor, CmdAckPayload, HubCommand, ResumeDirective, RunEventsFrame, RunGapFrame, WorkerHello, WorkerView } from '@agent-hub/protocol'
export const activeRunStatuses = ['dispatching', 'running', 'awaiting_input', 'cancelling'] as const

export interface WorkerInboundHandler {
  onRunEvents(workerId: string, frame: RunEventsFrame): Promise<{ ackSeq: number }>
  onRunGap(workerId: string, frame: RunGapFrame): Promise<{ ackSeq: number }>
  onCommandAck(workerId: string, cmd: HubCommand, ack: CmdAckPayload): void
  reconcile(workerId: string, hello: WorkerHello): Promise<ResumeDirective[]>
  onWorkerOffline(workerId: string, at: number, revoked?: boolean): void
}
export interface WorkerGateway {
  readonly bootId: string
  readonly startedAt: number
  readonly gracePeriodMs: number
  metrics(): { workerConnections: number; workerBadFrames: number }
  list(): WorkerView[]
  get(workerId: string): WorkerView | undefined
  capabilities(workerId: string): readonly string[]
  isOnline(workerId: string): boolean
  send(workerId: string, command: HubCommand): Promise<CmdAckPayload>
  setDrain(workerId: string, drain: boolean, actor: Actor): Promise<void>
  revoke(workerId: string, actor: Actor): Promise<void>
  setInboundHandler(handler: WorkerInboundHandler): () => void
}
