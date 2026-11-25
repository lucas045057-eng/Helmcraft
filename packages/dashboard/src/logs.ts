import type { LogEntry } from '@agent-hub/protocol'

export class LogBuffer {
  readonly entries: LogEntry[] = []
  cursor = 0
  private readonly listeners = new Set<() => void>()
  private scheduled = false
  status = ''
  private version = 0
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  snapshot = () => this.version
  append(entries: LogEntry[]) {
    let changed = false
    for (const entry of entries) {
      const end = logEnd(entry)
      if (end <= this.cursor) continue
      this.entries.push(entry)
      this.cursor = end
      changed = true
    }
    if (changed) this.notify()
  }
  setStatus(message: string) {
    if (message === this.status) return
    this.status = message
    this.notify()
  }
  private notify() {
    if (this.scheduled) return
    this.scheduled = true
    const render = () => {
      this.scheduled = false
      this.version++
      for (const listener of this.listeners) listener()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(render)
    else render()
  }
}

function logEnd(entry: LogEntry) {
  const data = entry.data
  return entry.kind === 'gap' && data && typeof data === 'object' && 'toSeq' in data && typeof data.toSeq === 'number'
    ? data.toSeq : entry.seq
}

function object(value: LogEntry['data']): Record<string, LogEntry['data']> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function describeLog(entry: LogEntry): { kind: string; text: string } {
  const data = object(entry.data)
  if (entry.kind === 'harness') {
    const applied = object(data.applied ?? null)
    return { kind: entry.kind, text: '▶ harness board=' + applied.board + ' inject=' + applied.inject +
      ' bootstrap=' + (applied.bootstrap ? 'yes' : 'no') + ' verify=' + (applied.verify ? 'yes' : 'no') }
  }
  if (entry.kind === 'workspace') return { kind: entry.kind, text: '▶ workspace round=' + data.round +
    ' board=' + (object(data.board ?? null).dir ?? 'off') + (data.readonlyCheck ? ' readonly=' + data.readonlyCheck : '') }
  if (entry.kind === 'verify') {
    const results = Array.isArray(data.results) ? data.results.map(object).filter(r => r.status === 'failed' || r.status === 'timed_out' || r.status === 'unavailable') : []
    return { kind: entry.kind, text: '▶ verify#' + data.attempt + ' ' + (data.status ?? data.phase) +
      (results.length ? ': ' + results.map(r => r.id + ' (exit ' + r.exitCode + ')').join(', ') : '') }
  }
  if (entry.kind === 'agent') {
    const event = object(data.event ?? entry.data)
    const kind = String(event.type ?? 'agent')
    const text = [event.name, event.text, event.summary, event.command, event.outputTail, event.path, event.change, event.message]
      .filter(value => typeof value === 'string').join(' · ')
    return { kind, text: text || JSON.stringify(event) }
  }
  if (entry.kind === 'gap') return { kind: 'gap', text: '日志缺段 #' + entry.seq + '–' + logEnd(entry) + ' · ' + String(data.reason ?? '') }
  if (entry.kind === 'dropped') return { kind: 'dropped', text: '已丢弃 ' + String(data.lines ?? '—') + ' 行，' + String(data.bytes ?? '—') + ' 字节' }
  if (entry.kind === 'finished' && data.errorMessage) return { kind: 'error', text: String(data.errorMessage) }
  return { kind: entry.stream ?? entry.kind, text: entry.text ?? (entry.data === null ? '' : JSON.stringify(entry.data)) }
}

