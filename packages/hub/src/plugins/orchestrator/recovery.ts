import type { ResumeDirective, WorkerHello } from '@agent-hub/protocol'
import type { RunRow } from '../../services/store.js'
const active = new Set(['dispatching', 'running', 'awaiting_input', 'cancelling'])
export async function reconcileWorker(workerId: string, hello: WorkerHello, runs: RunRow[], lookup: (id: string) => RunRow | undefined,
  onMissing: (run: RunRow) => Promise<unknown>, onImplicitAccept: (run: RunRow) => Promise<unknown>, now: number): Promise<ResumeDirective[]> {
  const seen = new Set(hello.runs.map(run => run.runId))
  for (const run of runs) {
    if (!seen.has(run.id) && (run.status !== 'dispatching' || run.notAfter < now)) await onMissing(run)
  }
  const directives: ResumeDirective[] = []
  for (const reported of hello.runs) {
    const run = lookup(reported.runId)
    if (!run || run.workerId !== workerId || run.taskId !== reported.taskId || run.status === 'lost' || run.status === 'refused') {
      directives.push({ runId: reported.runId, action: reported.state === 'finished' ? 'discard' : 'cancel', ackSeq: 0 })
      continue
    }
    if (run.status === 'dispatching') await onImplicitAccept(run)
    directives.push({ runId: run.id, action: active.has(run.status) ? 'resume' : 'discard', ackSeq: run.lastSeq })
  }
  return directives
}
