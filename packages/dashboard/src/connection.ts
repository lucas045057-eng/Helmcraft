import { DASHBOARD_SUBPROTOCOL, DashServerFrame, AuthMeResponse, DashboardCloseCode } from '@agent-hub/protocol'
import type { DashClientFrame, Topic } from '@agent-hub/protocol'
import { request, sessionExpired, setCsrf } from './api.js'
import { LogBuffer } from './logs.js'
import { useDashboard } from './store.js'

const globalTopics: Topic[] = ['overview', 'workers', 'tasks']
export class DashboardConnection {
  private ws: WebSocket | undefined
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private logRetry: ReturnType<typeof setTimeout> | undefined
  private bootId: string | undefined
  private detail: Topic | undefined
  private follow: { id: string; buffer: LogBuffer } | undefined
  private welcomed = false
  private synchronized = false
  private active = false
  private attempts = 0
  constructor(
    private readonly resync: () => void,
    private readonly projectsChanged: () => void,
    private readonly artifactsChanged?: (target: { taskId: string; runId?: string }) => void,
  ) {}

  start() {
    this.active = true
    this.connect()
    this.heartbeat = setInterval(() => this.send({ t: 'ping', n: Date.now() }), 25_000)
    return () => {
      this.active = false
      this.welcomed = false
      clearInterval(this.heartbeat)
      clearTimeout(this.reconnect)
      clearTimeout(this.logRetry)
      const ws = this.ws
      this.ws = undefined
      ws?.close()
    }
  }

  getTask(id: string) {
    const topic: Topic = 'task:' + id
    this.detail = topic
    this.send({ t: 'subscribe', topics: [topic] })
    return () => {
      if (this.detail === topic) this.detail = undefined
      this.send({ t: 'unsubscribe', topics: [topic] })
    }
  }

  followRun(id: string, buffer: LogBuffer) {
    const selected = { id, buffer }
    this.follow = selected
    this.send({ t: 'follow', runId: id, fromSeq: buffer.cursor })
    return () => {
      if (this.follow !== selected) return
      this.follow = undefined
      clearTimeout(this.logRetry)
      this.send({ t: 'unfollow', runId: id })
    }
  }

  private send(frame: DashClientFrame) {
    if (this.welcomed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  private connect() {
    useDashboard.setState({ connection: 'connecting' })
    const path = new URL('/ws/dashboard', window.location.href)
    path.protocol = path.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(path, DASHBOARD_SUBPROTOCOL)
    this.ws = ws
    ws.onopen = () => {
      const frame: DashClientFrame = { t: 'hello', ...(this.bootId !== undefined &&
        { resume: { bootId: this.bootId, eventSeq: useDashboard.getState().eventSeq } }) }
      ws.send(JSON.stringify(frame))
    }
    ws.onclose = async event => {
      if (!this.active || this.ws !== ws) return
      this.welcomed = false
      if (event.code === DashboardCloseCode.SESSION_EXPIRED) {
        sessionExpired.dispatchEvent(new Event('expired'))
        return
      }
      if (event.code === DashboardCloseCode.RATE_LIMITED) {
        useDashboard.setState({ connection: 'limited' })
        return
      }
      if (event.code === DashboardCloseCode.TIMEOUT) this.bootId = undefined
      useDashboard.setState({ connection: 'offline' })
      this.follow?.buffer.setStatus('连接中断，重连后继续读取')
      if (event.code === 1006) {
        // Upgrade rejection has no accessible HTTP status in browser WebSocket.
        try { setCsrf((await request('/auth/me', AuthMeResponse)).csrfToken) } catch { /* reconnect unless the session expired */ }
      }
      if (!this.active || this.ws !== ws) return
      const delay = event.code === 1001 ? 2000 + Math.random() * 3000 : event.code === 4008 ? 0
        : Math.min(15_000, 500 * 2 ** this.attempts++)
      this.reconnect = setTimeout(() => this.connect(), delay)
    }
    ws.onmessage = event => {
      if (!this.active || this.ws !== ws || typeof event.data !== 'string') return
      let frame: DashServerFrame
      try { frame = DashServerFrame.parse(JSON.parse(event.data)) } catch { return }
      const state = useDashboard.getState()
      switch (frame.t) {
        case 'welcome': {
          if (!frame.resumed) { state.clear(); if (this.synchronized) this.resync() }
          this.synchronized = true
          this.bootId = frame.bootId
          this.welcomed = true
          this.attempts = 0
          useDashboard.setState({ connection: 'live', clockOffset: frame.serverTime - Date.now() })
          this.send({ t: 'subscribe', topics: this.detail ? [...globalTopics, this.detail] : globalTopics })
          if (this.follow) {
            this.follow.buffer.setStatus('')
            this.send({ t: 'follow', runId: this.follow.id, fromSeq: this.follow.buffer.cursor })
          }
          break
        }
        case 'snapshot': state.snapshot(frame); break
        case 'event':
          state.event(frame)
          if (['task.created', 'task.updated', 'run.updated', 'workspace.updated', 'worker.updated', 'worker.removed'].includes(frame.type))
            this.projectsChanged()
          if (frame.type === 'run.updated') this.artifactsChanged?.({ taskId: frame.data.taskId, runId: frame.data.id })
          else if (frame.type === 'task.updated') this.artifactsChanged?.({ taskId: frame.data.id })
          break
        case 'logs':
          if (this.follow?.id === frame.runId) this.follow.buffer.append(frame.entries)
          break
        case 'logs.reset': {
          const followed = this.follow
          if (followed?.id !== frame.runId) break
          if (frame.reason === 'run_not_found') { followed.buffer.setStatus('运行记录不存在'); break }
          followed.buffer.setStatus('日志同步已暂停，正在重试')
          clearTimeout(this.logRetry)
          this.logRetry = setTimeout(() => {
            if (this.follow !== followed || !this.welcomed) return
            followed.buffer.setStatus('')
            this.send({ t: 'follow', runId: followed.id, fromSeq: followed.buffer.cursor })
          }, 2000)
          break
        }
        case 'resync': this.bootId = undefined; state.clear(); this.resync(); break
        case 'error': this.follow?.buffer.setStatus(frame.message); break
      }
    }
  }
}

