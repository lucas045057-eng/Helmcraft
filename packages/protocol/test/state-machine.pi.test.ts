/**
 * Pi 独立验收 · 02 状态机门禁 SM-1 ~ SM-12
 *
 * 与既有 `task.test.ts` 的区别（本文件为对抗性补充，不以实现为准）：
 *  - SM-1 直接从 `docs/specs/02-task-state-machine.md` §3.2 解析矩阵，并断言矩阵**完整覆盖**
 *    `TaskStatus × TaskEventType` 全部组合（新增状态/事件但忘记更新规格表会立即失败）；
 *    每个单元格在「尝试次数未用尽」与「尝试次数已用尽」两种前提下各跑一遍。
 *  - SM-4 断言隐式受理的 version 增量、effects 顺序与 implicitAccept 标记。
 *  - SM-8/SM-9/SM-10 覆盖权限矩阵每一格、乐观锁 details、Owner override 审计。
 *  - SM-11 用 fast-check 生成 200 步随机事件序列（含并发 actor / 陈旧 runId / Worker 事件 / 定时器事件）。
 *  - SM-12 断言 allowedActions() 与 reduce() 在每个 (状态 × actor × 动作) 上严格一致。
 */
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allowedActions, reduce, TaskEventType, TaskStatus } from '../src/task.js'
import type { TaskEvent, TaskEventType as EventType, TaskState, TaskStatus as Status } from '../src/task.js'
import type { Actor } from '../src/common.js'

const runId = 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const staleRunId = 'run_01ARZ3NDEKTSV4RRFFQ69G5FAV2'
const taskId = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV'

const owner: Actor = { type: 'owner', id: 'owner', channel: 'dashboard' }
const requester: Actor = { type: 'requester', id: 'ou_self', channel: 'feishu' }
const stranger: Actor = { type: 'requester', id: 'ou_other', channel: 'feishu' }
const worker: Actor = { type: 'worker', id: 'win-desktop', channel: 'system' }
const system: Actor = { type: 'system', id: 'scheduler', channel: 'system' }

const ctx = { now: 1_700_000_000_000, newRunId: runId }

const base: TaskState = {
  id: taskId, status: 'queued', version: 3, requester, profile: 'readonly',
  attemptCount: 1, maxAttempts: 3, runSeq: 1, currentRunId: null, updatedAt: 1, liveInput: true,
}

const execution: Status[] = ['dispatching', 'running', 'awaiting_input', 'cancelling']
const terminalFinal: Status[] = ['succeeded', 'rejected']

function state(status: Status, patch: Partial<TaskState> = {}): TaskState {
  return {
    ...base, status,
    currentRunId: execution.includes(status) ? runId : null,
    inputRequestId: status === 'awaiting_input' ? 'req-1' : null,
    ...patch,
  }
}

/** 事件载荷：payloads 只提供「与状态无关」的字段，runId/requestId 在用例内按需覆盖。 */
const payloads = {
  SUBMIT: { decision: 'auto_approve', task: base },
  APPROVE: {}, REJECT: { reason: 'no' }, APPROVAL_EXPIRE: {},
  DISPATCH: { workerId: 'win-desktop', adapter: 'mock', workspaceId: 'sandbox' },
  RUN_ACCEPTED: { runId }, RUN_REFUSED: { runId }, DISPATCH_LOST: { runId },
  INPUT_REQUEST: { runId, requestId: 'req-1', question: 'Continue?', options: ['yes', 'no'] },
  INPUT_PROVIDE: { requestId: 'req-1', answer: 'yes' }, INPUT_EXPIRE: { runId },
  CANCEL: { reason: 'user' },
  RUN_SUCCEEDED: { runId }, RUN_FAILED: { runId }, RUN_TIMED_OUT: { runId }, RUN_CANCELLED: { runId },
  RUN_LOST: { runId }, RETRY: {},
} as const

const eventActor: Record<EventType, Actor> = {
  SUBMIT: owner, APPROVE: owner, REJECT: owner, APPROVAL_EXPIRE: system, DISPATCH: system,
  RUN_ACCEPTED: worker, RUN_REFUSED: worker, DISPATCH_LOST: system, INPUT_REQUEST: worker,
  INPUT_PROVIDE: owner, INPUT_EXPIRE: system, CANCEL: owner, RUN_SUCCEEDED: worker,
  RUN_FAILED: worker, RUN_TIMED_OUT: worker, RUN_CANCELLED: worker, RUN_LOST: system, RETRY: owner,
}

function event(type: EventType, patch: Record<string, unknown> = {}): TaskEvent {
  return { type, actor: eventActor[type], ...payloads[type], ...patch } as TaskEvent
}

// ---------------------------------------------------------------------------
// 规格矩阵解析（唯一事实来源：docs/specs/02-task-state-machine.md §3.2）
// ---------------------------------------------------------------------------

const spec = readFileSync(new URL('../../../docs/specs/02-task-state-machine.md', import.meta.url), 'utf8')

interface SpecRow {
  status: Status | null
  cells: string[]
}

function matrix(): { order: EventType[]; rows: SpecRow[] } {
  const section = spec.split('### 3.2 ')[1]!.split('注释：')[0]!
  const lines = section.split('\n').filter((line) => line.startsWith('| '))
  const header = lines[0]!.split('|').slice(1, -1).map((cell) => cell.trim())
  const order = header.slice(1).map((cell) => TaskEventType.parse(cell))
  const rows = lines.slice(2).map((line) => {
    const [name, ...cells] = line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('*', ''))
    return { status: name!.startsWith('∅') ? null : TaskStatus.parse(name), cells }
  })
  return { order, rows }
}

const specTable: ReadonlyMap<Status | 'missing', ReadonlyMap<EventType, string>> = (() => {
  const { order, rows } = matrix()
  return new Map(rows.map((row) => [row.status ?? 'missing',
    new Map(order.map((type, index) => [type, row.cells[index]!] as const))]))
})()

/** 从规格表推导「当前状态下合法且非幂等」的事件集（生成随机游走用，不依赖实现）。 */
function legalEvents(task: TaskState | null): EventType[] {
  const row = specTable.get(task?.status ?? 'missing')
  if (!row) return []
  return [...row].filter(([, cell]) => cell !== '—' && cell !== '=').map(([type]) => type)
}

/** 单元 'A'~'F' 在「尝试次数未用尽 / 已用尽」两种前提下的期望目标状态。 */
function expectedFor(cell: string, type: EventType, budget: 'available' | 'exhausted'): Status {
  switch (cell) {
    case 'A': return 'queued'
    case 'B': return budget === 'available' ? 'queued' : 'failed'
    case 'C':
      switch (type) {
        case 'INPUT_REQUEST': return 'awaiting_input'
        case 'RUN_SUCCEEDED': return 'succeeded'
        case 'RUN_FAILED': return 'failed'
        case 'RUN_TIMED_OUT': return 'timed_out'
        case 'RUN_CANCELLED': return 'cancelled'
        default: throw new Error('unexpected C cell for ' + type)
      }
    case 'D': return 'failed'
    case 'E': return 'cancelled'
    case 'F': return 'queued'
    default: return TaskStatus.parse(cell)
  }
}

describe('SM-1 规格矩阵', () => {
  const parsed = matrix()

  it('covers every TaskStatus x TaskEventType combination from the frozen table', () => {
    expect(parsed.order).toEqual([...TaskEventType.options])
    expect(parsed.rows).toHaveLength(TaskStatus.options.length + 1)
    expect(parsed.rows[0]!.status).toBeNull()
    const seen = new Set<string>()
    for (const row of parsed.rows) {
      expect(row.cells, 'row width for ' + (row.status ?? 'missing')).toHaveLength(TaskEventType.options.length)
      for (const [index, cell] of row.cells.entries()) {
        const key = (row.status ?? 'missing') + '/' + parsed.order[index]!
        expect(seen.has(key), 'duplicate cell ' + key).toBe(false)
        seen.add(key)
        // 每个单元格要么是目标状态、要么是 '='、要么是 '—'、要么是注释字母 A~F
        expect(cell === '=' || cell === '—' || /^[A-F]$/.test(cell) || TaskStatus.safeParse(cell).success,
          'unknown cell token ' + cell + ' at ' + key).toBe(true)
      }
    }
    expect(seen.size).toBe((TaskStatus.options.length + 1) * TaskEventType.options.length)
  })

  for (const budget of ['available', 'exhausted'] as const) {
    it('matches every cell with attempt budget ' + budget, () => {
      for (const row of parsed.rows) {
        const task = row.status === null ? null : state(row.status, {
          attemptCount: budget === 'available' ? 1 : 3,
          maxAttempts: 3,
          requesterCanRetry: true,
        })
        for (const [index, type] of parsed.order.entries()) {
          const cell = row.cells[index]!
          const label = (row.status ?? 'missing') + ' / ' + type + ' / ' + budget
          const result = reduce(task, event(type), ctx)
          if (cell === '—') {
            expect(result, label).toMatchObject({
              error: { code: row.status === null ? 'TASK_NOT_FOUND' : 'INVALID_TRANSITION' },
            })
            if (row.status !== null) {
              expect((result as { error: { status: number } }).error.status, label).toBe(409)
            }
            continue
          }
          if (cell === '=') {
            expect(result, label).toMatchObject({ next: task, writes: [], effects: [{ type: 'audit.noop' }] })
            continue
          }
          if ('error' in result) throw new Error(label + ' failed with ' + result.error.code)
          expect(result.next.status, label).toBe(expectedFor(cell, type, budget))
          expect(result.next.version, label).toBe((task?.version ?? 0) + (cell === 'C' ? 2 : 1))
          const transitions = result.effects.filter((effect) => effect.type === 'transition')
          expect(transitions, label).toHaveLength(cell === 'C' ? 2 : 1)
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// SM-2 / SM-3 / SM-5 / SM-6 / SM-7 单点行为
// ---------------------------------------------------------------------------

describe('SM-2 SUBMIT 策略', () => {
  it('maps each policy decision to its initial status', () => {
    for (const [decision, status] of [['auto_approve', 'queued'], ['require_approval', 'awaiting_approval'], ['deny', 'rejected']] as const) {
      const result = reduce(null, { type: 'SUBMIT', actor: requester, decision, task: base }, ctx)
      if ('error' in result) throw new Error(result.error.code)
      expect(result.next.status).toBe(status)
      expect(result.next.version).toBe(1)
      expect(result.next.runSeq).toBe(0)
      expect(result.next.attemptCount).toBe(0)
      expect(result.next.currentRunId).toBeNull()
      expect(result.next.errorCode).toBe(decision === 'deny' ? 'POLICY_DENIED' : null)
      expect(result.effects.filter((effect) => effect.type === 'timer')).toEqual(
        decision === 'require_approval' ? [{ type: 'timer', timer: 'approval', action: 'start' }] : [],
      )
    }
  })

  it('refuses SUBMIT from system and worker actors', () => {
    for (const actor of [system, worker]) {
      expect(reduce(null, { type: 'SUBMIT', actor, decision: 'auto_approve', task: base }, ctx))
        .toMatchObject({ error: { code: 'FORBIDDEN', status: 403 } })
    }
  })
})

describe('SM-3 注释 B：DISPATCH_LOST 的尝试次数分支', () => {
  it('requeues while attempts remain and fails at the ceiling', () => {
    const remaining = reduce(state('dispatching', { attemptCount: 1, maxAttempts: 3 }), event('DISPATCH_LOST'), ctx)
    expect(remaining).toMatchObject({ next: { status: 'queued', currentRunId: null }, writes: [{ status: 'lost' }] })
    const exhausted = reduce(state('dispatching', { attemptCount: 3, maxAttempts: 3 }), event('DISPATCH_LOST'), ctx)
    expect(exhausted).toMatchObject({
      next: { status: 'failed', errorCode: 'WORKER_LOST', currentRunId: null },
      writes: [{ type: 'run.update', status: 'lost' }],
    })
    if ('error' in exhausted) throw new Error(exhausted.error.code)
    expect(exhausted.effects.filter((effect) => effect.type === 'timer'))
      .toEqual([{ type: 'timer', timer: 'dispatch', action: 'clear' }])
  })
})

describe('SM-4 注释 C：dispatching 直接收到 finished（隐式受理）', () => {
  it('applies RUN_ACCEPTED then the terminal event in one step, version +2, audit flagged', () => {
    const task = state('dispatching', { version: 2, attemptCount: 1, runSeq: 1 })
    const result = reduce(task, event('RUN_SUCCEEDED'), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next).toMatchObject({ status: 'succeeded', version: 4, currentRunId: null })
    expect(result.writes).toEqual([
      { type: 'run.update', runId, status: 'running' },
      { type: 'run.update', runId, status: 'succeeded' },
    ])
    expect(result.effects.map((effect) => effect.type === 'transition'
      ? effect.event
      : effect.type + ':' + effect.timer + ':' + effect.action))
      .toEqual(['timer:dispatch:clear', 'timer:run:start', 'RUN_ACCEPTED', 'timer:run:clear', 'RUN_SUCCEEDED'])
    const accepted = result.effects[2] as { implicitAccept?: true; from?: Status; next?: TaskState }
    expect(accepted).toMatchObject({
      type: 'transition', implicitAccept: true, from: 'dispatching', next: { status: 'running' },
    })
    expect((result.effects[4] as { implicitAccept?: true }).implicitAccept).toBeUndefined()
  })

  it('implicitly accepts then reports a failure without double counting attempts', () => {
    const task = state('dispatching', { attemptCount: 1, maxAttempts: 3 })
    const result = reduce(task, event('RUN_FAILED', { errorCode: 'NONZERO_EXIT' }), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next).toMatchObject({ status: 'failed', errorCode: 'NONZERO_EXIT', attemptCount: 1 })
    expect(result.next.version).toBe(task.version + 2)
  })

  it('accepts a live input request received before the cmd.ack', () => {
    const task = state('dispatching', { liveInput: true })
    const result = reduce(task, event('INPUT_REQUEST'), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next).toMatchObject({ status: 'awaiting_input', currentRunId: runId, inputRequestId: 'req-1' })
    expect(result.next.version).toBe(task.version + 2)
    expect(result.writes).toContainEqual({
      type: 'input.open', requestId: 'req-1', runId, question: 'Continue?', options: ['yes', 'no'],
    })
  })
})

describe('SM-5 注释 D：RUN_LOST 的重试条件', () => {
  const lost = (patch: Partial<TaskState>) => reduce(state('running', patch), event('RUN_LOST'), ctx)

  it('requeues only for readonly runs with autoRetryOnWorkerLost and remaining attempts', () => {
    expect(lost({ profile: 'readonly', autoRetryOnWorkerLost: true, attemptCount: 1, maxAttempts: 3 }))
      .toMatchObject({ next: { status: 'queued' } })
    expect(lost({ profile: 'readonly', autoRetryOnWorkerLost: false, attemptCount: 1, maxAttempts: 3 }))
      .toMatchObject({ next: { status: 'failed', errorCode: 'WORKER_LOST' } })
    expect(lost({ profile: 'readonly', autoRetryOnWorkerLost: true, attemptCount: 3, maxAttempts: 3 }))
      .toMatchObject({ next: { status: 'failed', errorCode: 'WORKER_LOST' } })
    expect(lost({ profile: 'edit', autoRetryOnWorkerLost: true, attemptCount: 1, maxAttempts: 3 }))
      .toMatchObject({ next: { status: 'failed', errorCode: 'WORKER_LOST' } })
    expect(lost({ profile: 'full', autoRetryOnWorkerLost: true, attemptCount: 1, maxAttempts: 3 }))
      .toMatchObject({ next: { status: 'failed', errorCode: 'WORKER_LOST' } })
  })
})

describe('SM-6 / SM-7 cancelling 竞态', () => {
  it('prefers completion over cancellation', () => {
    expect(reduce(state('cancelling'), event('RUN_SUCCEEDED'), ctx))
      .toMatchObject({ next: { status: 'succeeded', currentRunId: null }, writes: [{ status: 'succeeded' }] })
  })

  it('settles on cancelled for failure, timeout, cancellation and worker loss', () => {
    for (const type of ['RUN_FAILED', 'RUN_TIMED_OUT', 'RUN_CANCELLED', 'RUN_LOST'] as const) {
      expect(reduce(state('cancelling'), event(type), ctx), type)
        .toMatchObject({ next: { status: 'cancelled', currentRunId: null } })
    }
  })

  it('maps refusals and lost dispatches while cancelling to cancelled (注释 E)', () => {
    for (const type of ['RUN_REFUSED', 'DISPATCH_LOST'] as const) {
      const result = reduce(state('cancelling', { attemptCount: 2 }), event(type), ctx)
      if ('error' in result) throw new Error(result.error.code)
      expect(result.next.status).toBe('cancelled')
      // RUN_REFUSED 不计入尝试次数，DISPATCH_LOST 计入（Run 记 lost）
      expect(result.next.attemptCount).toBe(type === 'RUN_REFUSED' ? 1 : 2)
      expect(result.writes).toContainEqual({
        type: 'run.update', runId, status: type === 'RUN_REFUSED' ? 'refused' : 'lost',
      })
    }
  })

  it('treats cancelling + INPUT_EXPIRE and + CANCEL as idempotent no-ops', () => {
    for (const type of ['INPUT_EXPIRE', 'CANCEL', 'RUN_ACCEPTED', 'INPUT_REQUEST'] as const) {
      expect(reduce(state('cancelling'), event(type), ctx), type)
        .toMatchObject({ effects: [{ type: 'audit.noop' }] })
    }
  })
})

// ---------------------------------------------------------------------------
// 审批 overrides 校验（02 §3.3 守卫 6）
// ---------------------------------------------------------------------------

describe('APPROVE overrides 校验', () => {
  const pending = (patch: Partial<TaskState> = {}) => state('awaiting_approval', patch)

  it('applies valid overrides and records them as writes', () => {
    const result = reduce(pending({ profile: 'readonly' }), event('APPROVE', {
      overrides: { profile: 'edit', adapter: 'mock', prompt: '改写后的需求' },
    }), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next.profile).toBe('edit')
    expect(result.writes).toContainEqual({
      type: 'task.overrides', overrides: { profile: 'edit', adapter: 'mock', prompt: '改写后的需求' },
    })
  })

  it('rejects unknown profiles, adapters and custom policy violations', () => {
    expect(reduce(pending(), event('APPROVE', { overrides: { profile: 'root' } }), ctx))
      .toMatchObject({ error: { code: 'PROFILE_NOT_ALLOWED', status: 422 } })
    expect(reduce(pending(), event('APPROVE', { overrides: { adapter: 'nope' } }), ctx))
      .toMatchObject({ error: { code: 'UNKNOWN_ADAPTER', status: 422 } })
    const strict = { ...ctx, validateOverrides: () => 'PROFILE_NOT_ALLOWED' as const }
    expect(reduce(pending(), event('APPROVE', { overrides: { profile: 'edit' } }), strict))
      .toMatchObject({ error: { code: 'PROFILE_NOT_ALLOWED', status: 422 } })
    expect(reduce(pending(), event('APPROVE', { overrides: { workspaceId: 'unknown-ws' } }), ctx))
      .toMatchObject({ next: { status: 'queued' } })
  })
})

describe('INPUT_EXPIRE 的取消副作用（SM-16 的 reducer 部分）', () => {
  it('moves to cancelling and emits a run.cancel with the input_timeout reason', () => {
    const result = reduce(state('awaiting_input'), event('INPUT_EXPIRE'), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next).toMatchObject({ status: 'cancelling', currentRunId: runId, inputRequestId: null })
    expect(result.writes).toContainEqual({ type: 'input.close', requestId: 'req-1' })
    expect(result.writes).toContainEqual({ type: 'run.update', runId, status: 'cancelling' })
    expect(result.effects).toContainEqual({ type: 'cancel', runId, reason: 'input_timeout' })
    expect(result.effects).toContainEqual({ type: 'timer', timer: 'cancel', action: 'start' })
  })
})

// ---------------------------------------------------------------------------
// SM-8 RETRY 权限 / 尝试次数 / Owner override
// ---------------------------------------------------------------------------

describe('SM-8 RETRY', () => {
  it('forbids requesters without the policy flag or on foreign tasks', () => {
    const failed = state('failed', { attemptCount: 1, maxAttempts: 3 })
    expect(reduce(failed, event('RETRY', { actor: requester }), ctx))
      .toMatchObject({ error: { code: 'FORBIDDEN', status: 403 } })
    expect(reduce(failed, event('RETRY', { actor: stranger }), ctx))
      .toMatchObject({ error: { code: 'FORBIDDEN', status: 403 } })
    expect(reduce(state('failed', { requesterCanRetry: true, attemptCount: 1, maxAttempts: 3 }),
      event('RETRY', { actor: requester }), ctx))
      .toMatchObject({ next: { status: 'awaiting_approval' } })
    expect(reduce(state('failed', { requesterCanRetry: true, attemptCount: 1, maxAttempts: 3 }),
      event('RETRY', { actor: requester, decision: 'auto_approve' }), ctx))
      .toMatchObject({ next: { status: 'queued' } })
    expect(reduce(state('failed', { requesterCanRetry: true, attemptCount: 1, maxAttempts: 3 }),
      event('RETRY', { actor: requester, decision: 'deny' }), ctx))
      .toMatchObject({ error: { code: 'FORBIDDEN' } })
  })

  it('returns 409 MAX_ATTEMPTS_REACHED for non-owners past the ceiling', () => {
    const failed = state('failed', { attemptCount: 3, maxAttempts: 3, requesterCanRetry: true })
    expect(reduce(failed, event('RETRY', { actor: requester, decision: 'auto_approve' }), ctx))
      .toMatchObject({ error: { code: 'MAX_ATTEMPTS_REACHED', status: 409 } })
    expect(reduce(failed, event('RETRY', { actor: system }), ctx))
      .toMatchObject({ error: { code: 'MAX_ATTEMPTS_REACHED', status: 409 } })
  })

  it('lets the Owner override the ceiling and records override=true in the audit effect', () => {
    const failed = state('failed', { attemptCount: 3, maxAttempts: 3, errorCode: 'WORKER_LOST', version: 9 })
    const result = reduce(failed, event('RETRY'), ctx)
    if ('error' in result) throw new Error(result.error.code)
    expect(result.next).toMatchObject({ status: 'queued', version: 10, errorCode: null, currentRunId: null })
    expect(result.effects.filter((effect) => effect.type === 'transition')).toEqual([
      expect.objectContaining({ type: 'transition', from: 'failed', event: 'RETRY', actor: owner, override: true }),
    ])
    // 未超限时不标注 override
    const normal = reduce(state('failed', { attemptCount: 1, maxAttempts: 3 }), event('RETRY'), ctx)
    if ('error' in normal) throw new Error(normal.error.code)
    expect((normal.effects.find((effect) => effect.type === 'transition') as { override?: true }).override)
      .toBeUndefined()
  })

  it('supports RETRY from every retryable terminal state but never from succeeded/rejected', () => {
    for (const status of ['failed', 'timed_out', 'cancelled'] as const) {
      expect(reduce(state(status), event('RETRY'), ctx), status).toMatchObject({ next: { status: 'queued' } })
    }
    for (const status of terminalFinal) {
      expect(reduce(state(status), event('RETRY'), ctx), status)
        .toMatchObject({ error: { code: 'INVALID_TRANSITION', status: 409 } })
    }
  })
})

// ---------------------------------------------------------------------------
// SM-9 乐观锁
// ---------------------------------------------------------------------------

describe('SM-9 乐观锁', () => {
  it('rejects stale expectedVersion with details.current', () => {
    const task = state('awaiting_approval', { version: 7 })
    for (const expectedVersion of [1, 6, 8]) {
      const result = reduce(task, event('APPROVE', { expectedVersion }), ctx)
      expect(result, String(expectedVersion)).toMatchObject({
        error: {
          code: 'VERSION_CONFLICT', status: 409,
          details: { current: { version: 7, status: 'awaiting_approval' } },
        },
      })
    }
    expect(reduce(task, event('APPROVE', { expectedVersion: 7 }), ctx)).toMatchObject({ next: { status: 'queued' } })
    // expectedVersion 校验先于矩阵合法性校验（陈旧请求不应得到 INVALID_TRANSITION）
    expect(reduce(state('succeeded', { version: 4 }), event('CANCEL', { expectedVersion: 3 }), ctx))
      .toMatchObject({ error: { code: 'VERSION_CONFLICT' } })
  })
})

// ---------------------------------------------------------------------------
// SM-10 权限矩阵（02 §3.5 每一格）
// ---------------------------------------------------------------------------

describe('SM-10 权限矩阵', () => {
  /** 每个事件选一个「矩阵合法」的状态，以便命中权限守卫。 */
  const legalState: Record<EventType, Status> = {
    SUBMIT: 'queued', APPROVE: 'awaiting_approval', REJECT: 'awaiting_approval',
    APPROVAL_EXPIRE: 'awaiting_approval', DISPATCH: 'queued', RUN_ACCEPTED: 'dispatching',
    RUN_REFUSED: 'dispatching', DISPATCH_LOST: 'dispatching', INPUT_REQUEST: 'running',
    INPUT_PROVIDE: 'awaiting_input', INPUT_EXPIRE: 'awaiting_input', CANCEL: 'queued',
    RUN_SUCCEEDED: 'running', RUN_FAILED: 'running', RUN_TIMED_OUT: 'running',
    RUN_CANCELLED: 'running', RUN_LOST: 'running', RETRY: 'failed',
  }

  type Expectation = Record<'owner' | 'self' | 'other' | 'system' | 'worker', boolean>

  const workerEvents: EventType[] = ['RUN_ACCEPTED', 'RUN_REFUSED', 'INPUT_REQUEST', 'RUN_SUCCEEDED',
    'RUN_FAILED', 'RUN_TIMED_OUT', 'RUN_CANCELLED']
  const timerEvents: EventType[] = ['DISPATCH', 'APPROVAL_EXPIRE', 'INPUT_EXPIRE', 'DISPATCH_LOST', 'RUN_LOST']

  function expectation(type: EventType): Expectation {
    const denied: Expectation = { owner: false, self: false, other: false, system: false, worker: false }
    // SUBMIT：reducer 只校验 actor 类型；未在白名单的用户由策略引擎 H3 以 decision=deny 拒绝
    if (type === 'SUBMIT') return { ...denied, owner: true, self: true, other: true }
    if (workerEvents.includes(type)) return { ...denied, worker: true }
    if (timerEvents.includes(type)) return { ...denied, system: true }
    switch (type) {
      case 'APPROVE':
      case 'REJECT': return { ...denied, owner: true }
      case 'CANCEL': return { ...denied, owner: true, system: true, self: true }
      // requesterCanRetry=true 时发起人可 RETRY（策略开关另行断言）
      case 'RETRY': return { ...denied, owner: true, system: true, self: true }
      case 'INPUT_PROVIDE': return { ...denied, owner: true, self: true }
      default: throw new Error('unmapped event ' + type)
    }
  }

  const actors = { owner, self: requester, other: stranger, system, worker } as const

  for (const type of TaskEventType.options) {
    it('enforces every actor cell for ' + type, () => {
      const expected = expectation(type)
      for (const [key, actor] of Object.entries(actors) as [keyof Expectation, Actor][]) {
        const task = type === 'SUBMIT' ? null : state(legalState[type], { requesterCanRetry: true })
        const result = reduce(task, { ...(event(type) as object), actor } as TaskEvent, ctx)
        const denied = 'error' in result && result.error.code === 'FORBIDDEN'
        expect(denied, type + ' / ' + key).toBe(!expected[key])
        if (expected[key]) expect('error' in result, type + ' / ' + key).toBe(false)
      }
    })
  }

  it('allows requesters to cancel running tasks unless the policy disables it', () => {
    const running = state('running')
    expect(reduce(running, event('CANCEL', { actor: requester }), ctx)).toMatchObject({ next: { status: 'cancelling' } })
    expect(reduce({ ...running, requesterCanCancelRunning: true }, event('CANCEL', { actor: requester }), ctx))
      .toMatchObject({ next: { status: 'cancelling' } })
    expect(reduce({ ...running, requesterCanCancelRunning: false }, event('CANCEL', { actor: requester }), ctx))
      .toMatchObject({ error: { code: 'FORBIDDEN' } })
    // 发起人对 dispatching / awaiting_input 无取消权（cancelling 下 CANCEL 是幂等 noop，见 §3.2 '='）
    for (const status of ['dispatching', 'awaiting_input'] as const) {
      expect(reduce(state(status), event('CANCEL', { actor: requester }), ctx), status)
        .toMatchObject({ error: { code: 'FORBIDDEN' } })
    }
  })
})

// ---------------------------------------------------------------------------
// SM-11 属性测试
// ---------------------------------------------------------------------------

describe('SM-11 200 步随机事件序列', () => {
  const actorKeys = ['owner', 'self', 'other', 'system', 'worker'] as const
  const actors: Record<typeof actorKeys[number], Actor> = {
    owner, self: requester, other: stranger, system, worker,
  }

  /** 每一步的随机选择：pick 从「规格推导的合法事件集」抽取，mode 控制是否故意发送非法/陈旧请求。 */
  interface Step {
    pick: number
    mode: 'legal' | 'illegal' | 'stale-run' | 'stale-version'
    actor: typeof actorKeys[number]
    decision: 'auto_approve' | 'require_approval' | 'deny'
    maxAttempts: number
    liveInput: boolean
    requesterCanRetry: boolean
    autoRetry: boolean
    profile: 'readonly' | 'edit'
  }

  const step: fc.Arbitrary<Step> = fc.record({
    pick: fc.integer({ min: 0, max: 1_000 }),
    // 大多数步骤沿规格表前进，少数故意发非法/陈旧帧以击中拒绝与陈旧事件路径
    mode: fc.constantFrom('legal', 'legal', 'legal', 'illegal', 'stale-run', 'stale-version'),
    actor: fc.constantFrom(...actorKeys),
    decision: fc.constantFrom('auto_approve', 'require_approval', 'deny'),
    // maxAttempts 随步骤抖动，使矩阵单元 B / D / F 的两个分支都被覆盖
    maxAttempts: fc.integer({ min: 1, max: 3 }),
    liveInput: fc.boolean(),
    requesterCanRetry: fc.boolean(),
    autoRetry: fc.boolean(),
    profile: fc.constantFrom('readonly', 'edit'),
  })

  function build(generated: Step, current: TaskState | null): { event: TaskEvent; task: TaskState | null } {
    const task = current && {
      ...current,
      liveInput: generated.liveInput,
      requesterCanRetry: generated.requesterCanRetry,
      autoRetryOnWorkerLost: generated.autoRetry,
      profile: generated.profile,
      maxAttempts: generated.maxAttempts,
    }
    const legal = legalEvents(current)
    const pool = legal.length ? legal : [...TaskEventType.options]
    const type = generated.mode === 'illegal'
      ? TaskEventType.options[generated.pick % TaskEventType.options.length]!
      : pool[generated.pick % pool.length]!
    const run = generated.mode === 'stale-run' || !current?.currentRunId ? staleRunId : current.currentRunId
    const patch: Record<string, unknown> = {
      actor: actors[generated.actor],
      ...(generated.mode === 'stale-version' && task ? { expectedVersion: task.version + 1 } : {}),
      ...(type === 'SUBMIT' ? { decision: generated.decision, task: base } : {}),
      ...(type === 'RETRY' ? { decision: generated.decision } : {}),
      ...(type === 'INPUT_PROVIDE' ? { requestId: current?.inputRequestId ?? 'req-1', answer: 'ok' } : {}),
      ...(type === 'INPUT_REQUEST' ? { runId: run, requestId: 'req-1', question: 'Q' } : {}),
      ...(['RUN_ACCEPTED', 'RUN_REFUSED', 'DISPATCH_LOST', 'INPUT_EXPIRE', 'RUN_SUCCEEDED', 'RUN_FAILED',
        'RUN_TIMED_OUT', 'RUN_CANCELLED', 'RUN_LOST'].includes(type) ? { runId: run } : {}),
    }
    return { event: { ...(event(type) as object), ...patch } as TaskEvent, task }
  }

  it('keeps every invariant after each step and freezes terminal states', () => {
    let coveredTransitions = 0
    const coveredStatuses = new Set<string>()
    fc.assert(fc.property(fc.array(step, { minLength: 200, maxLength: 200 }), (steps) => {
      let current: TaskState | null = null
      let dispatches = 0
      let refusals = 0
      for (const generated of steps) {
        /* 终态 succeeded / rejected 无任何合法事件：先验证拒绝，再开一个新任务继续随机游走 */
        if (current && terminalFinal.includes(current.status)) {
          const probe = reduce(current, { ...(event('CANCEL') as object), actor: owner } as TaskEvent, ctx)
          expect(probe, 'INV-6 ' + current.status).toMatchObject({ error: { code: 'INVALID_TRANSITION' } })
          current = null
          dispatches = 0
          refusals = 0
        }
        const { event: nextEvent, task } = build(generated, current)
        const frozen = structuredClone(task)
        const result = reduce(task, nextEvent, ctx)
        if ('error' in result) {
          // 失败不改变状态，且 reducer 不得就地修改入参
          expect(task).toEqual(frozen)
          continue
        }
        const previous = task
        const next = result.next
        const transitions = result.effects.filter((effect) => effect.type === 'transition')
        if (!transitions.length) {
          /* 幂等 noop 或陈旧 Run 事件：状态、版本、尝试次数均不变 */
          expect(next).toEqual(previous)
          expect(result.effects.length).toBeGreaterThan(0)
          continue
        }
        if (nextEvent.type === 'DISPATCH') dispatches++
        if (nextEvent.type === 'RUN_REFUSED') refusals++
        /* INV-5：状态变化则 version 增加，增量等于 transition effect 个数（隐式受理为 2） */
        expect(next.version).toBe((previous?.version ?? 0) + transitions.length)
        /* INV-2：执行态 <=> currentRunId 非空；非执行态不得残留 Run 绑定 */
        expect(next.currentRunId !== null, next.status).toBe(execution.includes(next.status))
        /* INV-6：终态 succeeded / rejected 永不再迁移 */
        if (previous) {
          expect(terminalFinal.includes(previous.status)).toBe(false)
          expect(next.version).toBeGreaterThan(previous.version)
          expect(next.runSeq).toBeGreaterThanOrEqual(previous.runSeq)
        }
        expect(next.runSeq).toBe(dispatches)
        /* INV-8：attempt_count = 非 refused 的 Run 数 */
        expect(next.attemptCount).toBe(dispatches - refusals)
        expect(next.attemptCount).toBeGreaterThanOrEqual(0)
        /* 写入的 Run 必须属于当前任务 */
        for (const write of result.writes) {
          if (write.type === 'run.create') expect(write.runId).toBe(next.currentRunId)
          else if (write.type === 'run.update' || write.type === 'input.open') expect(write.runId).toBe(runId)
        }
        current = next
        coveredTransitions += transitions.length
        coveredStatuses.add('from:' + (previous?.status ?? 'missing'))
        coveredStatuses.add('to:' + next.status)
      }
    }), { numRuns: 40 })
    /* 证明属性测试真的在状态机上游走（不是永远停在初态/永远被拒绝） */
    expect(coveredTransitions).toBeGreaterThan(1_000)
    for (const status of TaskStatus.options) expect(coveredStatuses.has('to:' + status), status).toBe(true)
    expect(coveredStatuses.has('from:missing')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SM-12 allowedActions() 与 reduce() 一致性
// ---------------------------------------------------------------------------

describe('SM-12 allowedActions 与 reduce 严格一致', () => {
  const mapped = {
    approve: 'APPROVE', reject: 'REJECT', cancel: 'CANCEL', retry: 'RETRY', input: 'INPUT_PROVIDE',
  } as const

  const actors = { owner, self: requester, other: stranger, system, worker } as const

  it('lists exactly the actions the reducer accepts for every status and actor', () => {
    for (const status of TaskStatus.options) {
      for (const [actorKey, actor] of Object.entries(actors)) {
        for (const retryFlag of [true, false]) {
          for (const budget of [0, 3] as const) {
            for (const liveInput of [true, false]) {
              const task = state(status, {
                attemptCount: budget, maxAttempts: 3, requesterCanRetry: retryFlag, liveInput,
              })
              const allowed = new Set(allowedActions(task, actor))
              for (const [action, type] of Object.entries(mapped) as [keyof typeof mapped, EventType][]) {
                const inputId = task.inputRequestId ?? 'req-1'
                const result = reduce(task, event(type, {
                  actor, requestId: inputId, ...(type === 'INPUT_PROVIDE' ? { answer: 'a' } : {}),
                }), ctx)
                const label = [status, actorKey, action, 'retry=' + retryFlag, 'budget=' + budget,
                  'live=' + liveInput].join(' / ')
                if ('error' in result && result.error.code === 'INVALID_TRANSITION') {
                  expect(allowed.has(action), label + ' (invalid transition)').toBe(false)
                } else if ('error' in result) {
                  // 权限或业务约束拒绝：不得出现在 allowedActions
                  expect(allowed.has(action), label + ' (' + result.error.code + ')').toBe(false)
                } else if (result.effects.every((effect) => effect.type === 'audit.noop')) {
                  expect(allowed.has(action), label + ' (noop)').toBe(false)
                } else {
                  expect(allowed.has(action), label + ' (accepted)').toBe(true)
                  expect(result.next.status, label).not.toBe(status)
                }
              }
              /* followup 只对可续接的终态开放（05 §4.2：rejected 未执行，不提供续跑） */
              const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(status)
              expect(allowed.has('followup'), status + ' followup').toBe(terminal && (
                actor.type === 'owner' || (actor.type === 'requester' && actor.id === requester.id)))
              expect(allowed.has('deliver_result')).toBe(
                actor.type === 'owner' && status === 'succeeded' && task.resultDeliveryStatus === 'pending_review')
            }
          }
        }
      }
    }
  })

  it('exposes deliver_result only for owner-reviewed successes', () => {
    const reviewed = state('succeeded', { resultDeliveryStatus: 'pending_review' })
    expect(allowedActions(reviewed, owner)).toContain('deliver_result')
    expect(allowedActions(reviewed, requester)).not.toContain('deliver_result')
    expect(allowedActions({ ...reviewed, resultDeliveryStatus: 'delivered' }, owner)).not.toContain('deliver_result')
  })
})
