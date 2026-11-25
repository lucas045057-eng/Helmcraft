type Release = () => void
type Waiter = (release: Release) => void

export class KeyedMutex<K = string> {
  private readonly queues = new Map<K, Set<Waiter>>()

  get size(): number {
    return this.queues.size
  }

  private releaseFor(key: K, queue: Set<Waiter>): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = queue.values().next()
      if (next.done) {
        this.queues.delete(key)
      } else {
        queue.delete(next.value)
        next.value(this.releaseFor(key, queue))
      }
    }
  }

  lock(key: K): Promise<Release> {
    const queue = this.queues.get(key)
    if (queue) return new Promise((resolve) => { queue.add(resolve) })
    const waiters = new Set<Waiter>()
    this.queues.set(key, waiters)
    return Promise.resolve(this.releaseFor(key, waiters))
  }

  tryLock(key: K, timeoutMs = 0): Promise<Release | undefined> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('invalid lock timeout')
    const queue = this.queues.get(key)
    if (!queue) return this.lock(key)
    if (timeoutMs === 0) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const waiter: Waiter = (release) => {
        clearTimeout(timer)
        resolve(release)
      }
      const timer = setTimeout(() => {
        queue.delete(waiter)
        resolve(undefined)
      }, timeoutMs)
      queue.add(waiter)
    })
  }

  async runExclusive<T>(key: K, fn: () => T | Promise<T>): Promise<T> {
    const release = await this.lock(key)
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
