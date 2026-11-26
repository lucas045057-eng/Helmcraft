import { expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '@agent-hub/common'
import type { RunStatus, TaskStatus } from '@agent-hub/protocol'
import { openStore } from '../src/plugins/store-sqlite/index.js'
import { cleanup, dayMs } from '../src/plugins/retention/cleanup.js'
import { createTestHub } from '../src/app.js'
import { safeOn } from '../src/kernel/safe.js'
import type { Repos } from '../src/services/store.js'

const epoch = Date.UTC(2026, 0, 15, 0)
function seed(db: Repos, id: string, task: TaskStatus, run: RunStatus, days: number, count = 1) {
  const at = epoch - days * dayMs
  db.prepare("INSERT OR IGNORE INTO workers(id,display_name,public_key,key_fingerprint,created_at,updated_at) VALUES ('w','w','key','fp',0,0)").run()
  db.tasks.insert({ id, status: task, source: 'dashboard', originJson: { source: 'dashboard' }, requesterType: 'owner',
    requesterId: 'owner', title: id, prompt: id, workspaceId: 'sandbox', profile: 'readonly', timeoutMs: 60_000,
    policyDecisionJson: { decision: 'auto_approve', ruleId: null }, createdAt: at, updatedAt: at, finishedAt: at })
  db.prepare(`INSERT INTO task_runs(id,task_id,status,finished_at,last_seq,run_seq,attempt,worker_id,adapter,workspace_id,profile,not_after,dispatched_at)
    VALUES (?,?,?,?,?,1,1,'w','mock','sandbox','readonly',0,0)`).run(id, id, run, at, count)
  if (count) db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO task_logs(run_id,seq,ts,kind,bytes,text) SELECT ?,n,0,'log',1,'x' FROM seq`).run(count, id)
}
const policy = { sliceRows: 2, retentionDays: { succeeded: 30, other: 90 } }
it('bounds log transactions, marks a fully drained Run and protects active Runs and unexpired history', async () => {
  const store = openStore({ path: ':memory:' }, new FakeClock(epoch))
  try {
    store.tx(db => {
      seed(db, 'old', 'failed', 'failed', 91, 4)
      seed(db, 'succeeded', 'succeeded', 'succeeded', 31)
      seed(db, 'active', 'running', 'running', 400)
      seed(db, 'young', 'failed', 'failed', 89)
    })
    for (const expected of [2, 0]) {
      cleanup(store, epoch, policy)
      expect(store.repos.prepare("SELECT count(*) FROM task_logs WHERE run_id='old'").pluck().get()).toBe(expected)
      expect(store.repos.runs.get('old')?.logsPurgedAt).toBeNull()
    }
    cleanup(store, epoch, policy)
    expect(store.repos.runs.get('old')?.logsPurgedAt).toBe(epoch)
    cleanup(store, epoch, policy)
    expect(store.repos.runs.get('succeeded')?.logsPurgedAt).toBe(epoch)
    expect(store.repos.logs.tail('active')).toBeDefined()
    expect(store.repos.logs.tail('young')).toBeDefined()
    expect(store.retention.retentionDeletedRowsTotal).toBe(5)
    const late = store.ingest.enqueue('old', [{ kind: 'log', stream: 'stdout', seq: 5, text: 'late', ts: epoch }])
    await store.ingest.flush()
    await late
    expect(store.repos.runs.get('old')?.logsPurgedAt).toBeNull()
    cleanup(store, epoch, policy)
    expect(store.repos.logs.tail('old')).toBeUndefined()
  } finally { store.close() }
})

it('bounds auxiliary TTL deletes, respects cutoff equality and drains dependent rows before task metadata', () => {
  const store = openStore({ path: ':memory:' }, new FakeClock(epoch))
  try {
    const db = store.repos
    const lists = [
      ['audit_logs', 365, "INSERT INTO audit_logs(ts,actor_type,actor_id,channel,action,target_type,target_id) VALUES (?,'system','hub','system','x','task','t')"],
      ['feishu_event_dedupe', 7, "INSERT INTO feishu_event_dedupe(key,received_at) VALUES (hex(randomblob(16)),?)"],
      ['idempotency_keys', 1, "INSERT INTO idempotency_keys VALUES ('s',hex(randomblob(16)),'h','{}',?)"],
      ['dashboard_sessions', 7, "INSERT INTO dashboard_sessions(id,token_hash,csrf_token,created_at,last_seen_at,expires_at) VALUES (hex(randomblob(16)),hex(randomblob(16)),'c',0,0,?)"],
      ['enroll_tokens', 7, "INSERT INTO enroll_tokens(token_hash,created_by,created_at,expires_at) VALUES (hex(randomblob(16)),'hub',0,?)"],
    ] as const
    for (const [, days, insert] of lists) for (const offset of [-1, -1, -1, 0]) db.prepare(insert).run(epoch - days * dayMs + offset)
    seed(db, 'expired', 'succeeded', 'succeeded', 366, 3)
    seed(db, 'young', 'succeeded', 'succeeded', 364)
    for (let n = 0; n < 4; n++) db.prepare(`INSERT INTO input_requests(id,task_id,run_id,question,status,created_at,expires_at)
      VALUES (?,'expired','expired','q','answered',0,0)`).run('input' + n)
    cleanup(store, epoch, policy)
    expect(db.tasks.get('expired')).toBeDefined()
    expect(db.prepare('SELECT count(*) FROM input_requests').pluck().get()).toBe(4)
    for (const [table] of lists) expect(db.prepare('SELECT count(*) FROM ' + table).pluck().get()).toBe(2)
    cleanup(store, epoch, policy)
    expect(db.prepare('SELECT count(*) FROM input_requests').pluck().get()).toBe(2)
    for (let n = 0; n < 3; n++) cleanup(store, epoch, policy)
    expect(db.tasks.get('expired')).toBeUndefined()
    expect(db.runs.get('expired')).toBeUndefined()
    expect(db.tasks.get('young')).toBeDefined()
    for (const [table] of lists) expect(db.prepare('SELECT count(*) FROM ' + table).pluck().get()).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally { store.close() }
})

it('applies capacity thresholds on hot update, publishes level changes and resumes the same Run after critical pressure', async () => {
  const clock = new FakeClock(epoch)
  const dir = mkdtempSync(join(tmpdir(), 'hub-cap-'))
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite') } }, { listen: false, clock })
  try {
    const store = hub.ctx.store, db = store.repos
    store.tx(repo => { seed(repo, 'live', 'running', 'running', 1, 0); seed(repo, 'short', 'succeeded', 'succeeded', 16) })
    const fiber = hub.fibers.get('retention')!
    const levels: string[] = []
    safeOn(hub.ctx, 'hub/status', value => { if (value.storageLevel) levels.push(value.storageLevel) })
    const size = store.health().dbSizeBytes
    const cap = (maxDbBytes: number) => fiber.update({ ...fiber.config, maxDbBytes, sliceIntervalMs: 100 })
    await cap(Math.floor(size / .8))
    expect(store.retention.storageLevel).toBe('warning')
    clock.advance(100)
    expect(db.runs.get('short')?.logsPurgedAt).toBe(clock.now())
    await cap(Math.floor(size / .95))
    expect(store.retention.storageLevel).toBe('critical')
    const log = (seq: number) => ({ seq, ts: epoch, kind: 'log', stream: 'stdout', text: 'payload' } as const)
    await store.ingest.enqueue('live', [{ kind: 'started', seq: 1, ts: epoch, pid: 1, adapter: 'mock', effectiveProfile: 'readonly', commandSummary: 'mock' }])
    const promise = store.ingest.enqueue('live', [log(2), log(3)])
    await store.ingest.flush()
    await expect(promise).resolves.toEqual({ lastSeq: 3 })
    await store.ingest.enqueue('live', [log(4), { kind: 'agent', seq: 5, ts: epoch, event: { type: 'init' } },
      { kind: 'session', seq: 6, ts: epoch, cliSessionId: 'ok' }])
    const token = hub.ctx.auth.createApiToken('metrics', ['admin'])
    const get = async (path: string) => (await hub.ctx.http.app.inject({ url: '/api/v1/' + path, headers: { authorization: 'Bearer ' + token } })).json()
    expect(await get('system/metrics')).toMatchObject({ storageLevel: 'critical', retentionDeletedRowsTotal: 1, lastBackupAt: null })
    expect((await get('overview')).hub.storageLevel).toBe('critical')
    await cap(size * 2)
    await store.ingest.enqueue('live', [log(7), { kind: 'finished', seq: 8, ts: epoch, status: 'succeeded', exitCode: 0, signal: null, durationMs: 1, summary: 'ok' }])
    expect(db.prepare("SELECT seq,kind,text FROM task_logs WHERE run_id='live' ORDER BY seq").all()).toEqual([
      { seq: 1, kind: 'started', text: null }, { seq: 2, kind: 'gap', text: null }, { seq: 5, kind: 'agent', text: null },
      { seq: 6, kind: 'session', text: null }, { seq: 7, kind: 'log', text: 'payload' }, { seq: 8, kind: 'finished', text: null },
    ])
    expect(db.prepare("SELECT json_extract(data_json,'$.toSeq') FROM task_logs WHERE run_id='live' AND seq=2").pluck().get()).toBe(4)
    expect(levels).toEqual(['warning', 'critical', 'ok'])
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }) }
})

it('DB-9 interleaves a live ingest commit with each 5000-row slice of a million-row WAL database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-million-'))
  const clock = new FakeClock(epoch)
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite'), ingest: { batchMs: 50 } },
    retention: { sliceIntervalMs: 10 } }, { listen: false, clock })
  try {
    const store = hub.ctx.store
    store.tx(db => {
      seed(db, 'archive', 'succeeded', 'succeeded', 31, 1_000_000)
      seed(db, 'current', 'running', 'running', 1, 0)
    })
    const latency: number[] = []
    for (let seq = 1; seq <= 201; seq++) {
      const start = performance.now()
      const write = store.ingest.enqueue('current', [{ kind: 'log', seq, ts: clock.now(), stream: 'stdout', text: 'live' }])
      const before = store.retention.retentionDeletedRowsTotal
      clock.advance(10)
      await store.ingest.flush()
      expect((await write).lastSeq).toBe(seq)
      latency.push(performance.now() - start)
      expect(store.retention.retentionDeletedRowsTotal - before).toBe(seq <= 200 ? 5000 : 0)
      if (seq <= 200) expect(store.repos.runs.get('archive')?.logsPurgedAt).toBeNull()
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(store.repos.runs.get('archive')?.logsPurgedAt).toBe(clock.now())
    expect(store.repos.prepare('SELECT count(*) FROM task_logs').pluck().get()).toBe(201)
    const p99 = latency.sort((a, b) => a - b)[Math.ceil(.99 * latency.length) - 1]!
    console.info('DB-9 ingest + slice p99 (ms)', p99.toFixed(1))
    expect(p99).toBeLessThan(200)
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }) }
}, 60_000)

it('hot-reloads hub.yaml and displays both capacity banners over the dashboard WebSocket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-banner-')), path = join(dir, 'hub.yaml')
  const config = { storage: { path: join(dir, 'hub.sqlite') }, server: { port: 0, allowInsecureWorker: true } }
  writeFileSync(path, JSON.stringify(config))
  const hub = await createTestHub(config, { configPath: path })
  const browser = await chromium.launch({ channel: 'chrome' })
  const token = randomBytes(32).toString('hex')
  vi.stubEnv('HUB_ADMIN_TOKEN_SHA256', createHash('sha256').update(token).digest('hex'))
  try {
    const page = await browser.newPage()
    const update = (maxDbBytes: number) => writeFileSync(path, JSON.stringify({ ...config,
      dashboard: { allowedOrigins: [hub.address] }, logs: { maxDbBytes }, retention: { sliceRows: 25, sliceIntervalMs: 250 } }))
    const size = hub.ctx.store.health().dbSizeBytes
    update(size * 2)
    await expect.poll(() => hub.ctx.auth.originAllowed(hub.address)).toBe(true)
    await page.goto(hub.address!)
    await page.getByTestId('login-token').fill(token)
    await page.getByTestId('login-submit').click()
    await expect.poll(() => page.getByTestId('dashboard-connection').textContent({ timeout: 5000 })).toBe('实时在线')
    const alert = page.getByTestId('hub-alerts')
    update(Math.floor(size / .82))
    await expect.poll(() => alert.allTextContents()).toEqual([expect.stringContaining('80%')])
    update(1)
    await expect.poll(() => alert.allTextContents()).toEqual([expect.stringContaining('95%')])
    update(size * 2)
    await expect.poll(() => alert.count()).toBe(0)
    expect(hub.status().restartRequired).toBe(false)
  } finally { vi.unstubAllEnvs(); await browser.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

it('backs up committed WAL data at local 04:00 and rotates only dated snapshots', async () => {
  const clock = new FakeClock(Date.parse('2026-01-14T19:59:00Z'))
  const dir = mkdtempSync(join(tmpdir(), 'hub-daily-')), backup = join(dir, 'backup')
  mkdirSync(backup)
  writeFileSync(join(backup, 'hub.sqlite.bak-0-prev'), '')
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite') }, server: { timezone: 'Asia/Shanghai' } }, { listen: false, clock })
  try {
    const storeId = hub.ctx.store.repos.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() as string
    for (let i = 1; i <= 8; i++) {
      const stub = new Database(join(backup, 'hub-2026-01-0' + i + '.sqlite'))
      stub.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE run_artifacts(id TEXT PRIMARY KEY, storage_rel_path TEXT, bytes INTEGER, sha256 TEXT);')
      stub.prepare("INSERT INTO meta(key, value) VALUES ('artifacts_store_id', ?)").run(storeId)
      stub.close()
    }
    hub.ctx.store.repos.prepare("INSERT INTO meta VALUES ('test-backup','latest')").run()
    clock.advance(59_999)
    expect(hub.ctx.store.retention.lastBackupAt).toBeNull()
    clock.advance(1)
    await expect.poll(() => hub.ctx.store.retention.lastBackupAt).toBe(clock.now())
    const names = readdirSync(backup)
    expect(names.filter(file => file.endsWith('.sqlite'))).toHaveLength(7)
    expect(names).toContain('hub.sqlite.bak-0-prev')
    expect(names).not.toContain('hub-2026-01-02.sqlite')
    const snapshot = new Database(join(backup, 'hub-2026-01-15.sqlite'), { readonly: true })
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(snapshot.prepare("SELECT value FROM meta WHERE key='test-backup'").pluck().get()).toBe('latest')
    } finally { snapshot.close() }
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }) }
})
