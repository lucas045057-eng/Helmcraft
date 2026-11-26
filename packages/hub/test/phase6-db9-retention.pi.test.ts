/**
 * Pi 独立验收 · Phase 6 · DB-9（保留策略分片删除 / 百万行 / 辅助表 TTL / 每日备份）
 *
 * 与 Codex 的 `phase6-retention.test.ts` 相互独立：
 *  - 百万行日志 + 活动 Run 每片并发写入，直接观测每条 `DELETE ... LIMIT` 的 changes，
 *    断言“每片 ≤ 5,000 行”、活动 Run 绝不被清理、`logs_purged_at` 只在日志清空后推进、
 *    取消/腾挪期间的 ingest p99 < 200 ms、累计 10 万行触发 `incremental_vacuum`。
 *  - 五张辅助表的 TTL 边界（等式边界保留、过期 1 ms 删除）与分片上限。
 *  - 每日 04:00 `VACUUM INTO` 快照轮换（仅日期命名、保留 7 份）与 `PRAGMA integrity_check`。
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { createTestHub } from '../src/app.js'
import { cleanup, incrementalVacuum } from '../src/plugins/retention/cleanup.js'
import { assertInvariants } from './pi/harness.js'
import { dayMs, mib, observeSlices, recordMetrics, seedRun, stats } from './pi/phase6.js'
import { openStore } from '../src/plugins/store-sqlite/index.js'

const epoch = Date.UTC(2026, 0, 15, 0)

it('DB-9a 百万行日志分片删除：每片 ≤ 5,000 行、活动 Run 不被清理、并发写入 p99 < 200 ms、incremental_vacuum 触发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-db9-million-'))
  const clock = new FakeClock(epoch)
  const hub = await createTestHub({
    storage: { path: join(dir, 'hub.sqlite'), ingest: { batchMs: 10 } },
    retention: { sliceIntervalMs: 10, sliceRows: 5000 },
  }, { listen: false, clock })
  const store = hub.ctx.store
  let observation: ReturnType<typeof observeSlices> | undefined
  try {
    store.tx(db => {
      seedRun(db, { id: 'pi-archive', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 31, now: epoch, logs: 1_000_000 },
      )
      seedRun(db, { id: 'pi-live', taskStatus: 'running', runStatus: 'running', ageDays: 400, now: epoch })
    })
    expect(store.repos.prepare('SELECT count(*) FROM task_logs').pluck().get()).toBe(1_000_000)
    // 清理前（日志完整）INV-1~INV-8 全部成立。
    assertInvariants(store.repos)
    // 1M 行全部过期（succeeded 任务 30 天 + 1 天）：每片 5000 行需要 201 次 tick。
    const rowsBefore = store.health().dbSizeBytes
    expect(rowsBefore).toBeGreaterThan(5 * mib)

    observation = observeSlices(store.repos)
    const latencies: number[] = []
    const sliceDurations: number[] = []
    for (let seq = 1; seq <= 201; seq++) {
      const start = performance.now()
      const write = store.ingest.enqueue('pi-live-run', [
        { kind: 'log', seq, ts: clock.now(), stream: 'stdout', text: 'live-' + seq },
      ])
      const deletedBefore = store.retention.retentionDeletedRowsTotal
      clock.advance(10) // 触发一个保留切片（cleanup 同步执行）
      await store.ingest.flush()
      await write
      const deleted = store.retention.retentionDeletedRowsTotal - deletedBefore
      sliceDurations.push(deleted)
      latencies.push(performance.now() - start)
      if (seq <= 200) {
        expect(deleted).toBe(5000)
        expect(store.repos.runs.get('pi-archive-run')!.logsPurgedAt).toBeNull()
      } else {
        expect(deleted).toBe(0)
      }
      expect(store.repos.runs.get('pi-live-run')!.lastSeq).toBe(seq)
    }
    expect(observation.logDeletes).toHaveLength(201)
    for (const changes of observation.logDeletes) expect(changes).toBeLessThanOrEqual(5000)
    expect(observation.logDeletes.slice(0, 200)).toEqual(Array(200).fill(5000))
    expect(observation.logDeletes[200]).toBe(0)

    // 活动 Run：整轮清理后日志一条不少，且永不被标记清理。
    expect(store.repos.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-live-run'").pluck().get()).toBe(201)
    expect(store.repos.prepare('SELECT count(*) FROM task_logs').pluck().get()).toBe(201)
    expect(store.repos.runs.get('pi-live-run')!.logsPurgedAt).toBeNull()
    expect(store.repos.runs.get('pi-live-run')!.status).toBe('running')
    // logs_purged_at 恰在日志排空后的那一片推进到当前时间。
    expect(store.repos.runs.get('pi-archive-run')!.logsPurgedAt).toBe(clock.now())
    expect(store.retention.retentionDeletedRowsTotal).toBe(1_000_000)

    // incremental_vacuum：每累计 100 000 行触发一次 → 至少 10 次；auto_vacuum 为 INCREMENTAL。
    expect(observation.vacuumCalls).toBeGreaterThanOrEqual(10)
    expect(store.repos.prepare('PRAGMA auto_vacuum').pluck().get()).toBe(2)

    const timing = stats(latencies)
    console.info('[DB-9a] ingest+sice latency ms p50=%s p95=%s p99=%s max=%s; vacuum=%d; deleted=%d',
      timing.p50.toFixed(1), timing.p95.toFixed(1), timing.p99.toFixed(1), timing.max.toFixed(1),
      observation.vacuumCalls, store.retention.retentionDeletedRowsTotal)
    console.info('[DB-9a] sliceChanges=%d slices; all ≤ 5000: %s', sliceDurations.length,
      sliceDurations.every(value => value <= 5000))
    recordMetrics('DB-9a', { rowsPurged: store.retention.retentionDeletedRowsTotal, slices: observation.logDeletes.length,
      maxSliceRows: Math.max(...observation.logDeletes), incrementalVacuumCalls: observation.vacuumCalls,
      ingestP50Ms: Number(timing.p50.toFixed(1)), ingestP95Ms: Number(timing.p95.toFixed(1)),
      ingestP99Ms: Number(timing.p99.toFixed(1)), ingestMaxMs: Number(timing.max.toFixed(1)),
      activeRunRows: store.repos.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-live-run'").pluck().get() })
    expect(timing.p99).toBeLessThan(200)

    // 再推进若干片：已清理 Run 不再重复计入，活动 Run 依然保留。
    for (let index = 0; index < 5; index++) clock.advance(10)
    expect(store.retention.retentionDeletedRowsTotal).toBe(1_000_000)
    expect(store.repos.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-live-run'").pluck().get()).toBe(201)
    // 外键与结构完整性（日志被合法清理后 INV-7 对已清理 Run 不再适用，见报告说明）。
    expect(store.repos.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const active = store.repos.prepare("SELECT count(*) FROM tasks WHERE status IN ('running','queued','dispatching','awaiting_input','cancelling','awaiting_approval')").pluck().get()
    expect(active).toBe(1)
    expect(store.repos.prepare('SELECT count(*) FROM task_runs WHERE logs_purged_at IS NOT NULL').pluck().get()).toBe(1)
  } finally {
    observation?.restore()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)

it('DB-9b 辅助表 TTL：audit 365d / feishu 7d / idempotency 24h / 会话与注册令牌过期后 7d，边界不误删', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-db9-aux-'))
  const clock = new FakeClock(epoch)
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite') }, retention: { sliceIntervalMs: 20, sliceRows: 5000 } },
    { listen: false, clock })
  const store = hub.ctx.store
  const db = store.repos
  try {
    interface AuxCase { table: string; column: string; days: number; insert: string; key: string }
    const cases: AuxCase[] = [
      { table: 'audit_logs', column: 'ts', days: 365, key: 'audit',
        insert: "INSERT INTO audit_logs(ts,actor_type,actor_id,channel,action,target_type,target_id) VALUES (?,'system','hub','system','pi.audit','task',?)" },
      { table: 'feishu_event_dedupe', column: 'received_at', days: 7, key: 'feishu',
        insert: 'INSERT INTO feishu_event_dedupe(key,received_at) VALUES (?,?)' },
      { table: 'idempotency_keys', column: 'created_at', days: 1, key: 'idem',
        insert: "INSERT INTO idempotency_keys(scope,key,request_hash,response_json,created_at) VALUES ('pi',?, 'h','{}',?)" },
      { table: 'dashboard_sessions', column: 'expires_at', days: 7, key: 'session',
        insert: 'INSERT INTO dashboard_sessions(id,token_hash,csrf_token,created_at,last_seen_at,expires_at) VALUES (? ,?,? ,0,0,?)' },
      { table: 'enroll_tokens', column: 'expires_at', days: 7, key: 'enroll',
        insert: "INSERT INTO enroll_tokens(token_hash,created_by,created_at,expires_at) VALUES (?, 'hub',0,?)" },
    ]
    const count = (table: string) => db.prepare('SELECT count(*) FROM ' + table).pluck().get() as number
    const insert = (item: AuxCase, suffix: string, at: number) => {
      if (item.table === 'audit_logs') db.prepare(item.insert).run(at, item.key + suffix)
      else if (item.table === 'enroll_tokens') db.prepare(item.insert).run(item.key + suffix, at)
      else if (item.table === 'dashboard_sessions') db.prepare(item.insert).run(item.key + suffix, 'h' + suffix, 'c' + suffix, at)
      else db.prepare(item.insert).run(item.key + suffix, at)
    }
    // ① 边界语义：`< cutoff` 严格小于才删 → 恰在 cutoff 的保留，早 1 ms 的删除。
    for (const item of cases) {
      const cutoff = epoch - item.days * dayMs
      insert(item, '-boundary', cutoff)
      insert(item, '-just-old', cutoff - 1)
      expect(count(item.table)).toBe(2)
    }
    cleanup(store, epoch, { sliceRows: 5000, retentionDays: { succeeded: 30, other: 90 } })
    for (const item of cases) expect({ table: item.table, rows: count(item.table) }).toEqual({ table: item.table, rows: 1 })
    expect(db.prepare("SELECT target_id FROM audit_logs WHERE target_id LIKE 'audit%'").pluck().get()).toBe('audit-boundary')
    // ② 插件接线：每 sliceIntervalMs 真实调度同一 cleanup。过期行（含刚才的边界行，因 tick 时间已推进 20 ms）删除，
    //    未过期（cutoff 之后 1 小时）必须保留。
    for (const item of cases) insert(item, '-fresh', epoch - item.days * dayMs + 3_600_000)
    clock.advance(20)
    for (const item of cases) {
      expect({ table: item.table, rows: count(item.table) }).toEqual({ table: item.table, rows: 1 })
    }
    expect(db.prepare("SELECT target_id FROM audit_logs WHERE target_id LIKE 'audit%'").pluck().get()).toBe('audit-fresh')
    // 再 tick 仍不会误删未过期数据。
    clock.advance(20)
    for (const item of cases) expect(count(item.table)).toBe(1)
  } finally {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('DB-9c 每日 04:00 VACUUM INTO 备份：仅轮换日期快照并保留 7 份，快照 integrity_check = ok 且含已提交 WAL 数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-db9-backup-'))
  const backup = join(dir, 'backup')
  mkdirSync(backup)
  writeFileSync(join(backup, 'hub.sqlite.bak-0-prev'), 'migration')
  const clock = new FakeClock(Date.parse('2026-01-14T19:59:00Z')) // Asia/Shanghai 03:59
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite') }, server: { timezone: 'Asia/Shanghai' },
    retention: { sliceIntervalMs: 60_000 } }, { listen: false, clock })
  try {
    const store = hub.ctx.store
    // 9 份同库所有权的历史日期快照 + 1 份迁移备份（非日期命名，必须保留）。
    const storeId = store.repos.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() as string
    for (let day = 1; day <= 9; day++) {
      const stub = new Database(join(backup, 'hub-2026-01-0' + day + '.sqlite'))
      stub.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE run_artifacts(id TEXT PRIMARY KEY, storage_rel_path TEXT, bytes INTEGER, sha256 TEXT);')
      stub.prepare("INSERT INTO meta(key, value) VALUES ('artifacts_store_id', ?)").run(storeId)
      stub.close()
    }
    // 通过 IngestQueue 提交（WAL 中），验证备份包含“已提交但未 checkpoint”的数据。
    store.tx(db => seedRun(db, { id: 'pi-backup', taskStatus: 'running', runStatus: 'running', ageDays: 1, now: clock.now() }))
    const write = store.ingest.enqueue('pi-backup-run', [{ kind: 'started', seq: 1, ts: clock.now(), pid: 1,
      adapter: 'mock', effectiveProfile: 'readonly', commandSummary: 'mock' }])
    await store.ingest.flush()
    await write
    expect(store.retention.lastBackupAt).toBeNull()
    clock.advance(59_999)
    expect(store.retention.lastBackupAt).toBeNull()
    clock.advance(1)
    const started = Date.now()
    while (store.retention.lastBackupAt === null && Date.now() - started < 15_000) await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.retention.lastBackupAt).toBe(clock.now())

    const names = readdirSync(backup)
    const dated = names.filter(name => /^hub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort()
    expect(dated).toHaveLength(7)
    expect(dated).toContain('hub-2026-01-15.sqlite')
    expect(dated).not.toContain('hub-2026-01-03.sqlite') // 最早的 3 份被轮换
    expect(names).toContain('hub.sqlite.bak-0-prev')
    expect(names.some(name => name.endsWith('.tmp'))).toBe(false)

    const snapshot = new Database(join(backup, 'hub-2026-01-15.sqlite'), { readonly: true })
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(snapshot.pragma('foreign_key_check')).toEqual([])
      expect(snapshot.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-backup-run'").pluck().get()).toBe(1)
      expect(snapshot.pragma('journal_mode', { simple: true })).not.toBe('wal')
    } finally { snapshot.close() }
    // 备份成功后同一天不会重复生成 / 覆盖。
    const bytes = readdirSync(backup).length
    clock.advance(60_000)
    expect(readdirSync(backup).length).toBe(bytes)
  } finally {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

it('DB-9d 空间回收（对抗性追加）：百万行按分片策略全部清理后，主库文件应显著缩小且 freelist 回落', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-db9-shrink-'))
  const path = join(dir, 'hub.sqlite')
  const store = openStore({ path }, new FakeClock(epoch))
  const filesize = () => statSync(path).size
  const pages = (name: string) => store.repos.prepare('PRAGMA ' + name).pluck().get() as number
  const observations: Record<string, number> = {}
  try {
    store.tx(db => {
      seedRun(db, { id: 'pi-shrink', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 31, now: epoch, logs: 1_000_000 })
    })
    store.repos.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    observations.beforeBytes = filesize()
    observations.beforePages = pages('page_count')

    // 与 `retention` 插件完全一致的步调：每片 5,000 行；每累计 100,000 行执行 incrementalVacuum(2000)。
    let deleted = 0
    let vacuums = 0
    for (let slice = 0; slice < 201; slice++) {
      deleted += store.repos.prepare('DELETE FROM task_logs WHERE id IN (SELECT id FROM task_logs LIMIT 5000)').run().changes
      while (deleted >= (vacuums + 1) * 100_000) {
        incrementalVacuum(store.repos, 2000)
        vacuums += 1
      }
    }
    store.repos.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    expect(deleted).toBe(1_000_000)
    expect(store.repos.prepare('SELECT count(*) FROM task_logs').pluck().get()).toBe(0)
    observations.afterPurgeBytes = filesize()
    observations.afterPurgePages = pages('page_count')
    observations.afterPurgeFreelist = pages('freelist_count')
    // 再补 10 次（按实现自带的参数）——即使这样，也要看到净回收。
    for (let index = 0; index < 10; index++) incrementalVacuum(store.repos, 2000)
    store.repos.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    observations.afterExtraVacuumBytes = filesize()
    observations.afterExtraVacuumFreelist = pages('freelist_count')
    // 对照：数据确实已删除，`VACUUM` 可立即把库收缩到极小（证明未回收的只是页，不是数据）。
    store.repos.prepare('VACUUM').run()
    store.repos.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    observations.afterVacuumBytes = filesize()
    observations.afterVacuumPages = pages('page_count')
    console.info('[DB-9d] %s', JSON.stringify(observations))
    recordMetrics('DB-9d', observations)
    // 门禁（07 §6 容量护栏依赖空间回落）：清理 100% 行后主库应至少回收一半。
    expect(observations.afterPurgeBytes!).toBeLessThan(observations.beforeBytes! * 0.5)
    expect(observations.afterPurgeFreelist!).toBeLessThan(observations.beforePages! * 0.1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
