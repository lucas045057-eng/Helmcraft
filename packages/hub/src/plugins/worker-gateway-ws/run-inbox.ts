import type { RunEventsFrame, RunGapFrame } from '@agent-hub/protocol'
import type { WorkerInboundHandler } from '../../services/workers.js'
import type { RunRow } from '../../services/store.js'
export class RunInbox {
  constructor(private readonly run: (id: string) => RunRow | undefined) {}
  async receive(workerId: string, frame: RunEventsFrame | RunGapFrame, handler: WorkerInboundHandler):
    Promise<{ ackSeq?: number; fromSeq?: number; stale?: boolean }> {
    const run = this.run(frame.runId)
    if (!run || run.workerId !== workerId || run.status === 'lost' || run.status === 'refused' || ('taskId' in frame && frame.taskId !== run.taskId)) {
      return { stale: true, ackSeq: 'events' in frame ? frame.events.at(-1)!.seq : frame.toSeq }
    }
    if ('events' in frame) {
      const events = frame.events.filter(event => event.seq > run.lastSeq)
      if (!events.length) return { ackSeq: run.lastSeq }
      if (events[0]!.seq !== run.lastSeq + 1) return { fromSeq: run.lastSeq + 1 }
      return handler.onRunEvents(workerId, { ...frame, events })
    }
    if (frame.toSeq <= run.lastSeq) return { ackSeq: run.lastSeq }
    if (frame.fromSeq > run.lastSeq + 1) return { fromSeq: run.lastSeq + 1 }
    return handler.onRunGap(workerId, { ...frame, fromSeq: run.lastSeq + 1 })
  }
}
