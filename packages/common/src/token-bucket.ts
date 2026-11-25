import type { Clock } from './clock.js'
import { SystemClock } from './clock.js'

export class TokenBucket {
  private tokens: number
  private updatedAt: number

  constructor(private rate: number, readonly burst: number, private readonly clock: Pick<Clock, 'monotonic'> = new SystemClock()) {
    if (!Number.isFinite(burst) || burst <= 0) throw new RangeError('invalid burst')
    this.validateRate(rate)
    this.tokens = burst
    this.updatedAt = clock.monotonic()
  }

  private validateRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0) throw new RangeError('invalid rate')
  }

  private refill(): void {
    const now = Math.max(this.updatedAt, this.clock.monotonic())
    this.tokens = Math.min(this.burst, this.tokens + (now - this.updatedAt) * this.rate / 1_000)
    this.updatedAt = now
  }

  setRate(rate: number): void {
    this.validateRate(rate)
    this.refill()
    this.rate = rate
  }

  take(count = 1): boolean {
    if (!Number.isFinite(count) || count <= 0) throw new RangeError('invalid token count')
    this.refill()
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }
}
