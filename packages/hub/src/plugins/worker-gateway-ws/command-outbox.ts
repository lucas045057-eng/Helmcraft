import type { CmdAckPayload, HubCommand } from '@agent-hub/protocol'
export class CommandTimeoutError extends Error {}
interface Pending {
  command: HubCommand
  sentAt: number | null
  sends: number
  resolve(ack: CmdAckPayload): void
  reject(error: Error): void
}
export class CommandOutbox {
  private readonly pending = new Map<string, Pending>()
  enqueue(command: HubCommand) {
    if (this.pending.size >= 4096) return Promise.reject(new CommandTimeoutError('Command queue full'))
    return new Promise<CmdAckPayload>((resolve, reject) => {
      if (this.pending.has(command.id)) { reject(new Error('Duplicate command id')); return }
      this.pending.set(command.id, { command, sentAt: null, sends: 0, resolve, reject })
    })
  }
  disconnected() { for (const entry of this.pending.values()) entry.sentAt = null }
  pump(send: (command: HubCommand, attempt: number) => void, now: number, timeout: number, maxResends: number) {
    for (const [id, entry] of this.pending) {
      if (entry.sentAt !== null && now - entry.sentAt < timeout) continue
      if (entry.sentAt !== null && entry.sends > maxResends) {
        this.pending.delete(id)
        entry.reject(new CommandTimeoutError('Worker did not confirm command'))
        continue
      }
      send(entry.command, entry.sends + 1)
      entry.sentAt = now
      entry.sends++
    }
  }
  drop(test: (command: HubCommand) => boolean) {
    for (const [id, entry] of this.pending) {
      if (!test(entry.command)) continue
      this.pending.delete(id)
      entry.reject(new CommandTimeoutError('Command is no longer applicable'))
    }
  }
  ack(ack: CmdAckPayload) {
    const entry = this.pending.get(ack.refId)
    if (!entry) return
    this.pending.delete(ack.refId)
    entry.resolve(ack)
    return entry.command
  }
  clear() {
    for (const entry of this.pending.values()) entry.reject(new CommandTimeoutError('Worker command delivery stopped'))
    this.pending.clear()
  }
}
