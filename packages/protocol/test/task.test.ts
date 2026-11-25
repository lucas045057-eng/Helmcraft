import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { allowedActions, reduce, TaskEventType, TaskStatus } from '../src/task.js'
import type { TaskEvent, TaskState } from '../src/task.js'
import type { Actor } from '../src/common.js'

const requester: Actor = { type: 'requester', id: 'ou_requester', channel: 'feishu' }
const owner: Actor = { type: 'owner', id: 'owner', channel: 'dashboard' }
const worker: Actor = { type: 'worker', id: 'win-desktop', channel: 'system' }
const system: Actor = { type: 'system', id: 'scheduler', channel: 'system' }
const runId = 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const context = { now: 42, newRunId: runId }
const queued: TaskState = {
  id: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'queued', version: 1, requester,
  profile: 'readonly', attemptCount: 0, maxAttempts: 1, runSeq: 0, currentRunId: null,
  updatedAt: 1, liveInput: true,
}
const dispatching = { ...queued, status: 'dispatching' as const, version: 2, attemptCount: 1, runSeq: 1, currentRunId: runId }

it('handles all three SUBMIT policies', () => {
  for (const [decision, status] of [['auto_approve', 'queued'], ['require_approval', 'awaiting_approval'], ['deny', 'rejected']] as const) {
    expect(reduce(null, { type: 'SUBMIT', actor: requester, decision, task: queued }, context))
      .toMatchObject({ next: { status, version: 1, errorCode: decision === 'deny' ? 'POLICY_DENIED' : null } })
  }
})

it('increments run sequence across refused dispatches and reuses attempt budget', () => {
  const dispatch = { type: 'DISPATCH', actor: system, adapter: 'mock', workerId: worker.id, workspaceId: 'sandbox' } as const
  expect(reduce(queued, dispatch, context)).toMatchObject({ next: { ...dispatching, updatedAt: 42 }, writes: [{ type: 'run.create', runSeq: 1 }] })
  const result = reduce(dispatching, { type: 'RUN_REFUSED', actor: worker, runId }, context)
  expect(result).toMatchObject({ next: { status: 'queued', currentRunId: null, runSeq: 1, attemptCount: 0 }, writes: [{ status: 'refused' }] })
  if ('error' in result) throw new Error(result.error.code)
  expect(reduce(result.next, dispatch, context)).toMatchObject({ next: { runSeq: 2, attemptCount: 1 } })
})

it('applies implicit acceptance and completion atomically with two versions', () => {
  const result = reduce(dispatching, { type: 'RUN_SUCCEEDED', actor: worker, runId }, context)
  expect(result).toMatchObject({
    next: { status: 'succeeded', version: 4, currentRunId: null },
    writes: [{ status: 'running' }, { status: 'succeeded' }],
  })
  if ('error' in result) throw new Error(result.error.code)
  expect(result.effects).toContainEqual(expect.objectContaining({ type: 'transition', event: 'RUN_ACCEPTED', implicitAccept: true }))
})

it('checks stale runs, lost run policy, cancellation races, and retry permission', () => {
  expect(reduce(dispatching, { type: 'RUN_SUCCEEDED', actor: worker, runId: 'stale' }, context))
    .toMatchObject({ next: dispatching, effects: [{ type: 'metric.stale_run_event' }] })
  expect(reduce(dispatching, { type: 'DISPATCH_LOST', actor: system, runId }, context))
    .toMatchObject({ next: { status: 'failed', errorCode: 'WORKER_LOST' }, writes: [{ status: 'lost' }] })
  const running = { ...dispatching, status: 'running' as const, maxAttempts: 2, autoRetryOnWorkerLost: true }
  expect(reduce(running, { type: 'RUN_LOST', actor: system, runId }, context)).toMatchObject({ next: { status: 'queued' } })
  expect(reduce({ ...running, profile: 'edit' }, { type: 'RUN_LOST', actor: system, runId }, context))
    .toMatchObject({ next: { status: 'failed' } })
  const cancelling = { ...dispatching, status: 'cancelling' } as const
  expect(reduce(cancelling, { type: 'RUN_SUCCEEDED', actor: worker, runId }, context)).toMatchObject({ next: { status: 'succeeded' } })
  expect(reduce(cancelling, { type: 'RUN_FAILED', actor: worker, runId }, context)).toMatchObject({ next: { status: 'cancelled' } })
  const failed = { ...queued, status: 'failed', attemptCount: 1, requesterCanRetry: true } as const
  expect(reduce(failed, { type: 'RETRY', actor: requester }, context)).toMatchObject({ error: { code: 'MAX_ATTEMPTS_REACHED' } })
  expect(reduce(failed, { type: 'RETRY', actor: owner }, context)).toMatchObject({ next: { status: 'queued' }, effects: [expect.objectContaining({ override: true })] })
  expect(allowedActions(failed, owner)).toContain('retry')
  expect(allowedActions(failed, requester)).not.toContain('retry')
})

it('matches every state/event cell in the frozen matrix', () => {
  const spec = readFileSync(new URL('../../../docs/specs/02-task-state-machine.md', import.meta.url), 'utf8')
  const matrix = spec.split('### 3.2 ')[1]!.split('注释：')[0]!
  const payloads = {
    SUBMIT: { actor: owner, decision: 'auto_approve', task: queued },
    APPROVE: { actor: owner }, REJECT: { actor: owner }, APPROVAL_EXPIRE: { actor: system },
    DISPATCH: { actor: system, workerId: worker.id, adapter: 'mock', workspaceId: 'sandbox' },
    RUN_ACCEPTED: { actor: worker, runId }, RUN_REFUSED: { actor: worker, runId }, DISPATCH_LOST: { actor: system, runId },
    INPUT_REQUEST: { actor: worker, runId, requestId: 'req', question: 'Continue?' },
    INPUT_PROVIDE: { actor: owner, requestId: 'req', answer: 'yes' },
    INPUT_EXPIRE: { actor: system, runId }, CANCEL: { actor: owner },
    RUN_SUCCEEDED: { actor: worker, runId }, RUN_FAILED: { actor: worker, runId },
    RUN_TIMED_OUT: { actor: worker, runId }, RUN_CANCELLED: { actor: worker, runId },
    RUN_LOST: { actor: system, runId }, RETRY: { actor: owner },
  } as const
  const rows = matrix.split('\n').filter((line) => line.startsWith('| ')).slice(2)
  expect(rows).toHaveLength(TaskStatus.options.length + 1)
  for (const row of rows) {
    const [name, ...cells] = row.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('*', ''))
    expect(cells).toHaveLength(TaskEventType.options.length)
    const status = name!.startsWith('∅') ? null : TaskStatus.parse(name)
    const active = status && ['dispatching', 'running', 'awaiting_input', 'cancelling'].includes(status)
    const task = status && { ...queued, status, attemptCount: 1, maxAttempts: 3,
      currentRunId: active ? runId : null, inputRequestId: status === 'awaiting_input' ? 'req' : null }
    for (const [index, type] of TaskEventType.options.entries()) {
      const event = { type, ...payloads[type] } as TaskEvent
      const actual = reduce(task, event, context)
      const cell = cells[index]!
      const label = (status ?? 'missing') + ' / ' + type
      if (cell === '—') {
        expect(actual, label).toMatchObject({ error: { code: status ? 'INVALID_TRANSITION' : 'TASK_NOT_FOUND' } })
      } else if (cell === '=') {
        expect(actual, label).toMatchObject({ next: task, writes: [], effects: [{ type: 'audit.noop' }] })
      } else {
        const special: Record<string, string> = {
          A: 'queued', B: 'queued', C: type === 'INPUT_REQUEST' ? 'awaiting_input' : type.slice(4).toLowerCase(),
          D: 'failed', E: 'cancelled', F: 'queued',
        }
        expect(actual, label).toMatchObject({ next: { status: special[cell] ?? cell } })
      }
    }
  }
})
