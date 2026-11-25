export interface Clock {
  now(): number
  monotonic(): number
  setInterval(fn: () => void, ms: number): () => void
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }

  monotonic(): number {
    return performance.now()
  }

  setInterval(fn: () => void, ms: number): () => void {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  }
}

interface Interval {
  fn: () => void
  period: number
  due: number
}

export class FakeClock implements Clock {
  private elapsed = 0
  private readonly intervals = new Set<Interval>()

  constructor(private readonly epoch = 0) {}

  now(): number {
    return this.epoch + this.elapsed
  }

  monotonic(): number {
    return this.elapsed
  }

  setInterval(fn: () => void, ms: number): () => void {
    if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('interval must be positive and finite')
    const interval = { fn, period: ms, due: this.elapsed + ms }
    if (interval.due <= this.elapsed) throw new RangeError('interval is below clock precision')
    this.intervals.add(interval)
    return () => { this.intervals.delete(interval) }
  }

  advance(ms: number): void {
    const end = this.elapsed + ms
    if (!Number.isFinite(end) || ms < 0) throw new RangeError('advance must be non-negative and finite')
    while (true) {
      let next: Interval | undefined
      for (const interval of this.intervals) {
        if (interval.due <= end && (!next || interval.due < next.due)) next = interval
      }
      if (!next) break
      this.elapsed = Math.max(this.elapsed, next.due)
      next.due += next.period
      if (next.due <= this.elapsed) this.intervals.delete(next)
      next.fn()
    }
    this.elapsed = Math.max(this.elapsed, end)
  }
}
