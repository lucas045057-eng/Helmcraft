import type { Clock } from './clock.js'
import { SystemClock } from './clock.js'

export class Lru<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()

  constructor(readonly capacity: number, private readonly ttlMs = Infinity, private readonly clock: Pick<Clock, 'monotonic'> = new SystemClock()) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !(ttlMs > 0)) throw new RangeError('invalid LRU capacity or TTL')
  }

  private lookup(key: K) {
    const entry = this.entries.get(key)
    if (entry && entry.expiresAt <= this.clock.monotonic()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  get size(): number {
    this.sweep()
    return this.entries.size
  }

  private sweep(): void {
    if (!Number.isFinite(this.ttlMs)) return
    const now = this.clock.monotonic()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  has(key: K): boolean {
    return this.lookup(key) !== undefined
  }

  get(key: K): V | undefined {
    const entry = this.lookup(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): this {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.clock.monotonic() + this.ttlMs })
    if (this.entries.size > this.capacity) this.sweep()
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    return this
  }

  delete(key: K): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
