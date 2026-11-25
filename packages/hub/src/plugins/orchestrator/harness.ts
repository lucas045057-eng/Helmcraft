import { eq } from 'drizzle-orm'
import { createRedactor } from '@agent-hub/common'
import { boardFileDiff, FACTS_MAX_BYTES, resolveHarness, stripBoardContent } from '@agent-hub/protocol'
import type { AdapterId, BoardFileDiff, BoardSnapshot, FactRun, FactRunBrief, HarnessDirective, HarnessPolicy,
  VerificationSummary, VerifyCommandResult, Profile, RunEvent, RunHarnessSummary, RunHarnessView, VerifiedFacts } from '@agent-hub/protocol'
import type { HubConfig } from '../../config/schema.js'
import type { Repos, RunRow, TaskRow } from '../../services/store.js'
import { runBoardSnapshots, taskRuns, tasks } from '../store-sqlite/schema.js'
import { canAccept, interleaved, pointerView } from './pointers.js'

type Pre = Extract<RunEvent, { kind: 'harness' }>
type Post = Extract<RunEvent, { kind: 'workspace' }>
export interface HarnessRecord {
  v: 1
  directive: Omit<HarnessDirective, 'facts'> | null
  facts?: VerifiedFacts
  applied?: Pre['applied']
  prompt?: Pre['prompt']
  pre?: Pick<Pre, 'board' | 'manifest'>
  post?: Omit<Post, 'seq' | 'kind' | 'ts'>
  boardDiff?: BoardFileDiff[]
  gated?: 'BOARD_DELETED' | 'VERIFICATION' | 'TAMPER_RISK'
}
export function policyFor(config: HubConfig['harness'], workspace: string): HarnessPolicy {
  const override = config.workspaces[workspace]
  const defaults = config.defaults
  return { enabled: config.enabled && (override?.enabled ?? true),
    blackboard: override?.blackboard ?? defaults.blackboard, allowRequesterBlackboard: override?.allowRequesterBlackboard ?? defaults.allowRequesterBlackboard,
    verify: override?.verify ?? defaults.verify, allowRequesterVerify: override?.allowRequesterVerify ?? defaults.allowRequesterVerify,
    autoFixMaxRetries: override?.autoFixMaxRetries ?? defaults.autoFixMaxRetries }
}
type VerifyEvent = Extract<RunEvent, { kind: 'verify' }>
interface Attempt {
  attempt: number; commands: string[]; startedAt: number; finishedAt?: number
  status?: 'passed' | 'failed' | 'aborted'; results?: VerifyCommandResult[]
}
interface VerificationRecord { requested: { autoFixMaxRetries: number }; attempts: Attempt[]; outcome?: VerificationSummary }
export function verificationRecord(run: RunRow): VerificationRecord {
  return run.verificationJson as VerificationRecord ?? { requested: { autoFixMaxRetries: 0 }, attempts: [] }
}
export function applyVerifyEvent(db: Repos, run: RunRow, event: VerifyEvent) {
  const record = verificationRecord(run)
  let attempt = record.attempts.find(a => a.attempt === event.attempt)
  if (!attempt) {
    attempt = { attempt: event.attempt, commands: event.commands, startedAt: event.ts }
    record.attempts.push(attempt)
  }
  if (event.phase === 'started') db.update(tasks).set({ lastProgress: '验证中 · ' + event.commands.join('、') }).where(eq(tasks.id, run.taskId)).run()
  else Object.assign(attempt, { status: event.status, results: event.results, finishedAt: event.ts })
  db.update(taskRuns).set({ verificationStatus: 'running', verificationJson: record }).where(eq(taskRuns.id, run.id)).run()
}
export function finishVerification(db: Repos, run: RunRow, outcome: VerificationSummary | undefined,
  missing: 'INTERNAL' | 'WORKER_RESTARTED' | 'RUN_LOST') {
  const record = verificationRecord(run)
  if (!outcome && !(run.harnessJson as HarnessRecord | null)?.directive?.verify && !run.verificationStatus) return
  record.outcome = outcome ?? { status: 'unverified', reason: missing, attempts: record.attempts.length, failed: [] }
  db.update(taskRuns).set({ verificationStatus: record.outcome.status, verificationJson: record }).where(eq(taskRuns.id, run.id)).run()
  return record.outcome
}
function needsVerificationFacts(outcome?: FactRun['verificationDetail']) {
  return outcome?.status === 'failed' || outcome?.status === 'unverified' ||
    outcome?.reason === 'TAMPER_RISK' || outcome?.reason === 'CONFIG_EXPOSED'
}
type Current = { id: string; workerId: string; adapter: AdapterId; workspaceId: string }
function brief(db: Repos, run: RunRow): FactRunBrief {
  const task = db.tasks.get(run.taskId)!
  const outcome = verificationRecord(run).outcome
  return { ...(outcome && { verification: outcome.status }), runId: run.id, taskNo: task.taskNo, adapter: run.adapter as AdapterId, profile: run.profile as Profile,
    runStatus: run.status, trust: task.requesterType, finishedAt: run.finishedAt }
}
function factRun(db: Repos, run: RunRow): FactRun {
  const rec = run.harnessJson as HarnessRecord | null
  const redact = (value: string) => createRedactor()(value)
  const paths = (run.filesChangedJson as string[] | null)?.filter(path => !/^(?:[A-Za-z]:|[\\/])/.test(path))
  const measured = rec?.post?.changes
  const verification = verificationRecord(run)
  const outcome = verification.outcome
  const results = verification.attempts.at(-1)?.results ?? []
  return { ...brief(db, run), title: redact(db.tasks.get(run.taskId)!.title).slice(0, 120), ...(run.summary && { summary: redact(run.summary).slice(0, 1500) }),
    ...(measured ? { changes: { source: 'manifest' as const, total: measured.total, paths: measured.sample.slice(0, 30).map(p => p.path) } }
      : paths && { changes: { source: 'cli' as const, total: paths.length, paths: paths.slice(0, 30) } }),
    ...(outcome && { verificationDetail: { status: outcome.status, ...(outcome.reason && { reason: outcome.reason }), attempts: outcome.attempts,
      passed: results.filter(r => r.status === 'passed').map(r => r.id), failed: results.flatMap(r =>
        r.status === 'failed' || r.status === 'timed_out' || r.status === 'unavailable'
          ? [{ id: r.id, status: r.status, exitCode: r.exitCode, tail: redact(r.tail ?? '').slice(-1500) }] : []).slice(0, 4),
      ...(rec?.post?.tamper && { tamperPaths: rec.post.tamper.paths.slice(0, 20) }) } }),
    ...(rec?.boardDiff && { board: { changed: rec.boardDiff.filter(f => ['modified', 'created'].includes(f.change)).map(f => f.file),
      deleted: rec.boardDiff.filter(f => f.change === 'deleted').map(f => f.file),
      overBudget: rec.post?.board?.files.filter(f => f.overBudget).map(f => f.file) ?? [] } }) }
}
export function boundFacts(facts: VerifiedFacts) {
  const runs = [facts.workspace.unaccepted, facts.handoff?.from, facts.parent].filter((r): r is FactRun => !!r)
  const fits = () => Buffer.byteLength(JSON.stringify(facts)) <= FACTS_MAX_BYTES
  if (fits()) return facts
  for (const r of runs) if (r.summary) r.summary = r.summary.slice(0, 800)
  if (fits()) return facts
  for (const r of runs) for (const check of r.verificationDetail?.failed ?? []) check.tail = check.tail.slice(-512)
  if (fits()) return facts
  for (const r of runs) if (r.changes) r.changes.paths = r.changes.paths.slice(0, 10)
  if (fits()) return facts
  if (facts.continuity) facts.continuity.interleaved = facts.continuity.interleaved.slice(0, 3)
  if (fits()) return facts
  delete facts.workspace.unaccepted
  if (fits()) return facts
  for (const r of runs) delete r.summary
  if (fits()) return facts
  if (facts.continuity) facts.continuity.interleaved = []
  return fits() ? facts : undefined
}
export function buildVerifiedFacts(db: Repos, task: TaskRow, run: Current, now: number) {
  const pointer = db.pointers.get(run.workerId, run.workspaceId)
  const get = (id?: string | null) => id ? db.runs.get(id) : undefined
  const accepted = get(pointer?.lastAcceptedRunId), attempt = get(pointer?.lastAttemptRunId)
  const base = task.handoffFromRunId ? get(task.handoffFromRunId) : task.resumeSessionId && task.parentTaskId
    ? db.runs.forTask(task.parentTaskId).find(r => r.cliSessionId === task.resumeSessionId && r.workerId === run.workerId && r.workspaceId === run.workspaceId) : undefined
  const facts: VerifiedFacts = { v: 1, generatedAt: now, currentRun: { runId: run.id, taskNo: task.taskNo, adapter: run.adapter, trust: task.requesterType },
    workspace: { workspaceId: run.workspaceId, lastAccepted: accepted ? brief(db, accepted) : null,
      lastAttempt: attempt ? brief(db, attempt) : null,
      ...(attempt && attempt.id !== accepted?.id && attempt.id !== base?.id && { unaccepted: factRun(db, attempt) }) } }
  if (base) {
    if (task.handoffFromRunId) facts.handoff = { intent: task.harnessRequestJson?.intent ?? 'relay', from: factRun(db, base) }
    else facts.parent = factRun(db, base)
    const gap = interleaved(db, base)
    if (gap.total || gap.unknown) facts.continuity = { baseRunId: base.id, interleaved: gap.runs.map(r => brief(db, r)),
      interleavedTotal: gap.total, ...(gap.unknown && { interleavedUnknown: true }) }
  }
  return boundFacts(facts)
}
export function planHarness(db: Repos, task: TaskRow, run: Current, config: HubConfig['harness'], caps: readonly string[], now: number, dropped: () => void): HarnessRecord | null {
  const overrides = task.harnessRequestJson?.overrides
  const directive = resolveHarness({ caps, policy: policyFor(config, run.workspaceId), requesterType: task.requesterType,
    profile: task.profile, adapter: run.adapter, prompt: task.prompt, resume: !!task.resumeSessionId, handoff: !!task.handoffFromRunId,
    ...(overrides && { overrides: { ...(overrides.blackboard !== undefined && { blackboard: overrides.blackboard }), ...(overrides.verify !== undefined && { verify: overrides.verify }) } }) })
  if (!directive) return null
  const record: HarnessRecord = { v: 1, directive }
  if (directive.inject !== 'none') {
    const facts = buildVerifiedFacts(db, task, run, now)
    if (!facts || (directive.inject === 'handoff' && !facts.handoff)) {
      if (directive.inject === 'handoff') directive.inject = 'fresh'
      dropped()
    } else if (directive.inject !== 'resume' || facts.handoff || facts.continuity || needsVerificationFacts(facts.parent?.verificationDetail)) record.facts = facts
  }
  return record
}
export const toWireDirective = (record: HarnessRecord) => record.directive ? { ...record.directive, ...(record.facts && { facts: record.facts }) } : undefined

export function applyHarnessEvent(db: Repos, run: RunRow, event: Pre | Post, critical: boolean, audit: (action: string) => void) {
  const record: HarnessRecord = (run.harnessJson as HarnessRecord | null) ?? { v: 1, directive: null }
  const clean = stripBoardContent(event)
  if (clean.kind === 'workspace' && record.post && clean.round < record.post.round) return
  const board = critical ? clean.board : event.board
  if (board) {
    const row = { runId: run.id, phase: event.kind === 'harness' ? 'pre' as const : 'post' as const,
      round: event.kind === 'workspace' ? event.round : 0, capturedAt: board.capturedAt, snapshotJson: board,
      contentBytes: board.files.reduce((n, f) => n + Buffer.byteLength(f.content ?? ''), 0) }
    db.insert(runBoardSnapshots).values(row).onConflictDoUpdate({ target: [runBoardSnapshots.runId, runBoardSnapshots.phase], set: row }).run()
  }
  if (clean.kind === 'harness') {
    record.applied = clean.applied
    record.prompt = clean.prompt
    record.pre = { board: clean.board, manifest: clean.manifest }
    if (clean.applied.downgrades.length) audit('task.harness.downgraded')
  } else {
    if (clean.tamper && !record.post?.tamper) audit('task.harness.tamper_risk')
    if (clean.readonlyCheck === 'violation') audit('task.harness.readonly_violation')
    record.post = { board: clean.board, round: clean.round, readonlyCheck: clean.readonlyCheck, readonlyPaths: clean.readonlyPaths, changes: clean.changes, tamper: clean.tamper }
    if (board) {
      const pre = db.snapshots.forRun(run.id).find(s => s.phase === 'pre')?.snapshotJson as BoardSnapshot | undefined
      record.boardDiff = board.files.map((file, index) => {
        const before = pre?.files[index]
        const diff = boardFileDiff(before, file)
        if ((before?.status !== 'absent' && before?.content === undefined) || (file.status !== 'absent' && file.content === undefined)) {
          return { ...diff, added: 0, removed: 0 }
        }
        return diff
      })
    }
  }
  db.update(taskRuns).set({ harnessJson: record }).where(eq(taskRuns.id, run.id)).run()
}
export function harnessSummary(run: RunRow, db?: Repos): RunHarnessSummary | undefined {
  const r = run.harnessJson as HarnessRecord | null
  const effective = r?.applied ?? r?.directive
  if (!r || !effective) return undefined
  const { board, inject, trust } = effective
  const snapshot = r.post?.board ?? r.pre?.board
  const warnings: NonNullable<RunHarnessSummary['boardWarnings']> = []
  if (snapshot?.files.some(f => f.overBudget)) warnings.push('OVER_BUDGET')
  if (snapshot?.files.some(f => (f.status === 'present' || f.status === 'oversize') && !f.schemaOk)) warnings.push('SCHEMA')
  if (snapshot?.dir === 'unsafe' || snapshot?.files.some(f => f.status === 'unsafe')) warnings.push('UNSAFE')
  if (r.boardDiff?.some(f => f.change === 'deleted')) warnings.push('DELETED')
  const pointer = db?.pointers.get(run.workerId, run.workspaceId)
  const tags: NonNullable<RunHarnessSummary['pointer']> = []
  if (pointer?.lastAttemptRunId === run.id) tags.push('lastAttempt')
  if (pointer?.lastAcceptedRunId === run.id) tags.push('lastAccepted')
  const { outcome, attempts } = verificationRecord(run)
  return { board, inject, trust, ...(run.verificationStatus && { verification: { state: run.verificationStatus,
    ...(outcome?.reason && { reason: outcome.reason }), attempts: outcome?.attempts ?? attempts.length,
    failed: outcome?.failed ?? [], autoFixAttempts: outcome?.autoFix?.attempts ?? 0 } }), ...(r.boardDiff && { boardChanges: r.boardDiff }), ...(warnings.length && { boardWarnings: warnings }),
    ...(r.post?.tamper && { tamper: { total: r.post.tamper.total, sample: r.post.tamper.paths.slice(0, 5) } }),
    ...(r.post?.readonlyCheck && { readonlyCheck: r.post.readonlyCheck }), ...(run.workspaceSeq && { workspaceSeq: run.workspaceSeq }),
    ...(tags.length && { pointer: tags }) }
}
export function harnessView(db: Repos, run: RunRow): RunHarnessView {
  const r = run.harnessJson as HarnessRecord | null
  const rows = db.snapshots.forRun(run.id)
  const snapshot = (phase: 'pre' | 'post') => rows.find(row => row.phase === phase)?.snapshotJson as BoardSnapshot | undefined
  const p = db.pointers.get(run.workerId, run.workspaceId)
  const { outcome, attempts } = verificationRecord(run)
  return { runId: run.id, directive: r?.directive ?? null, facts: r?.facts ?? null, applied: r?.applied ?? null, prompt: r?.prompt ?? null,
    board: { pre: snapshot('pre') ?? null, post: snapshot('post') ?? null, postRound: r?.post?.round ?? null, diff: r?.boardDiff ?? [] },
    changes: r?.post?.changes ?? null, tamper: r?.post?.tamper ?? null, readonlyCheck: r?.post?.readonlyCheck ?? null, verification: run.verificationStatus ? {
      state: run.verificationStatus, outcome: outcome ?? null, attempts: attempts.map(a =>
        ({ attempt: a.attempt, commands: a.commands, status: a.status ?? null, results: a.results ?? [] })) } : null,
    pointer: p ? pointerView(db, p) : null, canAccept: canAccept(run, p) }
}
