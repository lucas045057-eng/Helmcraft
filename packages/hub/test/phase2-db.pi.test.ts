/**
 * Pi 独立验收 · Phase 2 门禁：DB-1 ~ DB-8（SQLite / IngestQueue / 崩溃一致性）
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { openStore } from '../src/plugins/store-sqlite/index.js'
import { assertInvariants, assertRunLogContinuity } from './pi/harness.js'
function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedRunRows(store: ReturnType<typeof openStore>) {
  store.tx(db => {
    db.prepare("INSERT INTO workers (id, display_name, public_key, key_fingerprint, created_at, updated_at) VALUES ('w','w','p','f',0,0)").run()
    db.tasks.insert({ id: 'tsk_' + 'A'.repeat(26), status: 'dispatching', source: 'dashboard', originJson: { source: 'dashboard' },
      requesterType: 'owner', requesterId: 'owner', title: 'db', prompt: 'db', workspaceId: 'sandbox', profile: 'readonly',
      policyDecisionJson: { ruleId: null, decision: 'auto_approve' }, timeoutMs: 60_000, createdAt: 1_000, updatedAt: 1_000,
      currentRunId: 'run_' + 'A'.repeat(26), attemptCount: 1, runSeq: 1, version: 1 })
    db.prepare('INSERT INTO task_runs (id, task_id, run_seq, attempt, worker_id, adapter, workspace_id, profile, status, '
      + 'not_after, dispatched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('run_' + 'A'.repeat(26), 'tsk_' + 'A'.repeat(26), 1, 1,
      'w', 'mock', 'sandbox', 'readonly', 'dispatching', 2_000, 1_000)
  })
}

const RUN = 'run_' + 'A'.repeat(26)
const latest = readdirSync(new URL('../migrations/', import.meta.url)).filter(file => /^\d+_.+\.sql$/.test(file)).length

it('DB-1 迁移：空库 → 最新；WAL + incremental autovacuum；重复打开幂等', () => {
  const dir = tempDir('pi-db1-')
  const path = join(dir, 'hub.sqlite')
  try {
    const clock = new FakeClock(1_000)
    let store = openStore({ path }, clock)
    expect(store.repos.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(store.repos.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 })
    expect(store.repos.prepare('PRAGMA user_version').get()).toEqual({ user_version: latest })
    expect(store.repos.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(latest) })
    store.close()
    // 重复打开（版本已最新）→ 幂等，不再迁移
    store = openStore({ path }, clock)
    expect(store.repos.prepare('PRAGMA user_version').get()).toEqual({ user_version: latest })
    store.tx(db => db.prepare("INSERT INTO meta VALUES ('probe','1')").run())
    store.close()
    store = openStore({ path }, clock)
    expect(store.repos.prepare("SELECT value FROM meta WHERE key='probe'").get()).toEqual({ value: '1' })
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('DB-2 迁移前自动备份：生成 .bak-*，最多保留 3 份', () => {
  const dir = tempDir('pi-db2-')
  const path = join(dir, 'hub.sqlite')
  const backupDir = join(dir, 'backup')
  try {
    // 构造「上一个版本」的库：只有一个占位表 + user_version=0，并预置 5 份历史备份
    const legacy = new Database(path)
    legacy.pragma('user_version = 0')
    legacy.exec('CREATE TABLE legacy_marker (x INTEGER)')
    legacy.close()
    mkdirSync(backupDir, { recursive: true })
    for (let index = 0; index < 5; index++) {
      const file = join(backupDir, 'hub.sqlite.bak-0-100' + index + '-' + index)
      writeFileSync(file, 'old-' + index)
    }
    const store = openStore({ path }, new FakeClock(1_000))
    try {
      expect(store.repos.prepare('PRAGMA user_version').get()).toEqual({ user_version: latest })
      const backups = readdirSync(backupDir).filter(file => file.startsWith('hub.sqlite.bak-'))
      expect(backups).toHaveLength(3)
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('DB-3 日志分页查询使用 ux_logs_run_seq；DB-4 调度扫描使用 ix_tasks_sched', () => {
  const dir = tempDir('pi-db34-')
  try {
    const store = openStore({ path: join(dir, 'hub.sqlite') }, new FakeClock(1_000))
    try {
      const logsPlan = store.repos.prepare('EXPLAIN QUERY PLAN SELECT * FROM task_logs WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 500')
        .all(RUN, 0) as Array<{ detail: string }>
      expect(logsPlan.map(row => row.detail).join('\n')).toContain('ux_logs_run_seq')
      const schedPlan = store.repos.prepare("EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE status = 'queued' "
        + 'ORDER BY priority DESC, queued_at ASC, task_no ASC LIMIT 200').all() as Array<{ detail: string }>
      expect(schedPlan.map(row => row.detail).join('\n')).toContain('ix_tasks_sched')
    } finally { store.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('DB-5 日志幂等插入：重复 (run_id, seq) 不报错不重复', async () => {
  const clock = new FakeClock(1_000)
  const store = openStore({ path: ':memory:' }, clock)
  try {
    seedRunRows(store)
    const first = store.ingest.enqueue(RUN, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'one' }])
    await store.ingest.flush()
    await first
    const second = store.ingest.enqueue(RUN, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'one' },
      { seq: 2, ts: 2, kind: 'log', stream: 'stdout', text: 'two' }])
    await store.ingest.flush()
    await second
    const rows = store.repos.prepare('SELECT seq FROM task_logs WHERE run_id = ? ORDER BY seq').all(RUN)
    expect(rows).toEqual([{ seq: 1 }, { seq: 2 }])
    assertRunLogContinuity(store.repos, RUN)
    assertInvariants(store.repos)
  } finally { store.close() }
})

it('DB-6 maxBytesPerRun：单条 kind=gap 区间占位 O(1)，INV-7 连续，log_dropped_bytes 正确', async () => {
  const clock = new FakeClock(1_000)
  const store = openStore({ path: ':memory:', maxBytesPerRun: 100 }, clock)
  try {
    seedRunRows(store)
    const events = Array.from({ length: 50 }, (_, index) => ({ seq: index + 1, ts: 1_000 + index,
      kind: 'log' as const, stream: 'stdout' as const, text: 'x'.repeat(40) }))
    let dropped = 0
    for (const event of events) dropped += Buffer.byteLength(event.text)
    const pending = store.ingest.enqueue(RUN, events)
    await store.ingest.flush()
    await pending
    const rows = store.repos.prepare('SELECT seq, kind, data_json AS dataJson FROM task_logs WHERE run_id = ? ORDER BY seq').all(RUN) as
      Array<{ seq: number; kind: string; dataJson: string | null }>
    const gaps = rows.filter(row => row.kind === 'gap')
    expect(gaps).toHaveLength(1)
    const gap = JSON.parse(gaps[0]!.dataJson!) as { toSeq: number; reason: string; droppedBytes: number }
    expect(gap.reason).toBe('hub_cap')
    expect(gap.toSeq).toBe(50)
    expect(rows.length).toBeLessThanOrEqual(4)
    const run = store.repos.runs.get(RUN)!
    expect(run.lastSeq).toBe(50)
    expect(run.logTruncated).toBe(true)
    expect(run.logDroppedBytes).toBeGreaterThan(0)
    // 被截断的字节数 = 丢掉的 log 字节（gap 事件本身只占 1 行）
    expect(gap.droppedBytes).toBeGreaterThan(0)
    expect(gap.droppedBytes).toBeLessThanOrEqual(dropped)
    assertRunLogContinuity(store.repos, RUN)
    // 后续仍被截断：原地更新同一行
    const pendingAgain = store.ingest.enqueue(RUN, [{ seq: 51, ts: 1_100, kind: 'log', stream: 'stdout', text: 'y'.repeat(40) }])
    await store.ingest.flush()
    await pendingAgain
    const again = store.repos.prepare('SELECT seq, kind, data_json AS dataJson FROM task_logs WHERE run_id = ? ORDER BY seq').all(RUN) as
      Array<{ seq: number; kind: string; dataJson: string }>
    expect(again.filter(row => row.kind === 'gap')).toHaveLength(1)
    expect((JSON.parse(again.find(row => row.kind === 'gap')!.dataJson) as { toSeq: number }).toSeq).toBe(51)
    assertRunLogContinuity(store.repos, RUN)
    assertInvariants(store.repos)
  } finally { store.close() }
})

it('DB-7 IngestQueue 有界：超限时 enqueue 延迟 resolve（背压），队列上限内不增长', async () => {
  const clock = new FakeClock(1_000)
  const store = openStore({ path: ':memory:', ingest: { maxQueueRows: 2, batchRows: 1000 } }, clock)
  try {
    seedRunRows(store)
    const first = store.ingest.enqueue(RUN, [{ seq: 1, ts: 1, kind: 'log', stream: 'stdout', text: 'a' }])
    const second = store.ingest.enqueue(RUN, [{ seq: 2, ts: 2, kind: 'log', stream: 'stdout', text: 'b' }])
    const third = store.ingest.enqueue(RUN, [
      { seq: 3, ts: 3, kind: 'log', stream: 'stdout', text: 'c' },
      { seq: 4, ts: 4, kind: 'log', stream: 'stdout', text: 'd' },
    ])
    // 队列有界：只允许 maxQueueRows 行在队列中，其余进入等待
    expect(store.ingest.depth).toBe(2)
    expect(store.ingest.metrics.ingestWaiters).toBe(1)
    await store.ingest.flush()
    await expect(first).resolves.toEqual({ lastSeq: 1 })
    await expect(second).resolves.toEqual({ lastSeq: 2 })
    await expect(third).resolves.toEqual({ lastSeq: 4 })
    expect(store.ingest.depth).toBe(0)
    // 大量未 flush 的入队 → 最多 maxQueueRows 行在队列，其余等待或被拒
    const results = Array.from({ length: 400 }, (_, index) => store.ingest.enqueue(RUN, [
      { seq: 5 + index, ts: 5, kind: 'log', stream: 'stdout', text: 'z' },
    ]).then(() => 'ok', () => 'rejected'))
    expect(store.ingest.depth).toBeLessThanOrEqual(2)
    expect(store.ingest.metrics.ingestWaiters).toBeLessThanOrEqual(256)
    await store.ingest.flush()
    const settled = await Promise.all(results)
    expect(settled.filter(value => value === 'ok').length).toBeGreaterThan(0)
    expect(store.ingest.depth).toBe(0)
    assertInvariants(store.repos)
  } finally { store.close() }
})

it('DB-8 崩溃一致性：事务中途 process.kill 后重开，INV 全部成立', async () => {
  const dir = tempDir('pi-db8-')
  const dbPath = join(dir, 'hub.sqlite')
  const scriptPath = join(dir, 'crash.mjs')
  const distStore = pathToFileURL(resolve(import.meta.dirname, '../dist/plugins/store-sqlite/index.js')).href
  const sqliteModule = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href
  writeFileSync(scriptPath, `
const Database = (await import(${JSON.stringify(sqliteModule)})).default
const { openStore } = await import(${JSON.stringify(distStore)})
const clock = { now: () => Date.now(), monotonic: () => performance.now(), setInterval: () => () => {} }
const store = openStore({ path: process.argv[2] }, clock)
store.tx(db => {
  db.prepare("INSERT INTO workers (id,display_name,public_key,key_fingerprint,created_at,updated_at) VALUES ('w','w','p','f',0,0)").run()
  db.tasks.insert({ id: 'tsk_' + 'A'.repeat(26), status: 'dispatching', source: 'dashboard', originJson: { source: 'dashboard' },
    requesterType: 'owner', requesterId: 'owner', title: 'crash', prompt: 'crash', workspaceId: 'sandbox', profile: 'readonly',
    policyDecisionJson: { ruleId: null, decision: 'auto_approve' }, timeoutMs: 60000, createdAt: 1000, updatedAt: 1000 })
  db.prepare('INSERT INTO task_runs (id, task_id, run_seq, attempt, worker_id, adapter, workspace_id, profile, status, not_after, dispatched_at) '
    + "VALUES (?,?,?,?,?,?,?,?,?,?,?)").run('run_' + 'A'.repeat(26), 'tsk_' + 'A'.repeat(26), 1, 1, 'w', 'mock', 'sandbox', 'readonly', 'dispatching', 2000, 1000)
  db.prepare('INSERT INTO task_logs (run_id, seq, ts, kind, stream, text, bytes) VALUES (?,?,?,?,?,?,?)')
    .run('run_' + 'A'.repeat(26), 1, 1000, 'log', 'stdout', 'partial', 7)
  // 事务未提交：保持打开等待被父进程强杀
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
})
process.stdout.write('committed\\n')
`)
  let child: ReturnType<typeof spawn> | undefined
  try {
    child = spawn(process.execPath, [scriptPath, dbPath], { cwd: resolve(import.meta.dirname, '../../..'),
      stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const exited = new Promise<number | null>(resolveExit => child!.once('exit', code => resolveExit(code)))
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1500))
    expect(child.exitCode, 'child should still be inside the transaction: ' + stderr).toBeNull()
    child.kill('SIGKILL')
    await exited
    const store = openStore({ path: dbPath }, new FakeClock(1_000))
    try {
      // 未提交的事务必须完整回滚：不存在半写状态
      const tasks = store.repos.prepare('SELECT * FROM tasks').all() as unknown[]
      const runs = store.repos.prepare('SELECT * FROM task_runs').all() as unknown[]
      const logs = store.repos.prepare('SELECT * FROM task_logs').all() as unknown[]
      expect(tasks).toHaveLength(0)
      expect(runs).toHaveLength(0)
      expect(logs).toHaveLength(0)
      expect(store.repos.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(store.repos.prepare('PRAGMA user_version').get()).toEqual({ user_version: latest })
    } finally { store.close() }
  } finally {
    child?.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
