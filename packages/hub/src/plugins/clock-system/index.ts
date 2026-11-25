import { Context, Service } from 'cordis'
import { SystemClock } from '@agent-hub/common'
import type { Clock } from '../../services/clock.js'
export class ClockSystem extends Service implements Clock {
  constructor(ctx: Context, private readonly clock: Clock = new SystemClock()) { super(ctx, 'clock') }
  now() { return this.clock.now() }
  monotonic() { return this.clock.monotonic() }
  setInterval(fn: () => void, ms: number) { return this.clock.setInterval(fn, ms) }
}
