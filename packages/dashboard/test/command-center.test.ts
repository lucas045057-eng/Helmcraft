import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { TaskSummary } from '@agent-hub/protocol'
import { useDashboard } from '../src/store.js'
import { LogBuffer } from '../src/logs.js'
import { Login } from '../src/Login.js'

it('advances the event cursor without replacing a newer task version', () => {
  const task = { id: 'test', version: 3 } as TaskSummary
  useDashboard.getState().event({ t: 'event', topic: 'tasks', type: 'task.created', eventSeq: 1, data: task })
  useDashboard.getState().event({ t: 'event', topic: 'tasks', type: 'task.updated', eventSeq: 2, data: { ...task, version: 2 } })
  useDashboard.getState().event({ t: 'event', topic: 'tasks', type: 'task.updated', eventSeq: 1, data: { ...task, version: 4 } })
  expect(useDashboard.getState().tasks.test?.version).toBe(3)
  expect(useDashboard.getState().eventSeq).toBe(2)
})

it('deduplicates replayed log entries and advances through a gap', () => {
  const buffer = new LogBuffer()
  const line = { seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'hello', data: null } as const
  const gap = { seq: 2, ts: 2, kind: 'gap', stream: null, text: null, data: { toSeq: 10 } } as const
  buffer.append([line, gap])
  buffer.append([gap, { ...line, seq: 11 }])
  expect(buffer.entries.map(entry => entry.seq)).toEqual([1, 2, 11])
  expect(buffer.cursor).toBe(11)
})

it('renders the owner login with a masked token and stable controls', () => {
  const markup = renderToStaticMarkup(createElement(Login, { onLogin: async () => {} }))
  expect(markup).toContain('type="password"')
  expect(markup).toContain('data-testid="login-token"')
  expect(markup).toContain('data-testid="login-submit"')
})
