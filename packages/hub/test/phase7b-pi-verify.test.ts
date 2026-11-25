/**
 * Pi 独立验收 · Phase 7b Hub 侧（HP-12、VF-25 ~ VF-29、BC-9 ~ BC-10、CR-9、INV-11 / INV-13 / INV-14）
 *
 * 只用 FakeWorker 驱动线上事件，结论一律从 DB 与公开 DTO 读取，并复用
 * pi/invariants.ts 的 assertHarnessInvariants 做 INV-9 ~ INV-14 的独立校验。
 */
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoAcceptDecision } from '@agent-hub/protocol'
import { expect, it } from 'vitest'
import { assertInvariants, eventually, FakeWorker, openHarness } from './pi/harness.js'
import { assertVerificationInvariants } from './pi/verify-invariants.js'
import { assertPhase6Event } from './pi/frozen.js'
import { dispatch, mockPrompt, owner, requester } from './pi/phase7.js'
import { Journal } from '../../worker/src/runner/journal.js'
import { downgradeEvent } from '../../worker/src/harness/downgrade.js'
import { FakeClock, runId, taskId } from '@agent-hub/common'

const caps = { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' }
const blackboardOnly = { 'X-Agent-Hub-Capabilities': 'blackboard.v1' }

const spec = (over: Record<string, unknown> = {}) => ({
  board: 'write' as const, inject: 'fresh' as const, trust: 'owner' as const, bootstrap: false,
  verify: true, autoFixMaxRetries: 0, downgrades: [] as unknown[], ...over,
})

const startedEvent = (seq = 1) => ({ kind: 'started', seq, ts: 1000 + seq, pid: 1, adapter: 'mock', effectiveProfile: 'edit', commandSummary: 'mock' })
const harnessEvent = (applied = spec(), seq = 2) => ({ kind: 'harness', seq, ts: 1000 + seq, applied })
const changes = { added: 1, modified: 0, deleted: 0, links: 0, total: 1, boardOnly: false,
  sample: [{ path: 'src.txt', change: 'added' }], truncated: false }
const workspaceEvent = (seq = 3, round = 0) => ({ kind: 'workspace', seq, ts: 1000 + seq, round, changes })
const verifyStarted = (seq = 4, attempt = 1, commands = ['check']) =>
  ({ kind: 'verify', seq, ts: 1000 + seq, attempt, phase: 'started', commands })
const verifyResult = (seq = 5, attempt = 1, status: 'passed' | 'failed' = 'passed', commands = ['check']) =>
  ({ kind: 'verify', seq, ts: 1000 + seq, attempt, phase: 'result', commands, status,
    results: [{ id: commands[0], status, exitCode: status === 'passed' ? 0 : 2, signal: null, durationMs: 7 }] })
const finishedEvent = (seq: number, verification?: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ kind: 'finished', seq, ts: 1000 + seq, status: 'succeeded', exitCode: 0, signal: null, summary: 'done', durationMs: 9,
    ...(verification && { verification }), ...over })

const baseInput = { adapter: 'mock' as const, workspaceId: 'sandbox', profile: 'edit' as const, prompt: mockPrompt }

it('HP-12/BC-9 downgrades every 7b frame into a Phase 6 shape and keeps seq/ts', () => {
  const verifyStartedFrame = { kind: 'verify' as const, seq: 7, ts: 70, attempt: 1, phase: 'started' as const, commands: ['check'] }
  const verifyFailedFrame = { kind: 'verify' as const, seq: 8, ts: 80, attempt: 2, phase: 'result' as const, commands: ['check'],
    status: 'failed' as const, results: [{ id: 'check', status: 'failed' as const, exitCode: 1, signal: null, durationMs: 1 }] }
  const harnessFrame = { kind: 'harness' as const, seq: 2, ts: 20, applied: spec({ verify: true }),
    manifest: { files: 1, bytes: 1, hashed: 1, links: 0, truncated: false, durationMs: 0 },
    board: { dir: 'absent' as const, capturedAt: 1, files: [], agentsMd: { status: 'absent' as const, bytes: 0 } } }
  const workspaceFrame = { kind: 'workspace' as const, seq: 3, ts: 30, round: 1, changes,
    tamper: { total: 1, paths: ['package.json'], links: 0 } }
  const finishedFrame = { kind: 'finished' as const, seq: 9, ts: 90, status: 'succeeded' as const, exitCode: 0, signal: null,
    summary: '', durationMs: 1, verification: { status: 'passed' as const, attempts: 1, failed: [] } }
  // 7a 能力（只有 blackboard.v1，无 verify.v1）
  expect(downgradeEvent(verifyStartedFrame, ['blackboard.v1'])).toEqual({ kind: 'progress', seq: 7, ts: 70, phase: 'verify',
    detail: 'attempt 1 started' })
  expect(downgradeEvent(verifyFailedFrame, ['blackboard.v1'])).toMatchObject({ kind: 'progress', seq: 8, ts: 80,
    detail: 'attempt 2 failed' })
  expect(downgradeEvent(finishedFrame, ['blackboard.v1'])).not.toHaveProperty('verification')
  const harness7a = downgradeEvent(harnessFrame, ['blackboard.v1'])
  expect(harness7a).toMatchObject({ kind: 'harness', seq: 2, ts: 20 })
  expect(harness7a).not.toHaveProperty('manifest')
  expect(harness7a).toHaveProperty('board')
  const workspace7a = downgradeEvent(workspaceFrame, ['blackboard.v1'])
  expect(workspace7a).toMatchObject({ kind: 'workspace', round: 1, seq: 3, ts: 30 })
  expect(workspace7a).not.toHaveProperty('changes')
  expect(workspace7a).not.toHaveProperty('tamper')
  // Phase 6 对等端（无任何能力）→ 新 kind 全部退化为 progress
  expect(downgradeEvent(harnessFrame, [])).toMatchObject({ kind: 'progress', phase: 'harness.pre', detail: 'board=write' })
  expect(downgradeEvent(workspaceFrame, [])).toMatchObject({ kind: 'progress', phase: 'harness.post', detail: 'round 1' })
  // 协商成功 → 逐字节不变
  for (const frame of [verifyStartedFrame, finishedFrame, harnessFrame, workspaceFrame]) {
    expect(downgradeEvent(frame as never, ['blackboard.v1', 'verify.v1'])).toBe(frame)
  }
})



it('VF-4/VF-25 records a passed verification, the live progress line and a clean pointer', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-vf4', headers: caps })
    const task = await api.createTask(baseInput, owner)
    const run = await dispatch(worker, task.id)
    expect(api.getTask(task.id)?.verification).toBe('pending')
    expect(run.harness?.verify).toEqual({ autoFixMaxRetries: 0 })
    worker.events(run.runId, task.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    await eventually(() => api.getTask(task.id)?.verification === 'running')
    expect(db.runs.get(run.runId)?.verificationStatus).toBe('running')
    expect(api.getTask(task.id)?.lastProgress).toContain('check')
    worker.events(run.runId, task.id, [verifyResult(), finishedEvent(6, { status: 'passed', attempts: 1, failed: [] })])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded')
    expect(api.getTask(task.id)?.verification).toBe('passed')
    expect(api.getTask(task.id)?.runs[0]?.harness?.verification).toMatchObject({ state: 'passed', attempts: 1, failed: [] })
    const view = api.runHarness(task.id, run.runId)
    expect(view.verification?.outcome).toMatchObject({ status: 'passed' })
    expect(view.verification?.attempts).toMatchObject([{ attempt: 1, commands: ['check'], status: 'passed' }])
    expect(view.canAccept).toBe(false)
    expect(db.pointers.get('pi-vf4', 'sandbox')?.lastAcceptedRunId).toBe(run.runId)
    expect(db.pointers.get('pi-vf4', 'sandbox')?.acceptedBy).toBe('auto')
    assertInvariants(db)
    assertVerificationInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it.each([['INTERNAL', undefined], ['WORKER_RESTARTED', 'WORKER_RESTARTED']] as const)(
  'VF-26 falls back to unverified/%s when finished carries no verification', async (reason, errorCode) => {
    const { hub, cleanup } = await openHarness()
    try {
      const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
      const worker = await FakeWorker.connect(hub, { workerId: 'pi-vf26', headers: caps })
      const task = await api.createTask(baseInput, owner)
      const run = await dispatch(worker, task.id)
      worker.events(run.runId, task.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
      await eventually(() => api.getTask(task.id)?.verification === 'running')
      worker.events(run.runId, task.id, [finishedEvent(5, undefined, { ...(errorCode && { errorCode }) })])
      await eventually(() => api.getTask(task.id)?.verification === 'unverified')
      const view = api.runHarness(task.id, run.runId)
      expect(view.verification?.outcome).toMatchObject({ status: 'unverified', reason, failed: [] })
      // 未验证 → 不自动采纳
      expect(db.pointers.get('pi-vf26', 'sandbox')?.lastAcceptedRunId).toBeNull()
      assertVerificationInvariants(db)
    } finally { await cleanup() }
  }, 30_000)

it('VF-27/CR-8 resolves a lost verification exactly once and blocks acceptance', async () => {
  const { hub, cleanup } = await openHarness({ workers: { gracePeriodMs: 100 } })
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-vf27', headers: caps })
    const task = await api.createTask(baseInput, owner)
    const run = await dispatch(worker, task.id)
    worker.events(run.runId, task.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    await eventually(() => api.getTask(task.id)?.verification === 'running')
    worker.terminate()
    await eventually(() => db.runs.get(run.runId)?.verificationStatus === 'unverified', { timeoutMs: 15_000 })
    expect(api.runHarness(task.id, run.runId).verification?.outcome).toMatchObject({ reason: 'RUN_LOST' })
    expect(db.pointers.get('pi-vf27', 'sandbox')?.lastAcceptedRunId).toBeNull()
    expect(api.getTask(task.id)?.timeline.filter(entry => entry.event === 'task.harness.verification')).toHaveLength(1)
    assertInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('VF-28 matches the 08 §8.5.3 table and never accepts a gated outcome', () => {
  const rows: Array<[Record<string, unknown>, boolean]> = [
    [{ trust: 'requester', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'readonly', runStatus: 'succeeded', verificationRequested: false, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'failed', verificationRequested: false, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: false, predecessorAccepted: false }, true],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'passed', attempts: 1, failed: [] }, predecessorAccepted: false }, true],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'skipped', reason: 'NO_COMMANDS', attempts: 0, failed: [] }, predecessorAccepted: false }, true],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'skipped', reason: 'NO_CHANGES', attempts: 0, failed: [] }, predecessorAccepted: true }, true],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'skipped', reason: 'NO_CHANGES', attempts: 0, failed: [] }, predecessorAccepted: false }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'skipped', reason: 'TAMPER_RISK', attempts: 0, failed: [] }, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'skipped', reason: 'CONFIG_EXPOSED', attempts: 0, failed: [] }, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'failed', attempts: 1, failed: ['check'] }, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, verification: { status: 'unverified', reason: 'CANCELLED', attempts: 1, failed: [] }, predecessorAccepted: true }, false],
    [{ trust: 'owner', profile: 'edit', runStatus: 'succeeded', verificationRequested: true, predecessorAccepted: true }, false],
  ]
  for (const [input, accept] of rows) {
    expect(autoAcceptDecision(input as never).accept, JSON.stringify(input)).toBe(accept)
  }
  // 参考实现与生产实现逐点比对（08 §8.5.3）
  const reference = (input: Record<string, unknown>) => {
    const verification = input.verification as { status?: string; reason?: string } | undefined
    if (input.trust === 'requester') return false
    if (input.profile === 'readonly') return false
    if (input.runStatus !== 'succeeded') return false
    if (!input.verificationRequested) return true
    if (verification?.status === 'passed') return true
    if (verification?.status === 'skipped' && verification.reason === 'NO_COMMANDS') return true
    if (verification?.status === 'skipped' && verification.reason === 'NO_CHANGES') return Boolean(input.predecessorAccepted)
    return false
  }
  const outcome = fc.oneof(
    fc.constant(undefined),
    fc.record({ status: fc.constant('passed'), attempts: fc.integer({ min: 0, max: 3 }), failed: fc.constant([]) }),
    fc.record({ status: fc.constant('failed'), attempts: fc.integer({ min: 1, max: 3 }), failed: fc.constant([]) }),
    fc.record({ status: fc.constantFrom('skipped', 'unverified'), attempts: fc.integer({ min: 0, max: 3 }), failed: fc.constant([]),
      reason: fc.constantFrom('NO_CHANGES', 'NO_COMMANDS', 'TAMPER_RISK', 'CONFIG_EXPOSED', 'CANCELLED', 'BUDGET_EXHAUSTED',
        'MANIFEST_INCOMPLETE', 'COMMAND_UNAVAILABLE', 'RUN_LOST', 'INTERNAL', 'WORKER_RESTARTED', 'WORKER_SHUTDOWN') }),
  )
  fc.assert(fc.property(fc.record({
    trust: fc.constantFrom('owner', 'requester'), profile: fc.constantFrom('readonly', 'edit', 'full'),
    runStatus: fc.constantFrom('succeeded', 'failed', 'timed_out', 'cancelled'),
    verificationRequested: fc.boolean(), predecessorAccepted: fc.boolean(), outcome,
  }), sample => {
    const input = { ...sample, ...(sample.outcome && { verification: sample.outcome }) }
    return autoAcceptDecision(input as never).accept === reference(input)
  }), { numRuns: 300 })
})

it('VF-11 auto-accepts NO_CHANGES only when the predecessor state was accepted', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-vf11', headers: caps })
    const pointer = () => db.pointers.get('pi-vf11', 'sandbox')!
    // R1：验证通过 → 自动采纳（seq 1）
    const first = await api.createTask(baseInput, owner)
    const firstRun = await dispatch(worker, first.id)
    worker.events(firstRun.runId, first.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    worker.events(firstRun.runId, first.id, [verifyResult(), finishedEvent(6, { status: 'passed', attempts: 1, failed: [] })])
    await eventually(() => pointer().lastAcceptedRunId === firstRun.runId)
    expect(pointer().lastAcceptedSeq).toBe(1)
    // R2：只改黑板（NO_CHANGES，seq 2）→ predecessorAccepted → 采纳
    const second = await api.createTask(baseInput, owner)
    const secondRun = await dispatch(worker, second.id)
    worker.events(secondRun.runId, second.id, [startedEvent(), harnessEvent(), workspaceEvent(),
      finishedEvent(4, { status: 'skipped', reason: 'NO_CHANGES', attempts: 0, failed: [] })])
    await eventually(() => pointer().lastAcceptedRunId === secondRun.runId)
    expect(pointer().lastAcceptedSeq).toBe(2)
    // R3：验证失败（seq 3）→ 不采纳
    const third = await api.createTask(baseInput, owner)
    const thirdRun = await dispatch(worker, third.id)
    worker.events(thirdRun.runId, third.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    worker.events(thirdRun.runId, third.id, [verifyResult(5, 1, 'failed'), finishedEvent(6, { status: 'failed', attempts: 1, failed: ['check'] })])
    await eventually(() => api.getTask(third.id)?.verification === 'failed')
    expect(pointer().lastAcceptedRunId).toBe(secondRun.runId)
    // R4：NO_CHANGES（seq 4）但前驱未被采纳（lastAcceptedSeq = 2 ≠ 3）→ 不采纳
    const fourth = await api.createTask(baseInput, owner)
    const fourthRun = await dispatch(worker, fourth.id)
    worker.events(fourthRun.runId, fourth.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    worker.events(fourthRun.runId, fourth.id, [verifyResult(5, 1, 'passed'),
      finishedEvent(6, { status: 'skipped', reason: 'NO_CHANGES', attempts: 0, failed: [] })])
    await eventually(() => api.getTask(fourth.id)?.status === 'succeeded')
    await eventually(() => db.runs.get(fourthRun.runId)?.verificationStatus === 'skipped')
    expect(pointer().lastAcceptedRunId).toBe(secondRun.runId)
    assertInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('VF-29 gates a requester result on a failed verification and never auto-accepts', async () => {
  const { hub, cleanup } = await openHarness({ feishu: { requesterReplyPolicy: 'auto' } })
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-vf29', headers: caps })
    const task = await api.createTask(baseInput, requester)
    await api.approve(task.id, owner, { overrides: { harness: { verify: true } } })
    const run = await dispatch(worker, task.id)
    expect(run.harness?.verify).toEqual({ autoFixMaxRetries: 0 })
    worker.events(run.runId, task.id, [startedEvent(), harnessEvent(spec({ trust: 'requester' })), workspaceEvent(), verifyStarted()])
    worker.events(run.runId, task.id, [verifyResult(5, 1, 'failed'), finishedEvent(6, { status: 'failed', attempts: 1, failed: ['check'] })])
    await eventually(() => api.getTask(task.id)?.resultDeliveryStatus === 'pending_review')
    expect(db.runs.get(run.runId)?.harnessJson).toMatchObject({ gated: 'VERIFICATION' })
    expect(api.getTask(task.id)?.timeline.some(entry => entry.event === 'task.harness.result_gated')).toBe(true)
    expect(db.pointers.get('pi-vf29', 'sandbox')?.lastAcceptedRunId).toBeNull()
    assertInvariants(db)
    assertVerificationInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('HP-12/BC-9 downgrades verify to progress against a blackboard-only Hub without a 4400', async () => {
  const { hub, cleanup } = await openHarness({ workers: { capabilities: ['blackboard.v1'] } })
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-hp12', headers: caps })
    expect(worker.welcome?.capabilities).toEqual(['blackboard.v1'])
    expect(hub.ctx.workers.capabilities('pi-hp12')).toEqual(['blackboard.v1'])
    const task = await api.createTask(baseInput, owner)
    const run = await dispatch(worker, task.id)
    expect(run.harness).toBeDefined()
    expect(run.harness?.verify).toBeUndefined()
    // 7b Worker 的 verify 事件在此连接上被下转换为 progress（这里直接发下转换后的形态）
    worker.events(run.runId, task.id, [startedEvent(), harnessEvent(spec({ verify: false })),
      { kind: 'progress', seq: 3, ts: 1003, phase: 'verify', detail: 'attempt 1 failed' },
      finishedEvent(4)])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded')
    await eventually(() => db.runs.get(run.runId)?.status === 'succeeded')
    expect(db.runs.get(run.runId)?.verificationStatus).toBeNull()
    expect(api.getTask(task.id)?.verification).toBeUndefined()
    expect(worker.closeCode).toBeUndefined()
    expect(api.metrics().harnessUnnegotiatedEvents).toBe(0)
    assertVerificationInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('BC-9/BC-10 keeps verification data readable across a capability rollback', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-bc10', headers: caps })
    const first = await api.createTask(baseInput, owner)
    const run = await dispatch(worker, first.id)
    worker.events(run.runId, first.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    worker.events(run.runId, first.id, [verifyResult(), finishedEvent(6, { status: 'passed', attempts: 1, failed: [] })])
    await eventually(() => api.getTask(first.id)?.verification === 'passed')
    // 回退：Hub 只提供 blackboard.v1（新连接生效）
    await hub.fibers.get('workers')!.update({ ...hub.config.workers, capabilities: ['blackboard.v1'] })
    const reconnected = await FakeWorker.connect(hub, { workerId: 'pi-bc10', headers: caps, identity: worker.identity })
    expect(reconnected.welcome?.capabilities).toEqual(['blackboard.v1'])
    const second = await api.createTask(baseInput, owner)
    expect((await dispatch(reconnected, second.id)).harness?.verify).toBeUndefined()
    // 既有验证结论文档仍可读
    expect(api.runHarness(first.id, run.runId).verification?.outcome).toMatchObject({ status: 'passed' })
    expect(db.runs.get(run.runId)?.verificationStatus).toBe('passed')
    // 7a 形态的 Worker 连接 7b Hub：仍是 blackboard.v1 行为，且没有 4400
    const legacy = await FakeWorker.connect(hub, { workerId: 'pi-bc9', headers: blackboardOnly })
    expect(legacy.welcome?.capabilities).toEqual(['blackboard.v1'])
    const third = await api.createTask(baseInput, owner)
    const legacyRun = await dispatch(legacy, third.id)
    expect(legacyRun.harness?.verify).toBeUndefined()
    legacy.events(legacyRun.runId, third.id, [startedEvent(), harnessEvent(spec({ verify: false })), workspaceEvent(), finishedEvent(4)])
    await eventually(() => api.getTask(third.id)?.status === 'succeeded')
    expect(legacy.closeCode).toBeUndefined()
    assertVerificationInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('INV-11 keeps TaskStatus and version independent from verification results', async () => {
  const flows = [
    { name: 'with-verify', events: () => [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted(),
      verifyResult(5, 1, 'failed'), finishedEvent(6, { status: 'failed', attempts: 1, failed: ['check'] })] },
    { name: 'replay-without-verify', events: () => [startedEvent(), harnessEvent(), workspaceEvent(), finishedEvent(4)] },
  ]
  const observed: Array<{ status: string; version: number }> = []
  for (const flow of flows) {
    const { hub, cleanup } = await openHarness()
    try {
      const api = hub.ctx.orchestrator
      const worker = await FakeWorker.connect(hub, { workerId: 'pi-inv11', headers: caps })
      const task = await api.createTask(baseInput, owner)
      const run = await dispatch(worker, task.id)
      worker.events(run.runId, task.id, flow.events())
      await eventually(() => api.getTask(task.id)?.status === 'succeeded')
      const view = api.getTask(task.id)!
      observed.push({ status: view.status, version: view.version })
    } finally { await cleanup() }
  }
  expect(observed[0]).toEqual(observed[1])
}, 30_000)

it('INV-13/INV-14 serialise verification and keep attempt === round + 1', async () => {
  const { hub, cleanup } = await openHarness({ harness: { defaults: { autoFixMaxRetries: 1 } } })
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const worker = await FakeWorker.connect(hub, { workerId: 'pi-inv13', headers: caps })
    const task = await api.createTask(baseInput, owner)
    const run = await dispatch(worker, task.id)
    expect(run.harness?.verify).toEqual({ autoFixMaxRetries: 1 })
    worker.events(run.runId, task.id, [startedEvent(), harnessEvent(spec({ verify: true, autoFixMaxRetries: 1 })), workspaceEvent(), verifyStarted()])
    await eventually(() => api.getTask(task.id)?.verification === 'running')
    // 同一工作区的第二个写入型任务在验证期间不得被派发
    const rival = await api.createTask(baseInput, owner)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(worker.count('run.dispatch')).toBe(1)
    expect(api.getTask(rival.id)?.status).not.toBe('running')
    assertVerificationInvariants(db)
    // 第 1 次尝试失败 → 修复轮 → 第 2 次尝试通过
    worker.events(run.runId, task.id, [verifyResult(5, 1, 'failed'), workspaceEvent(6, 1), verifyStarted(7, 2)])
    worker.events(run.runId, task.id, [verifyResult(8, 2, 'passed'),
      finishedEvent(9, { status: 'passed', attempts: 2, failed: [], autoFix: { attempts: 1, stoppedBy: 'PASSED' } })])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded')
    await eventually(() => db.runs.get(run.runId)?.verificationStatus === 'passed')
    const view = api.runHarness(task.id, run.runId)
    expect(view.verification?.attempts.map(attempt => attempt.attempt)).toEqual([1, 2])
    expect(view.changes).toMatchObject({ total: 1 })
    const tries = db.prepare("SELECT data_json FROM task_logs WHERE run_id = ? AND kind = 'verify' ORDER BY seq").all(run.runId) as Array<{ data_json: string }>
    const results = tries.map(row => JSON.parse(row.data_json) as { phase: string; attempt: number }).filter(entry => entry.phase === 'result')
    const rounds = (db.prepare("SELECT data_json FROM task_logs WHERE run_id = ? AND kind = 'workspace' ORDER BY seq").all(run.runId) as Array<{ data_json: string }>)
      .map(row => JSON.parse(row.data_json) as { round: number })
    expect(results.at(-1)!.attempt).toBe(rounds.at(-1)!.round + 1)
    assertVerificationInvariants(db)
    assertInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('CR-7 replays verification events after a reconnect and keeps the final outcome', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
    const first = await FakeWorker.connect(hub, { workerId: 'pi-cr7', headers: caps })
    const task = await api.createTask(baseInput, owner)
    const run = await dispatch(first, task.id)
    first.events(run.runId, task.id, [startedEvent(), harnessEvent(), workspaceEvent(), verifyStarted()])
    await eventually(() => api.getTask(task.id)?.verification === 'running')
    // 断线（Hub 侧保持在宽限期内处理）
    first.terminate()
    const resumed = await FakeWorker.connect(hub, { workerId: 'pi-cr7', headers: caps, identity: first.identity,
      runs: [{ runId: run.runId, taskId: task.id, state: 'running', lastSeq: 5, oldestBufferedSeq: 1 }] })
    // Worker 重连后补发剩余事件（Outbox 仍以最完整形态持有）
    resumed.events(run.runId, task.id, [verifyResult(),
      finishedEvent(6, { status: 'passed', attempts: 1, failed: [] })])
    await eventually(() => api.getTask(task.id)?.status === 'succeeded')
    await eventually(() => db.runs.get(run.runId)?.verificationStatus === 'passed')
    expect(api.runHarness(task.id, run.runId).verification?.attempts.map(attempt => attempt.status)).toEqual(['passed'])
    expect(api.getTask(task.id)?.timeline.filter(entry => entry.event === 'task.harness.verification')).toHaveLength(1)
    assertInvariants(db)
    assertVerificationInvariants(db)
  } finally { await cleanup() }
}, 30_000)

it('CR-9 shows the frozen Phase 6 RunEvent shape rejecting a 7b journal finished event', async () => {
  const clock = new FakeClock(5)
  const dir = join(mkdtempSync(join(tmpdir(), 'pi-cr9-')), 'journal')
  const journal = new Journal(dir, clock)
  const id = runId()
  journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'sandbox' })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 1, outcome: { kind: 'finished',
    status: 'succeeded', exitCode: 0, signal: null, durationMs: 3, summary: '' } })
  const [record] = await journal.recover()
  const terminal = record!.finished!
  expect(() => assertPhase6Event(terminal)).toThrow(/verification/u)
  // 剥掉 verification 之后又回到 Phase 6 可解析形态（证明失败确实只来自新字段）
  const legacy: Record<string, unknown> = { ...terminal }
  delete legacy.verification
  expect(() => assertPhase6Event(legacy)).not.toThrow()
  expect(legacy).toMatchObject({ kind: 'finished', status: 'succeeded' })
  rmSync(dir, { force: true })
})
