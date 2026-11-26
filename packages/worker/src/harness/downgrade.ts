import type { RunEvent } from '@agent-hub/protocol'

export function downgradeEvent(event: RunEvent, caps: readonly string[]): RunEvent {
  const { kind, seq, ts } = event
  if (!caps.includes('visual.v1') && kind === 'visual') {
    return { kind: 'progress', seq, ts, phase: 'visual.' + event.phase, detail: event.status }
  }
  if (!caps.includes('blackboard.v1') && (kind === 'harness' || kind === 'workspace')) {
    return { kind: 'progress', seq, ts, phase: kind === 'harness' ? 'harness.pre' : 'harness.post',
      detail: kind === 'harness' ? 'board=' + event.applied.board : 'round ' + event.round }
  }
  if (caps.includes('verify.v1') && caps.includes('blackboard.v1')) return event
  if (kind === 'verify') return { kind: 'progress', seq, ts, phase: 'verify', detail: 'attempt ' + event.attempt + ' ' + (event.status ?? event.phase) }
  if (kind === 'harness' && event.manifest) { const copy = { ...event }; delete copy.manifest; return copy }
  if (kind === 'workspace' && (event.changes || event.tamper)) {
    const copy = { ...event }
    delete copy.changes
    delete copy.tamper
    return copy
  }
  if (kind === 'finished' && event.verification) { const copy = { ...event }; delete copy.verification; return copy }
  return event
}
