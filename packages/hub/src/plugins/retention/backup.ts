import { mkdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { Repos } from '../../services/store.js'

export async function dailyBackup(
  db: Repos,
  source: string,
  directory: string | undefined,
  date: string,
  artifactsRoot?: string,
  readMemoryArtifact?: (row: { id: string; storageRelPath: string; bytes: number; sha256: string }) => Buffer | undefined,
) {
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
  db.prepare('PRAGMA optimize').all()
  if (!directory) return false
  mkdirSync(directory, { recursive: true })
  const sourceBase = source === ':memory:' ? 'hub.sqlite' : basename(resolve(source))
  const isDefaultHub = source === ':memory:' || sourceBase.toLowerCase() === 'hub.sqlite'
  const dbPrefix = isDefaultHub ? 'hub' : sourceBase
  const artPrefix = isDefaultHub ? 'artifacts' : `${sourceBase}.artifacts`
  const storeId = (db.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() as string | undefined) ?? null
  if (!storeId) throw new Error('BACKUP_STORE_ID_MISSING')
  const stagedDb = source === ':memory:' ? join(directory, `${dbPrefix}-${date}.sqlite.${randomUUID()}.staged.tmp`) : undefined
  try {
    let memoryArtifacts: Record<string, Uint8Array> | undefined
    if (stagedDb) db.prepare('VACUUM INTO ?').run(stagedDb)
    if (source === ':memory:' && !artifactsRoot && readMemoryArtifact) {
      const memRows = db.prepare('SELECT id, storage_rel_path, bytes, sha256 FROM run_artifacts').all() as Array<{
        id: string; storage_rel_path: string; bytes: number; sha256: string
      }>
      if (memRows.length) {
        const collected: Record<string, Uint8Array> = {}
        for (const r of memRows) {
          const buf = readMemoryArtifact({ id: r.id, storageRelPath: r.storage_rel_path, bytes: r.bytes, sha256: r.sha256 })
          if (!buf) throw new Error('BACKUP_ARTIFACTS_UNAVAILABLE')
          collected[r.id] = new Uint8Array(buf)
        }
        memoryArtifacts = collected
      }
    }
    const workerData = {
      mode: stagedDb ? 'staged_db' : 'file',
      ...(stagedDb ? { stagedDb } : { source }),
      directory,
      dbPrefix,
      artPrefix,
      date,
      storeId,
      ...(artifactsRoot && { artifactsRoot }),
      ...(memoryArtifacts && { memoryArtifacts }),
    }
    await new Promise<void>((resolveWorker, rejectWorker) => {
      const worker = new Worker(new URL('../../../maintenance/backup.mjs', import.meta.url), {
        workerData,
        execArgv: [],
      })
      let workerResult: { ok: boolean; error?: string } | undefined
      worker.on('message', (msg: { ok: boolean; error?: string }) => { workerResult = msg })
      worker.once('error', rejectWorker)
      worker.once('exit', code => {
        if (workerResult && !workerResult.ok) {
          rejectWorker(new Error(workerResult.error ?? 'BACKUP_FAILED'))
        } else if (code !== 0) {
          rejectWorker(new Error('Backup worker exited with code ' + code))
        } else {
          resolveWorker()
        }
      })
    })
  } finally {
    if (stagedDb) rmSync(stagedDb, { force: true })
  }
  return true
}
