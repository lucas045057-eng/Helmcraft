import { and, asc, count, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { autoAcceptDecision } from '@agent-hub/protocol'
import type { Profile, VerificationSummary, AcceptRunRequest, Actor, AdapterId, PointerRef, WorkspacePointerView } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos, RunRow } from '../../services/store.js'
import { taskRuns, workspacePointers } from '../store-sqlite/schema.js'

type Pointer = typeof workspacePointers.$inferSelect
const key = (worker: string, workspace: string) => and(eq(workspacePointers.workerId, worker), eq(workspacePointers.workspaceId, workspace))

export function observeAcceptance(db: Repos, run: RunRow, now: number) {
  const { workerId, workspaceId } = run
  db.insert(workspacePointers).values({ workerId, workspaceId, updatedAt: now }).onConflictDoNothing().run()
  let seq: number
  if (run.profile === 'readonly') {
    const activeWrite = db.runs.active(workerId).some(other => other.workspaceId === workspaceId &&
      other.id !== run.id && other.profile !== 'readonly' && other.workspaceSeq !== null)
    seq = db.pointers.get(workerId, workspaceId)!.attemptCounter - Number(activeWrite)
  } else {
    const increment = sql<number>`${workspacePointers.attemptCounter} + 1`
    seq = db.update(workspacePointers).set({ attemptCounter: increment, lastAttemptSeq: increment,
      lastAttemptRunId: run.id, updatedAt: now }).where(key(workerId, workspaceId))
      .returning({ seq: workspacePointers.attemptCounter }).get().seq
  }
  db.update(taskRuns).set({ workspaceSeq: seq }).where(eq(taskRuns.id, run.id)).run()
}

// The scheduler admits a single writer per workspace. Until started supplies the
// effective profile, this Run occupies that slot and is the latest provisional write.
export function rollbackWriteRegistration(db: Repos, run: RunRow, now: number) {
  const seq = run.workspaceSeq
  if (!seq) return false
  const pointer = db.pointers.get(run.workerId, run.workspaceId)
  if (pointer?.lastAttemptRunId !== run.id || pointer.attemptCounter !== seq || pointer.lastAcceptedRunId === run.id) return false
  const previous = db.select({ id: taskRuns.id, seq: taskRuns.workspaceSeq }).from(taskRuns)
    .where(and(eq(taskRuns.workerId, run.workerId), eq(taskRuns.workspaceId, run.workspaceId),
      eq(taskRuns.workspaceSeq, seq - 1), ne(taskRuns.profile, 'readonly'))).get()
  db.update(workspacePointers).set({ attemptCounter: seq - 1, lastAttemptRunId: previous?.id ?? null,
    lastAttemptSeq: previous?.seq ?? null, updatedAt: now }).where(key(run.workerId, run.workspaceId)).run()
  db.update(taskRuns).set({ workspaceSeq: seq - 1 }).where(eq(taskRuns.id, run.id)).run()
  return true
}

export function interleaved(db: Repos, base: RunRow) {
  if (base.workspaceSeq === null) return { baseRunId: base.id, runs: [], total: 0, unknown: true }
  const where = and(eq(taskRuns.workerId, base.workerId), eq(taskRuns.workspaceId, base.workspaceId),
    gt(taskRuns.workspaceSeq, base.workspaceSeq), ne(taskRuns.id, base.id), inArray(taskRuns.profile, ['edit', 'full']))
  return { baseRunId: base.id, runs: db.select().from(taskRuns).where(where).orderBy(asc(taskRuns.workspaceSeq)).limit(10).all(),
    total: db.select({ n: count() }).from(taskRuns).where(where).get()!.n, unknown: false }
}

export function pointerView(db: Repos, row: Pointer): WorkspacePointerView {
  function ref(id: string | null, acceptedBy?: string | null): PointerRef | null {
    const run = id ? db.runs.get(id) : undefined
    if (!run?.workspaceSeq) return null
    return { runId: run.id, taskId: run.taskId, taskNo: db.tasks.get(run.taskId)!.taskNo, adapter: run.adapter as AdapterId,
      seq: run.workspaceSeq, runStatus: run.status, verification: run.verificationStatus, finishedAt: run.finishedAt,
      ...(acceptedBy && { acceptedBy }) }
  }
  return { workerId: row.workerId, workspaceId: row.workspaceId, attemptCounter: row.attemptCounter,
    lastAttempt: ref(row.lastAttemptRunId), lastAccepted: ref(row.lastAcceptedRunId, row.acceptedBy), updatedAt: row.updatedAt }
}

export function canAccept(run: RunRow, pointer: Pointer | undefined) {
  return !!pointer && run.status === 'succeeded' && run.profile !== 'readonly' && (run.workspaceSeq ?? 0) > (pointer.lastAcceptedSeq ?? 0)
}
export function advancePointer(db: Repos, run: RunRow, by: string, now: number, expected?: string | null) {
  if (run.workspaceSeq === null) return false
  return db.update(workspacePointers).set({ lastAcceptedRunId: run.id, lastAcceptedSeq: run.workspaceSeq, acceptedBy: by,
    acceptedAt: now, updatedAt: now }).where(and(key(run.workerId, run.workspaceId),
    sql`coalesce(${workspacePointers.lastAcceptedSeq}, 0) < ${run.workspaceSeq}`,
    expected === undefined ? undefined : sql`${workspacePointers.lastAcceptedRunId} is ${expected}`)).run().changes === 1
}
export function autoAccept(db: Repos, run: RunRow, trust: 'requester' | 'owner', now: number,
  verificationRequested: boolean, verification?: VerificationSummary, failedAttempt = false) {
  if (!run.workspaceSeq || run.status !== 'succeeded') return 'ineligible'
  const pointer = db.pointers.get(run.workerId, run.workspaceId)
  const decision = autoAcceptDecision({ trust, profile: run.profile as Profile, runStatus: run.status, verificationRequested, failedAttempt,
    ...(verification && { verification }), predecessorAccepted: (pointer?.lastAcceptedSeq ?? 0) === run.workspaceSeq - 1 })
  if (!decision.accept) return 'ineligible'
  return advancePointer(db, run, 'auto', now) ? 'accepted' : 'stale'
}
export function acceptRun(db: Repos, worker: string, workspace: string, actor: Actor, input: AcceptRunRequest, now: number) {
  if (actor.type !== 'owner') throw new HubError('FORBIDDEN', 403)
  const row = db.pointers.get(worker, workspace)
  if (!row) throw new HubError('UNKNOWN_WORKSPACE', 422)
  const run = db.runs.get(input.runId)
  if (!run || run.workerId !== worker || run.workspaceId !== workspace) throw new HubError('RUN_NOT_FOUND', 404)
  if (run.status !== 'succeeded') throw new HubError('INVALID_TRANSITION', 409, { reason: 'RUN_NOT_SUCCEEDED' })
  if (run.profile === 'readonly' || run.workspaceSeq === null) throw new HubError('INVALID_TRANSITION', 409, { reason: 'NOT_WRITE_RUN' })
  if (row.lastAcceptedRunId !== input.expectedAcceptedRunId) throw new HubError('VERSION_CONFLICT', 409, { current: pointerView(db, row) })
  if (!canAccept(run, row)) throw new HubError('INVALID_TRANSITION', 409, { reason: 'NOT_NEWER' })
  if (!advancePointer(db, run, actor.id, now, input.expectedAcceptedRunId)) throw new HubError('VERSION_CONFLICT', 409)
  return run
}
