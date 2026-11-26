import { expect, it } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describeLog } from '../src/logs.js'
import { DashboardConnection } from '../src/connection.js'
import { invalidateAfterFetch } from '../src/App.js'
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

it('invalidates artifact queries on live run.updated and task.updated frames', () => {
  const prevWin = (globalThis as { window?: unknown }).window
  const prevWs = (globalThis as { WebSocket?: unknown }).WebSocket
  const sockets: FakeWs[] = []
  class FakeWs {
    static OPEN = 1
    readyState = 1
    onopen?: () => void
    onmessage?: (ev: { data: string }) => void
    onclose?: (ev: { code: number }) => void
    send() {}
    close() {}
    constructor() { sockets.push(this) }
  }
  Object.assign(globalThis, {
    window: { location: { href: 'http://127.0.0.1:3000/' } },
    WebSocket: FakeWs,
  })
  const artifactInvalidations: Array<{ taskId: string; runId?: string }> = []
  useDashboard.getState().clear()
  const conn = new DashboardConnection(() => undefined, () => undefined, target => artifactInvalidations.push(target))
  const stop = conn.start()
  try {
    const tid = 'tsk_' + '1'.repeat(26)
    const rid = 'run_' + '1'.repeat(26)
    const instance = sockets[0]
    instance?.onmessage?.({
      data: JSON.stringify({ t: 'event', eventSeq: 1, type: 'run.updated', topic: 'tasks', data: {
        id: rid, taskId: tid, attempt: 1, workerId: 'w-1', adapter: 'mock', workspaceId: 'soren',
        profile: 'edit', status: 'running', pid: 123, cliVersion: null, cliSessionId: null,
        exitCode: null, errorCode: null, errorMessage: null, summary: null, usage: null,
        lastSeq: 1, logBytes: 0, logDroppedBytes: 0, dispatchedAt: 1, startedAt: 1, finishedAt: null,
      } }),
    })
    instance?.onmessage?.({
      data: JSON.stringify({ t: 'event', eventSeq: 2, type: 'task.updated', topic: 'tasks', data: {
        id: tid, taskNo: 1, version: 1, title: 't', status: 'succeeded', priority: 0,
        requester: { type: 'owner', id: 'owner', channel: 'dashboard' }, origin: { source: 'dashboard' },
        adapter: 'mock', workspaceId: 'soren', profile: 'edit', subdir: null, workerId: 'w-1',
        attempt: 1, maxAttempts: 1, parentTaskId: null, lastProgress: null, scheduleHint: null,
        workerConnection: 'online', graceUntil: null, errorCode: null, resultDeliveryStatus: 'not_required',
        createdAt: 1, updatedAt: 2, startedAt: 1, finishedAt: 2, allowedActions: [],
      } }),
    })
    expect(artifactInvalidations).toEqual([{ taskId: tid, runId: rid }, { taskId: tid }])
  } finally {
    stop()
    if (prevWin === undefined) delete (globalThis as { window?: unknown }).window
    else Object.assign(globalThis, { window: prevWin })
    if (prevWs === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket
    else Object.assign(globalThis, { WebSocket: prevWs })
  }
})

it('coerces a trailing refetch when artifact invalidation arrives during an active fetch', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = ['run-artifacts', 'tsk_' + '2'.repeat(26), 'run_' + '2'.repeat(26)]
  let call = 0
  let releaseFirst!: () => void
  const firstPending = new Promise<void>(resolve => { releaseFirst = resolve })
  const fetchFn = async () => {
    call++
    if (call === 1) {
      await firstPending
      return ['before']
    }
    return ['before', 'after']
  }

  const firstFetch = cache.fetchQuery({ queryKey: key, queryFn: fetchFn })
  // Yield until query enters fetching state with active promise
  await Promise.resolve()
  const observer = new QueryObserver(cache, { queryKey: key, queryFn: fetchFn })
  const unsubscribe = observer.subscribe(() => undefined)
  try {
    invalidateAfterFetch(cache, key)
    releaseFirst()
    expect(await firstFetch).toEqual(['before'])
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(call).toBe(2)
    expect(cache.getQueryData(key)).toEqual(['before', 'after'])
  } finally {
    unsubscribe()
    cache.clear()
  }
})

it('handles rejected in-flight fetch without unhandledRejection and completes trailing refetch', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = ['run-artifacts', 'tsk_' + '3'.repeat(26), 'run_' + '3'.repeat(26)]
  let call = 0
  let rejectFirst!: (err: Error) => void
  const firstPending = new Promise<void>((_, reject) => { rejectFirst = reject })
  const fetchFn = async () => {
    call++
    if (call === 1) {
      await firstPending
      return ['never']
    }
    return ['recovered']
  }

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  const firstFetch = cache.fetchQuery({ queryKey: key, queryFn: fetchFn })
  await Promise.resolve()
  const observer = new QueryObserver(cache, { queryKey: key, queryFn: fetchFn })
  const unsubscribe = observer.subscribe(() => undefined)
  try {
    invalidateAfterFetch(cache, key)
    rejectFirst(new Error('transient artifact fetch failure'))
    await expect(firstFetch).rejects.toThrow('transient artifact fetch failure')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(call).toBe(2)
    expect(cache.getQueryData(key)).toEqual(['recovered'])
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    unsubscribe()
    cache.clear()
  }
})
