import { expect, it } from 'vitest'
import { describeLog } from '../src/logs.js'
import { useDashboard } from '../src/store.js'
import type { LogEntry, WorkspacePointerView } from '@agent-hub/protocol'

it.each([
  ['harness', { applied: { board: 'write', inject: 'fresh', verify: false, bootstrap: true } }, '▶ harness board=write inject=fresh bootstrap=yes verify=no'],
  ['workspace', { board: { dir: 'present', files: [{ content: 'never display' }] }, round: 0 }, '▶ workspace round=0 board=present'],
  ['verify', { attempt: 1, phase: 'result', status: 'failed', results: [{ id: 'test', status: 'failed', exitCode: 1, tail: 'multiline\noutput' }] }, '▶ verify#1 failed: test (exit 1)'],
] as const)('renders a single %s summary', (kind, data, text) => {
  expect(describeLog({ seq: 1, ts: 1, kind, data, text: null, stream: null } as LogEntry)).toEqual({ kind, text })
})
it('retains the newest workspace pointer per worker and clears pointers on session reset', () => {
  const data: WorkspacePointerView = { workerId: 'worker', workspaceId: 'sandbox', updatedAt: 1, attemptCounter: 1, lastAccepted: null, lastAttempt: null }
  const state = useDashboard.getState()
  state.clear()
  state.event({ t: 'event', eventSeq: 5, type: 'workspace.updated', topic: 'workers', data })
  state.event({ t: 'event', eventSeq: 4, type: 'workspace.updated', topic: 'workers', data: { ...data, attemptCounter: 0 } })
  expect(useDashboard.getState().pointers['worker/sandbox']).toEqual(data)
  state.clear()
  expect(useDashboard.getState().pointers).toEqual({})
})
