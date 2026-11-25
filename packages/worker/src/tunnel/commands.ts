import { Lru } from '@agent-hub/common'
import type { Clock } from '@agent-hub/common'
import { HubCommand } from '@agent-hub/protocol'
import type { CmdAckPayload } from '@agent-hub/protocol'
import { WorkerError, type RunManager } from '../runner/run-manager.js'
import type { AdapterRegistry } from '../adapters/registry.js'

export class Commands {
  private readonly seenCmdIds: Lru<string, CmdAckPayload>
  constructor(clock: Clock, private readonly runs: RunManager, private readonly adapters: AdapterRegistry,
    private readonly hubNow: () => number, private readonly sendAck: (ack: CmdAckPayload) => void,
    private readonly capabilitiesChanged: () => void) {
    this.seenCmdIds = new Lru(10_000, 3_600_000, clock)
  }
  handle(input: unknown) {
    const command = HubCommand.safeParse(input)
    if (!command.success) return false
    const { id, type, payload } = command.data
    const previous = this.seenCmdIds.get(id)
    if (previous) { this.sendAck(previous); return true }
    let ack: CmdAckPayload = { refId: id, ok: true }
    let launch: (() => void) | undefined
    try {
      switch (type) {
        case 'run.dispatch': {
          const runState = this.runs.seen(payload.runId)
          if (runState) ack.result = { runState }
          else launch = this.runs.accept(payload, this.hubNow())
          break
        }
        case 'run.cancel': this.runs.cancel(payload); break
        case 'run.input': this.runs.provide(payload); break
        case 'worker.drain': this.runs.hubDrain = payload.drain; break
        case 'project.release':
          this.runs.releaseProject(payload)
          ack.result = {releasedProject:payload.projectId}
          break
        case 'worker.probe':
          void this.adapters.probe(payload.adapters).then(this.capabilitiesChanged, () => undefined)
          break
      }
    } catch (error) {
      ack = { refId: id, ok: false, error: { code: error instanceof WorkerError ? error.code : 'INTERNAL',
        message: error instanceof WorkerError ? error.message : 'Command processing failed' } }
    }
    this.seenCmdIds.set(id, ack)
    this.sendAck(ack)
    if (launch) queueMicrotask(launch)
    return true
  }
}
