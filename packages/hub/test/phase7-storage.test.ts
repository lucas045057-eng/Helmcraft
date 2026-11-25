import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { FakeClock } from '@agent-hub/common'
import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { FACTS_MAX_BYTES, VerifiedFacts } from '@agent-hub/protocol'
import { openStore } from '../src/plugins/store-sqlite/index.js'
import { taskRuns, tasks } from '../src/plugins/store-sqlite/schema.js'
import { boundFacts } from '../src/plugins/orchestrator/harness.js'
import { advancePointer, observeAcceptance, interleaved } from '../src/plugins/orchestrator/pointers.js'
import { cleanup as retention, dayMs, purgeLogSlice } from '../src/plugins/retention/cleanup.js'
import { enrollWorker, openHarness, seedRun, tmpDir } from './pi/harness.js'
import { snapshot } from './pi/phase7.js'

it('migrates an actual v3 file with an intact v3 backup and nullable new columns', () => {
  const folder = tmpDir()
  const path = join(folder, 'hub.sqlite')
  try {
    const migrations = new URL('../migrations/', import.meta.url)
    const db = new Database(path)
    for (const file of readdirSync(migrations).filter(f => /^000[012].*\.sql$/.test(f)).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
    db.prepare("INSERT INTO workers(id,display_name,public_key,key_fingerprint,created_at,updated_at) VALUES ('legacy','Legacy','test','test',0,0)").run()
    db.pragma('user_version=3')
    db.close()
    const migrated = openStore({ path }, new FakeClock(1234))
    try {
      expect(migrated.repos.pragma('user_version', { simple: true })).toBe(4)
      expect(migrated.repos.workers.get('legacy')?.protocolCapsJson).toBeNull()
      const file = readdirSync(join(folder, 'backup')).find(f => f.startsWith('hub.sqlite.bak-3-'))!
      const backup = new Database(join(folder, 'backup', file), { readonly: true })
      try { expect(backup.pragma('user_version', { simple: true })).toBe(3); expect(backup.prepare('SELECT id FROM workers').get()).toEqual({ id: 'legacy' }) }
      finally { backup.close() }
    } finally { migrated.close() }
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

it('observes concurrent writes for readonly bases, keeps pointers monotone through purge and rejects stale CAS', async () => {
  const { hub, cleanup } = await openHarness({}, { listen: false })
  try {
    const workerId = 'seq-worker'
    await enrollWorker(hub, workerId)
    const store = hub.ctx.store, db = store.repos
    const seed = (profile: 'edit' | 'readonly') => seedRun(hub, { workerId, profile, runStatus: 'running', taskStatus: 'running' })
    const write = seed('edit'), read = seed('readonly')
    const run = (id: string) => db.runs.get(id)!
    observeAcceptance(db, run(write.runId), 1)
    observeAcceptance(db, run(read.runId), 2)
    expect(run(read.runId).workspaceSeq).toBe(0)
    expect(interleaved(db, run(read.runId)).runs.map(r => r.id)).toEqual([write.runId])
    expect(interleaved(db, { ...run(read.runId), workspaceSeq: null }).unknown).toBe(true)
    expect(advancePointer(db, run(write.runId), 'auto', 3)).toBe(true)
    const next = seed('edit')
    observeAcceptance(db, run(next.runId), 4)
    expect(advancePointer(db, run(next.runId), 'auto', 5)).toBe(true)
    expect(advancePointer(db, run(write.runId), 'auto', 6)).toBe(false)
    for (const row of [write, next]) {
      db.update(taskRuns).set({ status: 'succeeded', finishedAt: 10 }).where(eq(taskRuns.id, row.runId)).run()
      db.update(tasks).set({ status: 'succeeded', finishedAt: 10, currentRunId: null }).where(eq(tasks.id, row.taskId)).run()
      db.prepare("INSERT INTO run_board_snapshots VALUES (?,'pre',0,?,?,?)").run(row.runId, 10, JSON.stringify(snapshot('retained')), 8)
    }
    for (let i = 0; i < 2; i++) store.tx(tx => purgeLogSlice(tx, 100 * dayMs, { succeeded: 30, other: 90 }, 10))
    expect(db.snapshots.forRun(write.runId)).toHaveLength(0)
    expect(db.snapshots.forRun(next.runId)).toHaveLength(1)
    for (let i = 0; i < 2; i++) retention(store, 400 * dayMs, { sliceRows: 20, retentionDays: { succeeded: 30, other: 90 } })
    expect(db.snapshots.forRun(next.runId)).toHaveLength(0)
    expect(db.pointers.get(workerId, 'sandbox')).toMatchObject({ attemptCounter: 2, lastAcceptedRunId: null, lastAttemptRunId: null, lastAcceptedSeq: null })
  } finally { await cleanup() }
})

it('bounds multibyte facts without losing the base or interleaved count', () => {
  const runId = 'run_' + 'A'.repeat(26)
  const brief = { runId, taskNo: 1, adapter: 'mock', profile: 'edit', runStatus: 'succeeded', trust: 'owner', finishedAt: 1 } as const
  const full = { ...brief, title: 'base', summary: '大'.repeat(1500), changes: { source: 'cli' as const, total: 30, paths: Array<string>(30).fill('文'.repeat(512)) } }
  const facts: VerifiedFacts = { v: 1, generatedAt: 1, currentRun: { runId, taskNo: 3, adapter: 'mock', trust: 'owner' },
    workspace: { workspaceId: 'sandbox', lastAccepted: brief, lastAttempt: brief, unaccepted: structuredClone(full) },
    handoff: { intent: 'relay', from: full }, continuity: { baseRunId: runId, interleaved: Array(10).fill(brief), interleavedTotal: 22 } }
  const bounded = VerifiedFacts.parse(boundFacts(facts))
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(FACTS_MAX_BYTES)
  expect(bounded.handoff?.from.changes?.paths).toHaveLength(10)
  expect(bounded.continuity).toMatchObject({ baseRunId: runId, interleavedTotal: 22 })
  expect(bounded.continuity?.interleaved).toHaveLength(3)
  expect(bounded.workspace.unaccepted).toBeUndefined()
})
