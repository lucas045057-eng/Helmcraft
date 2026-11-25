export class ClockOffset {
  private offset = 0
  private bestRtt = Infinity
  reset() { this.bestRtt = Infinity }
  observe(serverTime: number, receivedAt: number, sentAt = receivedAt) {
    const rtt = Math.max(0, receivedAt - sentAt)
    if (rtt > this.bestRtt * 2 + 100) return
    this.bestRtt = Math.min(rtt, this.bestRtt)
    this.offset = Math.round(serverTime - receivedAt + rtt / 2)
  }
  toHubTime(localTime: number) { return localTime + this.offset }
}
