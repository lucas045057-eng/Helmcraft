/**
 * Pi 独立验收 · 面板 WebSocket 客户端（Phase 4）
 *
 * 直接按 04 §5 的 `DashClientFrame` / `DashServerFrame` 收发，绕开前端实现，
 * 用于验证快照/增量时序、断线续传、日志跟随与慢消费者。
 */
import WebSocket from 'ws'
import type { RawData } from 'ws'
import { DASHBOARD_SUBPROTOCOL, DashServerFrame } from '@agent-hub/protocol'
import type { DashClientFrame, DashEventFrame, LogEntry, Topic } from '@agent-hub/protocol'
import { eventually } from './harness.js'
import { ORIGIN } from './rest.js'

export type EventFrame = DashEventFrame
export type LogFrame = Extract<DashServerFrame, { t: 'logs' }>

export function dashboardUrl(address: string): string {
  return address.replace(/^http/, 'ws') + '/ws/dashboard'
}

export interface DashOptions {
  token: string
  origin?: string | null
  subprotocol?: string | null
}

export class DashClient {
  readonly frames: DashServerFrame[] = []
  closeCode: number | undefined
  closeReason = ''
  private readonly waiters = new Set<() => void>()

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : Buffer.from(data as ArrayBuffer).toString()
      const parsed = DashServerFrame.safeParse(JSON.parse(text))
      if (parsed.success) this.frames.push(parsed.data)
      for (const waiter of [...this.waiters]) waiter()
    })
    ws.on('close', (code: number, reason: Buffer) => { this.closeCode = code; this.closeReason = reason.toString() })
    ws.on('error', () => undefined)
  }

  /** 建立连接；`expectReject` 为真时返回拒绝原因（不抛错）。 */
  static async open(address: string, options: DashOptions): Promise<DashClient> {
    const protocols = options.subprotocol === null ? undefined : (options.subprotocol ?? DASHBOARD_SUBPROTOCOL)
    const ws = new WebSocket(dashboardUrl(address), protocols as string, {
      origin: options.origin === null ? undefined : (options.origin ?? ORIGIN),
      headers: { authorization: 'Bearer ' + options.token },
      perMessageDeflate: false,
    })
    const client = new DashClient(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('unexpected-response', (_request, response) => reject(new Error('upgrade rejected: ' + response.statusCode)))
      ws.once('error', error => reject(error))
    })
    return client
  }

  send(frame: DashClientFrame) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)) }
  pause() { this.ws.pause() }
  resume() { this.ws.resume() }
  terminate() { this.ws.terminate() }
  async close(code = 1000) {
    if (this.ws.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>(resolve => this.ws.once('close', () => resolve()))
    this.ws.close(code)
    await closed
  }

  /** 等待某个已收到的帧满足条件；超时抛出带上下文的错误。 */
  async waitFor<T extends DashServerFrame>(predicate: (frame: DashServerFrame) => boolean, label = 'frame', timeoutMs = 5000) {
    await eventually(() => this.frames.some(predicate), { timeoutMs, label: label + ' | saw=' + this.frames.map(frame => frame.t).join(',') })
    return this.frames.find(predicate) as T
  }

  async waitForCount(predicate: (frame: DashServerFrame) => boolean, count: number, label = 'frames', timeoutMs = 10_000) {
    await eventually(() => this.frames.filter(predicate).length >= count, { timeoutMs,
      label: label + ' | got=' + this.frames.filter(predicate).length })
  }

  async waitWelcome(): Promise<Extract<DashServerFrame, { t: 'welcome' }>> {
    return this.waitFor<Extract<DashServerFrame, { t: 'welcome' }>>(frame => frame.t === 'welcome', 'welcome')
  }

  async waitSnapshot(): Promise<Extract<DashServerFrame, { t: 'snapshot' }>> {
    return this.waitFor<Extract<DashServerFrame, { t: 'snapshot' }>>(frame => frame.t === 'snapshot', 'snapshot')
  }

  async waitClose(timeoutMs = 8000): Promise<number> {
    await eventually(() => this.closeCode !== undefined, { timeoutMs, label: 'close code' })
    return this.closeCode!
  }

  events(type?: string): EventFrame[] {
    return this.frames.filter((frame): frame is EventFrame => frame.t === 'event' && (!type || frame.type === type))
  }

  logsFrames(): LogFrame[] { return this.frames.filter((frame): frame is LogFrame => frame.t === 'logs') }

  /** 按到达顺序展开所有 logs 帧中的条目。 */
  logs(): LogEntry[] { return this.logsFrames().flatMap(frame => frame.entries) }

  /** 启动一个面板会话：hello + 订阅主题。 */
  async handshake(topics: Topic[], resume?: { bootId: string; eventSeq: number }) {
    this.send({ t: 'hello', ...(resume && { resume }) })
    const welcome = await this.waitWelcome()
    this.send({ t: 'subscribe', topics })
    return welcome
  }
}
