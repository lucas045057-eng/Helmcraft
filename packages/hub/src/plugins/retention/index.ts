import type { Context } from 'cordis'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'
import { guardAsync } from '../../kernel/safe.js'
import { cleanup, incrementalVacuum } from './cleanup.js'
import { dailyBackup } from './backup.js'

export const name = 'retention'
export const inject = ['store', 'clock']
export const Config = HubConfigSchema.shape.retention.unwrap().extend({
  maxDbBytes: HubConfigSchema.shape.logs.unwrap().shape.maxDbBytes,
  retentionDays: HubConfigSchema.shape.logs.unwrap().shape.retentionDays,
  dbPath: z.string(), timezone: HubConfigSchema.shape.server.unwrap().shape.timezone,
})
type Config = z.output<typeof Config>

export function apply(ctx: Context, initial: Config) {
  const { store, clock } = ctx
  const metrics = store.retention
  let config = initial
  let nextVacuum = (Math.floor(metrics.retentionDeletedRowsTotal / 100_000) + 1) * 100_000
  let stopSlice: () => void
  let pending: Promise<unknown> | undefined
  let completed = ''
  const formatter = (zone: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  let local = formatter(config.timezone)
  const previous = store.repos.prepare("SELECT value FROM meta WHERE key='last_backup_at'").pluck().get()
  if (previous !== undefined) {
    metrics.lastBackupAt = Number(previous)
    completed = local.format(metrics.lastBackupAt).slice(0, 10)
  }

  const checkCapacity = () => {
    const ratio = store.health().dbSizeBytes / config.maxDbBytes
    const level = ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : 'ok'
    if (metrics.storageLevel !== level) {
      metrics.storageLevel = level
      if (level !== 'ok') ctx.logger.warn('Database capacity: %s', level)
      ctx.emit('retention/level')
    }
  }
  async function runSlice() {
    checkCapacity()
    cleanup(store, clock.now(), config)
    if (metrics.retentionDeletedRowsTotal >= nextVacuum) {
      incrementalVacuum(store.repos, 2000)
      nextVacuum += 100_000
    } else if (metrics.storageLevel !== 'ok') {
      const freelist = store.repos.prepare('PRAGMA freelist_count').pluck().get() as number
      if (freelist > 0) {
        incrementalVacuum(store.repos, 2000)
        store.repos.prepare('PRAGMA wal_checkpoint(PASSIVE)').all()
      }
    }
    checkCapacity()
  }
  const startSlices = () => clock.setInterval(() => { void guardAsync(ctx, runSlice(), 'retention slice') }, config.sliceIntervalMs)
  ctx.effect(() => {
    checkCapacity()
    stopSlice = startSlices()
    return () => stopSlice()
  }, 'retention:tick')
  ctx.effect(() => {
    const maintain = () => {
      const now = clock.now()
      const parts = Object.fromEntries(local.formatToParts(now).map(part => [part.type, part.value]))
      const date = [parts.year, parts.month, parts.day].join('-')
      if (parts.hour !== '04' || completed === date || pending) return
      const directory = config.backupDir ?? (config.dbPath === ':memory:' ? undefined : resolve(dirname(config.dbPath), 'backup'))
      pending = guardAsync(ctx, (async () => {
        if (await dailyBackup(store.repos, config.dbPath, directory, date)) {
          const at = clock.now()
          store.repos.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_backup_at',?)").run(String(at))
          metrics.lastBackupAt = at
        }
        completed = date
      })(), 'daily maintenance').finally(() => { pending = undefined })
    }
    maintain()
    const stop = clock.setInterval(maintain, 60_000)
    return async () => { stop(); await pending }
  }, 'retention:maintenance')
  onHotUpdate<Config>(ctx, Object.keys(Config.shape), next => {
    const periodChanged = config.sliceIntervalMs !== next.sliceIntervalMs
    if (config.timezone !== next.timezone) local = formatter(next.timezone)
    config = next
    if (periodChanged) { stopSlice(); stopSlice = startSlices() }
    checkCapacity()
  })
}
