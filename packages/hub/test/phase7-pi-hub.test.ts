/**
 * Pi 独立验收 · Phase 7a Hub 侧
 * 覆盖：BB-22 / BB-28 / BB-29、HO-3 / HO-4 / HO-6 / HO-8 / HO-13 / HO-15 ~ HO-18 / HO-22 / HO-24、
 * RT-8、RT-14、BC-2 / BC-3 / BC-4 / BC-6、INV-9 ~ INV-14。
 */
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { HANDOFF_DEFAULT_PROMPTS, RunDispatch, RunView, TaskDetail, TaskSummary, WorkerView } from '@agent-hub/protocol'
import type { BoardSnapshot } from '@agent-hub/protocol'
import { FakeClock } from '@agent-hub/common'
import { openStore } from '../src/plugins/store-sqlite/index.js'
import { safeOn } from '../src/kernel/safe.js'
import { assertInvariants, delay, FakeWorker, eventually, openHarness } from './pi/harness.js'
import { rest } from './pi/rest.js'
import { capabilities, dispatch, mockPrompt, owner, requester, snapshot } from './pi/phase7.js'
import { assertHarnessInvariants, boardContentPaths } from './pi/invariants.js'

function emit(worker: FakeWorker, run: { runId: string; taskId: string }, items: Array<Record<string, unknown>>) {
  worker.events(run.runId, run.taskId, items.map((item, index) => ({ ...item, seq: index + 1, ts: Date.now() + index })))
}
const started = (profile: 'readonly' | 'edit' = 'edit', pid = 1) => ({ kind: 'started', pid, effectiveProfile: profile,
  adapter: 'mock', commandSummary: 'mock' })
const succeeded = (extra: Record<string, unknown> = {}) => ({ kind: 'finished', status: 'succeeded', signal: null,
  exitCode: 0, summary: 'ok', durationMs: 1, cliSessionId: 'session-a', ...extra })
const failedRun = () => ({ kind: 'finished', status: 'failed', signal: null, exitCode: 2, summary: 'no', durationMs: 1 })
const applied = (board: string, inject: string, trust: string) => ({ board, inject, trust, bootstrap: false,
  verify: false, autoFixMaxRetries: 0, downgrades: [] })
const overlarge = (): BoardSnapshot => {
  const base = snapshot('first body')
  return { ...base, files: base.files.map((file, index) => index === 0
    ? { ...file, status: 'present' as const, bytes: 6000, overBudget: true, schemaOk: true, content: 'first body' } : file) }
}
const reasonOf = (promise: Promise<unknown>) => promise.then(() => 'ok',
  (error: { status: number; code?: string; details?: { reason?: string } }) =>
    error.status + ':' + String(error.details?.reason ?? error.code))

it('HO-3 keeps Requester stdin byte-identical while still persisting both snapshots', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho3', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner)
    const run = await dispatch(worker, task.id)
    expect(run.prompt).toBe(mockPrompt)
    expect(run.harness).toMatchObject({ board: 'capture', inject: 'none', trust: 'requester' })
    expect(run.harness).not.toHaveProperty('facts')
    emit(worker, run, [started(), { kind: 'harness', applied: applied('capture', 'none', 'requester'), board: snapshot('captured') },
      { kind: 'workspace', round: 0, board: snapshot('captured') }, succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    expect(hub.ctx.store.repos.snapshots.forRun(run.runId)).toHaveLength(2)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('HO-4/HO-6 apply allowRequesterBlackboard and the Hub workspace blackboard switch', async () => {
  const { hub, cleanup } = await openHarness({ harness: { workspaces: {
    sandbox: { allowRequesterBlackboard: true }, backend: { blackboard: false } } } })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho4', headers: capabilities })
    const open = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, requester)
    await hub.ctx.orchestrator.approve(open.id, owner)
    const requesterRun = await dispatch(worker, open.id)
    expect(requesterRun.harness).toMatchObject({ board: 'write', trust: 'requester', bootstrap: false, inject: 'fresh' })
    expect(requesterRun.harness?.facts?.currentRun.trust).toBe('requester')
    const ownerTask = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'backend', profile: 'edit' }, owner)
    const ownerRun = await dispatch(worker, ownerTask.id)
    expect(ownerRun.harness).toMatchObject({ board: 'off', inject: 'fresh', trust: 'owner' })
    expect(ownerRun.harness?.facts?.currentRun.runId).toBe(ownerRun.runId)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('HO-8 follows the handoff validation table and fills adapter/prompt defaults', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho8', headers: capabilities })
    const live = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, owner)
    // 未终态 → INVALID_TRANSITION
    expect(await reasonOf(hub.ctx.orchestrator.handoff(live.id, owner, { intent: 'relay' }))).toBe('409:INVALID_TRANSITION')
    const run = await dispatch(worker, live.id)
    emit(worker, run, [started(), succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    // Requester → 403
    expect(await reasonOf(hub.ctx.orchestrator.handoff(live.id, requester, { intent: 'relay' }))).toBe('403:FORBIDDEN')
    // 他任务的 Run → 404 RUN_NOT_FOUND
    const other = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, owner)
    const otherRun = await dispatch(worker, other.id)
    expect(await reasonOf(hub.ctx.orchestrator.handoff(live.id, owner, { intent: 'relay', fromRunId: otherRun.runId })))
      .toBe('404:RUN_NOT_FOUND')
    // 缺省 adapter / prompt
    const relay = await hub.ctx.orchestrator.handoff(live.id, owner, { intent: 'relay' })
    expect(relay.prompt).toBe(HANDOFF_DEFAULT_PROMPTS.relay)
    expect(relay.handoff).toMatchObject({ fromRunId: run.runId, intent: 'relay' })
    expect(relay.resumeSessionId).toBeUndefined()
    const fix = await hub.ctx.orchestrator.handoff(live.id, owner, { intent: 'fix' })
    expect(fix.adapter).toBe('mock')
    expect(fix.prompt).toBe(HANDOFF_DEFAULT_PROMPTS.fix)
    expect(hub.ctx.store.repos.tasks.get(fix.id)?.resumeSessionId).toBe('session-a')
    // 终态但没有已启动 Run → 409 NO_STARTED_RUN
    const never = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, owner)
    await hub.ctx.orchestrator.cancel(never.id, owner, { reason: 'pi' })
    expect(await reasonOf(hub.ctx.orchestrator.handoff(never.id, owner, { intent: 'relay' }))).toBe('409:NO_STARTED_RUN')
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 25000)

it('HO-13/HO-24 surface interleavedUnknown and workspace.unaccepted in the frozen facts', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho13', headers: capabilities })
    const first = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, owner)
    const r1 = await dispatch(worker, first.id)
    emit(worker, r1, [started(), { kind: 'workspace', round: 0, board: snapshot('attempt body') }, succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(r1.runId)?.status === 'succeeded')
    // HO-13：把 base Run 模拟成 Phase 7 之前的 Run（无 workspace_seq，也没有指针记录）
    hub.ctx.store.repos.prepare('UPDATE task_runs SET workspace_seq = NULL WHERE id = ?').run(r1.runId)
    hub.ctx.store.repos.prepare('UPDATE workspace_pointers SET attempt_counter = 0, last_attempt_run_id = NULL, '
      + 'last_attempt_seq = NULL, last_accepted_run_id = NULL, last_accepted_seq = NULL, accepted_by = NULL '
      + 'WHERE worker_id = ? AND workspace_id = ?').run('pi-ho13', 'sandbox')
    const child = await hub.ctx.orchestrator.handoff(first.id, owner, { intent: 'relay', prompt: mockPrompt })
    const relay = await dispatch(worker, child.id)
    expect(relay.harness?.facts?.continuity).toMatchObject({ baseRunId: r1.runId, interleavedUnknown: true })
    const preview = hub.ctx.orchestrator.handoffPreview(first.id, owner, {})
    expect(preview.warnings).toContain('INTERLEAVED_UNKNOWN')
    expect(preview.promptPreview).toContain('cannot tell whether other runs changed this workspace')
    // 接力 Run 失败 → lastAttempt ≠ lastAccepted（HO-24）
    emit(worker, relay, [started('edit', 2), failedRun()])
    await eventually(() => hub.ctx.store.repos.runs.get(relay.runId)?.status === 'failed')
    const pointer = hub.ctx.store.repos.pointers.get('pi-ho13', 'sandbox')!
    expect(pointer.lastAttemptRunId).toBe(relay.runId)
    expect(pointer.lastAcceptedRunId).toBeNull()   // 接力 Run 失败，未自动采纳
    const fresh = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox', profile: 'edit' }, owner)
    const freshRun = await dispatch(worker, fresh.id)
    const facts = freshRun.harness?.facts
    expect(facts?.workspace.unaccepted?.runId).toBe(relay.runId)
    expect(facts?.workspace.lastAttempt?.runId).toBe(relay.runId)
    expect(facts?.currentRun.runId).toBe(freshRun.runId)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 25000)

it('HO-16/HO-22 apply the 7a auto-accept matrix and gate a Requester board deletion', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho16', headers: capabilities })
    const pointer = () => hub.ctx.store.repos.pointers.get('pi-ho16', 'sandbox')
    let seq = 0
    const runTo = async (actor: typeof owner | typeof requester, profile: 'edit' | 'readonly',
      status: 'succeeded' | 'failed', post: BoardSnapshot) => {
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile }, actor)
      if (actor === requester) await hub.ctx.orchestrator.approve(task.id, owner)
      const run = await dispatch(worker, task.id)
      seq++
      emit(worker, run, [started(profile, seq), { kind: 'harness', applied: applied('capture', 'none', actor.type),
        board: snapshot('before') }, { kind: 'workspace', round: 0, board: post },
      { ...(status === 'succeeded' ? succeeded() : failedRun()) }])
      await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === status)
      return { task, run }
    }
    const ok = await runTo(owner, 'edit', 'succeeded', snapshot())
    expect(pointer()).toMatchObject({ lastAcceptedRunId: ok.run.runId, acceptedBy: 'auto' })
    const accepted = pointer()!.lastAcceptedRunId
    const bad = await runTo(owner, 'edit', 'failed', snapshot())
    expect(pointer()?.lastAcceptedRunId).toBe(accepted)
    expect(pointer()?.lastAttemptRunId).toBe(bad.run.runId)
    await runTo(requester, 'edit', 'succeeded', snapshot())          // Requester → 不推进
    expect(pointer()?.lastAcceptedRunId).toBe(accepted)
    await runTo(owner, 'readonly', 'succeeded', snapshot())          // 只读 → 不推进
    expect(pointer()?.lastAcceptedRunId).toBe(accepted)
    const before = snapshot()
    const gated = await runTo(requester, 'edit', 'succeeded', { ...before,
      files: before.files.map((file, index) => index === 0
        ? { ...file, status: 'absent' as const, bytes: 0, lines: 0, schemaOk: false } : file) })
    expect(hub.ctx.orchestrator.getTask(gated.task.id)?.resultDeliveryStatus).toBe('pending_review')
    expect(hub.ctx.orchestrator.getTask(gated.task.id)!.timeline.map(entry => entry.event))
      .toContain('task.harness.result_gated')
    expect(JSON.stringify(hub.ctx.store.repos.runs.get(gated.run.runId)?.harnessJson)).toContain('BOARD_DELETED')
    expect(pointer()?.lastAttemptRunId).toBe(gated.run.runId)
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 35000)

it('HO-15/HO-18 keep the pointer monotone through duplicate acceptance and every acceptRun failure', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-ho15', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const run = await dispatch(worker, task.id)
    // 两条 RUN_ACCEPTED 路径：cmd.ack 与 started 事件
    await worker.ackCommand(worker.frames.find(frame => frame.type === 'run.dispatch')!)
    emit(worker, run, [started(), succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    expect(hub.ctx.store.repos.pointers.get('pi-ho15', 'sandbox')?.attemptCounter).toBe(1)
    expect(hub.ctx.store.repos.runs.get(run.runId)?.workspaceSeq).toBe(1)
    const before = hub.ctx.store.repos.pointers.get('pi-ho15', 'sandbox')
    // 回放旧帧（seq ≤ last_seq）不得改动指针或计数
    emit(worker, run, [succeeded()])
    await delay(200)
    expect(hub.ctx.store.repos.pointers.get('pi-ho15', 'sandbox')).toEqual(before)
    const readonly = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'readonly' }, owner)
    const readonlyRun = await dispatch(worker, readonly.id)
    emit(worker, readonlyRun, [started('readonly', 2), succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(readonlyRun.runId)?.status === 'succeeded')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'sandbox', owner,
      { runId: readonlyRun.runId, expectedAcceptedRunId: before!.lastAcceptedRunId }))).toBe('409:NOT_WRITE_RUN')
    const failing = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const failingRun = await dispatch(worker, failing.id)
    emit(worker, failingRun, [started('edit', 3), failedRun()])
    await eventually(() => hub.ctx.store.repos.runs.get(failingRun.runId)?.status === 'failed')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'sandbox', owner,
      { runId: failingRun.runId, expectedAcceptedRunId: before!.lastAcceptedRunId }))).toBe('409:RUN_NOT_SUCCEEDED')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'sandbox', owner,
      { runId: run.runId, expectedAcceptedRunId: 'run_' + 'X'.repeat(26) }))).toBe('409:VERSION_CONFLICT')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'sandbox', owner,
      { runId: run.runId, expectedAcceptedRunId: before!.lastAcceptedRunId }))).toBe('409:NOT_NEWER')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'nope', owner,
      { runId: run.runId, expectedAcceptedRunId: null }))).toBe('422:UNKNOWN_WORKSPACE')
    expect(await reasonOf(hub.ctx.orchestrator.acceptRun('pi-ho15', 'sandbox', requester,
      { runId: run.runId, expectedAcceptedRunId: null }))).toBe('403:FORBIDDEN')
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 35000)

it('HO-17 keeps the pointer frozen when a stale finished frame is replayed after a Hub restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ho17-'))
  const settings = { storage: { path: join(dir, 'hub.sqlite') }, server: { port: 0, allowInsecureWorker: true } }
  let opened = await openHarness(settings)
  let cleanup = opened.cleanup
  try {
    const worker = await FakeWorker.connect(opened.hub, { workerId: 'pi-ho17', headers: capabilities })
    const task = await opened.hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const run = await dispatch(worker, task.id)
    const replay = [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock', seq: 1, ts: 1 },
      { kind: 'workspace', round: 0, board: snapshot(), seq: 2, ts: 2 },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'ok', durationMs: 1, seq: 3, ts: 3 },
    ]
    worker.events(run.runId, run.taskId, replay)
    await eventually(() => opened.hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    expect(opened.hub.ctx.store.repos.pointers.get('pi-ho17', 'sandbox')?.lastAcceptedRunId).toBe(run.runId)
    const identity = worker.identity
    await cleanup()
    opened = await openHarness(settings)
    cleanup = opened.cleanup
    const audits = () => opened.hub.ctx.store.repos
      .prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'task.workspace.accepted'").get() as { n: number }
    const count = audits().n
    const again = await FakeWorker.connect(opened.hub, { workerId: 'pi-ho17', identity, headers: capabilities })
    again.events(run.runId, run.taskId, replay)
    await delay(400)
    expect(opened.hub.ctx.store.repos.pointers.get('pi-ho17', 'sandbox')?.lastAcceptedRunId).toBe(run.runId)
    expect(audits().n).toBe(count)
    assertInvariants(opened.hub.ctx.store.repos)
    assertHarnessInvariants(opened.hub.ctx.store.repos)
  } finally {
    await cleanup()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* sqlite 句柄可能仍被占用 */ }
  }
}, 35000)

it('BB-22/BB-29 audit a readonly violation and warn about an over-budget board', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-bb22', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'readonly' }, owner)
    const run = await dispatch(worker, task.id)
    emit(worker, run, [started('readonly'), { kind: 'harness', applied: applied('read', 'fresh', 'owner'), board: snapshot('before') },
      { kind: 'workspace', round: 0, board: snapshot('after'), readonlyCheck: 'violation', readonlyPaths: ['.board/HANDOFF.md'] },
      succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    expect(hub.ctx.orchestrator.getTask(task.id)!.timeline.map(entry => entry.event))
      .toContain('task.harness.readonly_violation')
    expect(hub.ctx.orchestrator.runHarness(task.id, run.runId).readonlyCheck).toBe('violation')
    expect(RunView.parse(hub.ctx.orchestrator.getTask(task.id)!.runs[0]!).harness?.readonlyCheck).toBe('violation')
    const over = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const overRun = await dispatch(worker, over.id)
    emit(worker, overRun, [started('edit', 2), { kind: 'harness', applied: applied('write', 'fresh', 'owner'), board: overlarge() },
      { kind: 'workspace', round: 0, board: overlarge() }, succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(overRun.runId)?.status === 'succeeded')
    expect(RunView.parse(hub.ctx.orchestrator.getTask(over.id)!.runs[0]!).harness?.boardWarnings).toContain('OVER_BUDGET')
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 25000)

it('BB-28/RT-14 leak no board body into task_logs, run/events, run/updated or REST payloads', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const events: unknown[] = []
    const runs: unknown[] = []
    const offRunEvents = safeOn(hub.ctx, 'run/events', (_runId, _taskId, batch) => { events.push(...batch) })
    const offRunUpdated = safeOn(hub.ctx, 'run/updated', view => { runs.push(view) })
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-bb28', headers: capabilities })
    const marker = 'PI-SECRET-BOARD-MARKER-' + 'q'.repeat(40)
    const call = rest(hub)
    const token = hub.ctx.auth.createApiToken('pi-bb28', ['admin'])
    for (let round = 0; round < 2; round++) {
      const task = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, owner)
      const run = await dispatch(worker, task.id)
      emit(worker, run, [started('edit', round + 1), { kind: 'harness', applied: applied('write', 'fresh', 'owner'),
        board: snapshot(marker) }, { kind: 'workspace', round: 0, board: snapshot(marker + '-after') },
      succeeded({ summary: marker + ' summary' })])
      await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
      // 授权面（Owner 审计视图）可以读到正文
      expect(hub.ctx.orchestrator.runHarness(task.id, run.runId).board.pre?.files[0]?.content).toBe(marker)
      const api = await call('GET', '/api/v1/tasks/' + task.id + '/runs/' + run.runId + '/harness', { token })
      expect(api.status, api.body).toBe(200)
      expect(api.body).toContain(marker)
    }
    const rows = hub.ctx.store.repos.prepare('SELECT id, data_json FROM task_logs').all() as
      Array<{ id: number; data_json: string | null }>
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      if (!row.data_json) continue
      expect(boardContentPaths(JSON.parse(row.data_json)), 'task_logs#' + row.id).toEqual([])
    }
    expect(boardContentPaths(events)).toEqual([])
    expect(JSON.stringify(events).includes(marker)).toBe(true)   // summary 中的文本属于 finished 正文，不是黑板正文
    expect(JSON.stringify(events)).not.toMatch(/[A-Za-z]:[\\/]/u)
    expect(JSON.stringify(runs)).not.toMatch(/[A-Za-z]:[\\/]/u)
    offRunEvents(); offRunUpdated()
    assertInvariants(hub.ctx.store.repos)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 35000)

it('RT-8 rejects non-Owner handoff/acceptance at service and REST scope level', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const call = rest(hub)
    const admin = hub.ctx.auth.createApiToken('pi-rt8', ['admin'])
    const reader = hub.ctx.auth.createApiToken('pi-rt8-read', ['read'])
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-rt8', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'plain', workspaceId: 'sandbox', profile: 'edit' }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner)
    const run = await dispatch(worker, task.id)
    emit(worker, run, [started(), succeeded()])
    await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
    expect((await call('POST', '/api/v1/tasks/' + task.id + '/handoff', { token: reader, payload: { intent: 'relay' } })).status)
      .toBe(403)
    const acceptUrl = '/api/v1/workspaces/pi-rt8/sandbox/accept'
    expect((await call('POST', acceptUrl, { token: reader, payload: { runId: run.runId, expectedAcceptedRunId: null } })).status)
      .toBe(403)
    const created = await call('POST', '/api/v1/tasks/' + task.id + '/handoff', { token: admin, payload: { intent: 'relay' } })
    expect(created.status, created.body).toBe(201)
    expect(TaskDetail.parse(created.json()).handoff).toMatchObject({ fromRunId: run.runId, intent: 'relay' })
    expect((await call('POST', acceptUrl, { token: admin, payload: { runId: run.runId, expectedAcceptedRunId: null } })).status)
      .toBe(200)
    assertHarnessInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
}, 25000)

it('BC-2/BC-6 keep the Phase 6 wire and DTO surfaces free of harness fields', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-bc2', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario:success', workspaceId: 'sandbox', profile: 'edit' }, owner)
    const dispatchFrame = await worker.waitFor('run.dispatch')
    expect(dispatchFrame.payload).not.toHaveProperty('harness')
    expect(Object.keys(RunDispatch.parse(JSON.parse(JSON.stringify(dispatchFrame.payload)))).sort())
      .toEqual(['adapter', 'attempt', 'idleTimeoutMs', 'notAfter', 'origin', 'profile', 'prompt', 'runId', 'taskNo',
        'taskId', 'timeoutMs', 'workspaceId'].sort())
    const detail = hub.ctx.orchestrator.getTask(task.id)!
    expect(TaskDetail.parse(detail)).not.toHaveProperty('handoff')
    expect(RunView.parse(detail.runs[0]!)).not.toHaveProperty('harness')
    const summary = hub.ctx.orchestrator.listTasks({}, owner).items.find(item => item.id === task.id)!
    expect(TaskSummary.parse(summary)).not.toHaveProperty('verification')
    expect(WorkerView.parse(hub.ctx.workers.get('pi-bc2')!).protocolCapabilities).toEqual(['blackboard.v1'])
    const legacy = await FakeWorker.connect(hub, { workerId: 'pi-bc2-legacy' })
    expect(WorkerView.parse(hub.ctx.workers.get('pi-bc2-legacy')!)).not.toHaveProperty('protocolCapabilities')
    legacy.close()
    assertInvariants(hub.ctx.store.repos)
  } finally { await cleanup() }
})

it('BC-4 refuses to open a database created by a newer Hub', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bc4-'))
  try {
    const path = join(dir, 'hub.sqlite')
    const db = new Database(path)
    const latest = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+_.+\.sql$/u.test(f)).length
    db.pragma('user_version=' + (latest + 1))
    db.close()
    expect(() => openStore({ path }, new FakeClock(1))).toThrow(/newer Hub/u)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* sqlite 句柄可能仍被占用 */ }
  }
})

it('BC-3 upgrades a Phase 6 file in place, keeps rows and leaves new columns NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bc3-'))
  try {
    const path = join(dir, 'hub.sqlite')
    const migrations = new URL('../migrations/', import.meta.url)
    const legacy = new Database(path)
    for (const name of readdirSync(migrations).filter(entry => /^000[012]_.*\.sql$/u.test(entry)).sort()) {
      legacy.exec(readFileSync(new URL(name, migrations), 'utf8'))
    }
    legacy.prepare("INSERT INTO workers(id,display_name,public_key,key_fingerprint,created_at,updated_at) VALUES ('v3','V3','k','f',1,1)").run()
    legacy.pragma('user_version=3')
    legacy.close()
    const store = openStore({ path }, new FakeClock(2))
    try {
      expect(store.repos.pragma('user_version', { simple: true })).toBe(readdirSync(migrations).filter(f => /^\d+_.+\.sql$/u.test(f)).length)
      expect(store.repos.workers.get('v3')).toMatchObject({ id: 'v3', protocolCapsJson: null })
      expect(store.repos.prepare('SELECT count(*) AS n FROM workspace_pointers').get()).toEqual({ n: 0 })
      assertInvariants(store.repos)
      assertHarnessInvariants(store.repos)
    } finally { store.close() }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* sqlite 句柄可能仍被占用 */ }
  }
})
