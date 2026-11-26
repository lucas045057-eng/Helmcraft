import { asc, desc, eq, and, gt, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { TaskRow } from '../../services/store.js'
import { activeRunStatuses } from '../../services/workers.js'
import * as schema from './schema.js'

export function repositories(db: BetterSQLite3Database<typeof schema>) {
  const { tasks, taskRuns, taskLogs, workers, feishuMessages, feishuEventDedupe, auditLogs, inputRequests, policyRules,
    dashboardSessions, apiTokens, enrollTokens, idempotencyKeys } = schema
  return {
    tasks: {
      get: (id: string) => db.select().from(tasks).where(eq(tasks.id, id)).get(),
      getByNo: (taskNo: number) => db.select().from(tasks).where(eq(tasks.taskNo, taskNo)).get(),
      insert: (row: Omit<typeof tasks.$inferInsert, 'taskNo'>) => {
        const counter = db.get<{ value: string }>(sql`INSERT INTO meta VALUES ('task_no_seq', '1')
          ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value`)
        return db.insert(tasks).values({ ...row, taskNo: Number(counter.value) }).returning().get()
      },
      casUpdate: (id: string, expectedVersion: number, patch: Partial<TaskRow>) =>
        db.update(tasks).set(patch).where(and(eq(tasks.id, id), eq(tasks.version, expectedVersion))).run().changes === 1,
      listQueued: (limit: number) => db.select().from(tasks).where(eq(tasks.status, 'queued'))
        .orderBy(desc(tasks.priority), asc(tasks.queuedAt), asc(tasks.taskNo)).limit(limit).all(),
      listActive: () => db.select().from(tasks).where(inArray(tasks.status, activeRunStatuses)).all(),
    },
    runs: {
      get: (id: string) => db.select().from(taskRuns).where(eq(taskRuns.id, id)).get(),
      forTask: (id: string) => db.select().from(taskRuns).where(eq(taskRuns.taskId, id)).orderBy(desc(taskRuns.runSeq)).all(),
      active: (workerId?: string) => db.select().from(taskRuns)
        .where(and(inArray(taskRuns.status, activeRunStatuses), workerId ? eq(taskRuns.workerId, workerId) : undefined)).all(),
    },
    snapshots: {
      latestForWorkspace: (workerId: string, workspaceId: string) => {
        const snapshots = schema.runBoardSnapshots
        return db.select({ snapshot: snapshots.snapshotJson, capturedAt: snapshots.capturedAt })
          .from(taskRuns).innerJoin(snapshots, eq(snapshots.runId, taskRuns.id))
          .where(and(eq(taskRuns.workerId, workerId), eq(taskRuns.workspaceId, workspaceId), gt(snapshots.contentBytes, 0)))
          .orderBy(desc(snapshots.capturedAt), desc(sql`${snapshots.phase} = 'post'`), desc(taskRuns.id)).limit(1).get()
      },
      forRun: (id: string) => db.select().from(schema.runBoardSnapshots).where(eq(schema.runBoardSnapshots.runId, id)).all(),
    },
    pointers: {
      get: (workerId: string, workspaceId: string) => db.select().from(schema.workspacePointers).where(and(
        eq(schema.workspacePointers.workerId, workerId), eq(schema.workspacePointers.workspaceId, workspaceId))).get(),
      list: () => db.select().from(schema.workspacePointers).all(),
    },
    logs: { tail: (id: string) => db.select().from(taskLogs).where(eq(taskLogs.runId, id)).orderBy(desc(taskLogs.seq)).limit(1).get() },
    workers: {
      get: (id: string) => db.select().from(workers).where(eq(workers.id, id)).get(),
      list: () => db.select().from(workers).all(),
    },
    feishu: {
      messages: (id: string) => db.select().from(feishuMessages).where(eq(feishuMessages.taskId, id)).all(),
      recordEvent: (row: typeof feishuEventDedupe.$inferInsert) => db.insert(feishuEventDedupe).values(row).onConflictDoNothing().run().changes > 0,
    },
    audit: { append: (row: typeof auditLogs.$inferInsert) => db.insert(auditLogs).values(row).run() },
    inputs: {
      openFor: (taskId: string) => db.select().from(inputRequests).where(and(eq(inputRequests.taskId, taskId), eq(inputRequests.status, 'open'))).get(),
    },
    policies: { list: () => db.select().from(policyRules).orderBy(asc(policyRules.priority), asc(policyRules.id)).all() },
    sessions: { find: (hash: string) => db.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, hash)).get() },
    apiTokens: { find: (hash: string) => db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hash)).get() },
    enroll: { find: (hash: string) => db.select().from(enrollTokens).where(eq(enrollTokens.tokenHash, hash)).get() },
    idempotency: {
      find: (scope: string, key: string) => db.select().from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key))).get(),
    },
  }
}
