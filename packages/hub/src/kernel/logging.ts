import { Logger } from 'cordis'
import type { Context } from 'cordis'
import { redact } from '@agent-hub/common'
import type { Clock } from '../services/clock.js'

export function installHubLogging(ctx: Context, clock: Clock, write: (line: string) => void) {
  const exporter: Parameters<Context['logger']['exporter']>[0] = {
    colors: false, maxLength: 4096,
    export(message) {
      write(JSON.stringify({ ts: clock.now(), level: message.type, name: message.name,
        fiber: message.fiber?.deref()?.name, msg: redact(Logger.format(exporter, message)) }))
    },
  }
  ctx.logger.exporters.clear()
  return ctx.logger.exporter(exporter)
}
