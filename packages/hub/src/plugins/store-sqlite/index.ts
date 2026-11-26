import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { Context, Service } from 'cordis'
import type { Clock } from '../../services/clock.js'
import type { TaskStore, Repos, RetentionMetrics } from '../../services/store.js'
import { IngestQueue } from './ingest-queue.js'
import { ArtifactStore } from './artifacts.js'
import * as schema from './schema.js'
import { repositories } from './repositories.js'
import { z } from 'zod'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'

export interface StorageConfig {
  path: string
  ingest?: { batchMs?: number; batchRows?: number; maxQueueRows?: number }
  maxBytesPerRun?: number
  redactionPatterns?: string[]
}
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
function fileSize(path: string) { return statSync(path, { throwIfNoEntry: false })?.size ?? 0 }

function migrate(db: Database.Database, path: string, now: number) {
  const files = readdirSync(migrations).filter(file => /^\d+_.+\.sql$/.test(file)).sort()
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > files.length) throw new Error('Database was created by a newer Hub')
  if (version === files.length) return
  const backupDir = resolve(dirname(path), 'backup')
  const prefix = path.slice(dirname(path).length + 1) + '.bak-'
  if (path !== ':memory:' && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get()) {
    mkdirSync(backupDir, { recursive: true })
    db.prepare('VACUUM INTO ?').run(resolve(backupDir, prefix + version + '-' + now + '-' + crypto.randomUUID()))
  }
  db.transaction(() => {
    const current = db.pragma('user_version', { simple: true }) as number
    for (const file of files.slice(current)) db.exec(readFileSync(resolve(migrations, file), 'utf8'))
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(files.length))
    db.pragma('user_version=' + files.length)
  }).exclusive()
  if (path !== ':memory:' && statSync(backupDir, { throwIfNoEntry: false })) {
    const backups = readdirSync(backupDir).filter(file => file.startsWith(prefix))
    backups.sort((a, b) => statSync(resolve(backupDir, b)).mtimeMs - statSync(resolve(backupDir, a)).mtimeMs)
    for (const file of backups.slice(3)) unlinkSync(resolve(backupDir, file))
  }
}

export function openStore(config: StorageConfig, clock: Clock) {
  const path = config.path === ':memory:' ? config.path : resolve(config.path)
  const fresh = path === ':memory:' || !fileSize(path)
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  const { repos, tx, artifacts } = (() => {
    try {
      if (fresh) {
        db.pragma('page_size = 8192')
        db.pragma('auto_vacuum = INCREMENTAL')
      }
      for (const pragma of ['journal_mode = WAL', 'synchronous = NORMAL', 'foreign_keys = ON', 'busy_timeout = 5000',
        'temp_store = MEMORY', 'cache_size = -65536', 'wal_autocheckpoint = 1000', 'journal_size_limit = 67108864']) db.pragma(pragma)
      migrate(db, path, clock.now())
      const orm = drizzle(db, { schema })
      const repos: Repos = Object.assign(orm, repositories(orm), { prepare: db.prepare.bind(db), pragma: db.pragma.bind(db) })
      const tx: TaskStore['tx'] = fn => db.transaction(() => {
        const result = fn(repos)
        if (result && typeof result === 'object' && 'then' in result) throw new TypeError('SQLite transactions must be synchronous')
        return result
      }).immediate()
      let storeId = db.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() as string | undefined
      if (!storeId) {
        storeId = randomUUID()
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('artifacts_store_id', ?)").run(storeId)
      }
      const artifacts = new ArtifactStore(config.path, () => repos, storeId)
      artifacts.reconcile(repos)
      return { repos, tx, artifacts }
    } catch (error) {
      db.close()
      throw error
    }
  })()
  const ingestOptions = (value: StorageConfig) => ({
    batchRows: value.ingest?.batchRows ?? 500, maxQueueRows: value.ingest?.maxQueueRows ?? 50_000,
    maxBytesPerRun: value.maxBytesPerRun ?? 20 * 1024 * 1024, redactionPatterns: value.redactionPatterns ?? [],
    saveVisualShot: (db: Repos, runId: string, phase: 'before' | 'after', shot: import('@agent-hub/protocol').VisualCheckShot, ts: number) => {
      if (!shot.imageBase64 || !shot.mimeType) return undefined
      const run = db.runs.get(runId)
      if (!run) return undefined
      const saved = artifacts.save({
        taskId: run.taskId, runId,
        kind: phase === 'before' ? 'visual_before' : 'visual_after',
        label: shot.route, mimeType: shot.mimeType, data: Buffer.from(shot.imageBase64, 'base64'),
        meta: { ...(shot.routeIndex !== undefined && { routeIndex: shot.routeIndex }), route: shot.route, url: shot.url, statusCode: shot.statusCode, blankPage: shot.blankPage, consoleErrors: shot.consoleErrors, pageErrors: shot.pageErrors },
        now: ts, repos: db,
      })
      return saved.id
    },
  })
  const retention: RetentionMetrics = { storageLevel: 'ok', retentionDeletedRowsTotal: 0, lastBackupAt: null }
  const ingest = new IngestQueue({ tx, retention }, ingestOptions(config))
  const timer = (value: StorageConfig) => clock.setInterval(() => { void ingest.flush() }, value.ingest?.batchMs ?? 50)
  let stop = timer(config)
  return { repos, tx, ingest, artifacts, retention, health: () => ({ ok: db.open, walSizeBytes: fileSize(path + '-wal'), dbSizeBytes: fileSize(path) }),
    configure(next: StorageConfig) { ingest.configure(ingestOptions(next)); stop(); stop = timer(next) },
    close() {
      if (!db.open) return
      stop()
      void ingest.flush()
      try { db.pragma('wal_checkpoint(TRUNCATE)') } finally { db.close() }
    },
  }
}

export class StoreSqlite extends Service implements TaskStore {
  static inject = ['clock']
  static Config = HubConfigSchema.shape.storage.unwrap().extend({
    maxBytesPerRun: z.number().int().positive().optional(),
    redactionPatterns: z.array(z.string()).optional(),
  })
  private store!: ReturnType<typeof openStore>
  constructor(ctx: Context, private readonly config: StorageConfig) { super(ctx, 'store') }
  [Service.init]() {
    this.store = openStore(this.config, this.ctx.clock)
    this.ctx.effect(() => () => this.store.close(), 'store:close')
    onHotUpdate<StorageConfig>(this.ctx, ['ingest', 'maxBytesPerRun', 'redactionPatterns'], next => this.store.configure(next))
  }
  get retention() { return this.store.retention }
  get repos() { return this.store.repos }
  get ingest() { return this.store.ingest }
  get artifacts() { return this.store.artifacts }
  tx<T>(fn: (repos: Repos) => T): T { return this.store.tx(fn) }
  health() { return this.store.health() }
}
