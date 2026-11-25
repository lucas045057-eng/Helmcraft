import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { Repos } from '../../services/store.js'

export async function dailyBackup(db: Repos, source: string, directory: string | undefined, date: string) {
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
  db.prepare('PRAGMA optimize').all()
  if (!directory) return false
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'hub-' + date + '.sqlite')
  if (!existsSync(target)) {
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      if (source === ':memory:') db.prepare('VACUUM INTO ?').run(temporary)
      else await new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL('../../../maintenance/backup.mjs', import.meta.url), {
          workerData: { source, destination: temporary }, execArgv: [],
        })
        worker.once('error', reject)
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error('Backup worker exited with code ' + code)))
      })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
  }
  const backups = readdirSync(directory).filter(file => /^hub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort()
  for (const old of backups.slice(0, -7)) rmSync(join(directory, old))
  return true
}
