interface Entry { key: string; at: number; run: () => void }
export class TimerWheel {
  private readonly heap: Entry[] = []
  private readonly index = new Map<string, number>()
  get size() { return this.heap.length }
  set(key: string, at: number, run: () => void) {
    this.delete(key)
    this.index.set(key, this.heap.length)
    this.heap.push({ key, at, run })
    this.up(this.heap.length - 1)
  }
  delete(key: string) {
    const position = this.index.get(key)
    if (position === undefined) return
    this.index.delete(key)
    const last = this.heap.pop()!
    if (position === this.heap.length) return
    this.heap[position] = last
    this.index.set(last.key, position)
    this.down(this.up(position))
  }
  advance(now: number) {
    while (this.heap[0] && this.heap[0].at <= now) {
      const entry = this.heap[0]
      this.delete(entry.key)
      entry.run()
    }
  }
  private swap(a: number, b: number) {
    const first = this.heap[a]!, second = this.heap[b]!
    this.heap[a] = second
    this.heap[b] = first
    this.index.set(second.key, a)
    this.index.set(first.key, b)
  }
  private up(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.heap[parent]!.at <= this.heap[index]!.at) break
      this.swap(parent, index)
      index = parent
    }
    return index
  }
  private down(index: number) {
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1
      if (this.heap[child + 1] && this.heap[child + 1]!.at < this.heap[child]!.at) child++
      if (this.heap[index]!.at <= this.heap[child]!.at) break
      this.swap(index, child)
      index = child
    }
  }
}
