import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'

const OWNER_FILE = '.agent-hub-owner.json'
const BACKUP_MARKER = '.agent-hub-backup.json'

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readMarkerStoreId(dir, fileName, requireDate = false) {
  const dirStat = lstatSync(dir, { throwIfNoEntry: false })
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 'INVALID'
  const markerPath = join(dir, fileName)
  const lst = lstatSync(markerPath, { throwIfNoEntry: false })
  if (!lst) return null
  if (lst.isSymbolicLink() || !lst.isFile()) return 'INVALID'
  try {
    const fd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const fst = fstatSync(fd)
      if (!fst.isFile() || fst.nlink !== 1 || fst.size > 4096) return 'INVALID'
      const parsed = JSON.parse(readFileSync(fd, 'utf8'))
      if (requireDate && (typeof parsed.date !== 'string' || !parsed.date)) return 'INVALID'
      const sid = parsed.storeId
      if (typeof sid !== 'string' || !sid) return 'INVALID'
      return requireDate ? { storeId: sid, date: parsed.date } : { storeId: sid }
    } finally {
      closeSync(fd)
    }
  } catch {
    return 'INVALID'
  }
}

function readVerifiedArtifact(realRoot, row) {
  if (!row.storage_rel_path || row.storage_rel_path.includes('\0') || isAbsolute(row.storage_rel_path)) {
    throw new Error('INVALID_BACKUP_ARTIFACT_PATH')
  }
  const srcAbs = resolve(realRoot, row.storage_rel_path)
  const rel = relative(realRoot, srcAbs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('BACKUP_ARTIFACT_ESCAPE')
  const parent = dirname(srcAbs)
  const parentStat = lstatSync(parent, { throwIfNoEntry: false })
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('UNSAFE_BACKUP_ARTIFACT_PARENT')
  const realParent = realpathSync.native(parent)
  const parentRel = relative(realRoot, realParent)
  if (parentRel.startsWith('..') || isAbsolute(parentRel)) throw new Error('BACKUP_ARTIFACT_ESCAPE')
  const st = lstatSync(srcAbs, { throwIfNoEntry: false })
  if (!st || st.isSymbolicLink() || !st.isFile()) throw new Error('MISSING_OR_UNSAFE_BACKUP_ARTIFACT')
  const fd = openSync(srcAbs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.nlink !== 1 || fst.size !== row.bytes) throw new Error('UNVERIFIED_BACKUP_ARTIFACT')
    const buf = readFileSync(fd)
    if (buf.length !== row.bytes || createHash('sha256').update(buf).digest('hex') !== row.sha256) {
      throw new Error('BACKUP_ARTIFACT_DIGEST_MISMATCH')
    }
    return buf
  } finally {
    closeSync(fd)
  }
}

function selectArtifactRows(snap) {
  const cols = snap.prepare('PRAGMA table_info(run_artifacts)').all()
  const hasTaskId = cols.some(c => c.name === 'task_id')
  return hasTaskId
    ? snap.prepare('SELECT id, task_id, storage_rel_path, bytes, sha256 FROM run_artifacts').all()
    : snap.prepare('SELECT id, storage_rel_path, bytes, sha256 FROM run_artifacts').all().map(r => ({ ...r, task_id: null }))
}

function verifyBackupArtifactOwnership(artDir, storeId, rows) {
  const dirStat = lstatSync(artDir, { throwIfNoEntry: false })
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false
  let realArtDir
  try {
    realArtDir = realpathSync.native(artDir)
  } catch {
    return false
  }
  const ownerMarker = readMarkerStoreId(realArtDir, OWNER_FILE, false)
  if (ownerMarker === 'INVALID') return false
  if (ownerMarker !== null && ownerMarker.storeId !== storeId) return false
  const backupMarker = readMarkerStoreId(realArtDir, BACKUP_MARKER, false)
  if (backupMarker === 'INVALID') return false
  if (backupMarker !== null && backupMarker.storeId !== storeId) return false
  if (ownerMarker === null) {
    try {
      const rowById = new Map(rows.map(r => [r.id, r]))
      const entries = readdirSync(realArtDir, { withFileTypes: true }).filter(e =>
        e.name !== OWNER_FILE && !(backupMarker && backupMarker.storeId === storeId && e.name === BACKUP_MARKER))
      for (const taskEntry of entries) {
        if (taskEntry.isSymbolicLink() || !taskEntry.isDirectory() || !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(taskEntry.name)) {
          return false
        }
        const files = readdirSync(join(realArtDir, taskEntry.name), { withFileTypes: true })
        for (const f of files) {
          const match = /^(art_[0-9A-HJKMNP-TV-Z]{26})\.[a-z0-9]+$/u.exec(f.name)
          if (f.isSymbolicLink() || !f.isFile() || !match) return false
          const row = rowById.get(match[1])
          if (!row || (row.task_id !== null && row.task_id !== taskEntry.name)) return false
        }
      }
    } catch {
      return false
    }
  }
  try {
    for (const row of rows) readVerifiedArtifact(realArtDir, row)
  } catch {
    return false
  }
  return true
}

function stageVerifiedArtifacts(artifactsRoot, destinationTmp, rows) {
  const rootStat = lstatSync(artifactsRoot, { throwIfNoEntry: false })
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('UNSAFE_BACKUP_ARTIFACT_ROOT')
  const realRoot = realpathSync.native(artifactsRoot)
  mkdirSync(destinationTmp, { recursive: true, mode: 0o700 })
  for (const row of rows) {
    const buf = readVerifiedArtifact(realRoot, row)
    const dstAbs = resolve(destinationTmp, row.storage_rel_path)
    const rel = relative(destinationTmp, dstAbs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('BACKUP_ARTIFACT_ESCAPE')
    mkdirSync(dirname(dstAbs), { recursive: true, mode: 0o700 })
    writeFileSync(dstAbs, buf, { flag: 'wx', mode: 0o600 })
  }
}

function stageVerifiedMemoryArtifacts(memoryArtifacts, destinationTmp, rows) {
  mkdirSync(destinationTmp, { recursive: true, mode: 0o700 })
  for (const row of rows) {
    if (!row.storage_rel_path || row.storage_rel_path.includes('\0') || isAbsolute(row.storage_rel_path)) {
      throw new Error('INVALID_BACKUP_ARTIFACT_PATH')
    }
    const raw = memoryArtifacts[row.id]
    if (!raw) throw new Error('BACKUP_ARTIFACTS_UNAVAILABLE')
    const buf = Buffer.from(raw)
    if (buf.length !== row.bytes || createHash('sha256').update(buf).digest('hex') !== row.sha256) {
      throw new Error('BACKUP_ARTIFACT_DIGEST_MISMATCH')
    }
    const dstAbs = resolve(destinationTmp, row.storage_rel_path)
    const rel = relative(destinationTmp, dstAbs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('BACKUP_ARTIFACT_ESCAPE')
    mkdirSync(dirname(dstAbs), { recursive: true, mode: 0o700 })
    writeFileSync(dstAbs, buf, { flag: 'wx', mode: 0o600 })
  }
}

function isExclusivelyOwnedByStore(dirPath, storeId, requiredDate = null) {
  const dirStat = lstatSync(dirPath, { throwIfNoEntry: false })
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false
  const ownerMarker = readMarkerStoreId(dirPath, OWNER_FILE, false)
  if (ownerMarker === 'INVALID') return false
  if (ownerMarker !== null && ownerMarker.storeId !== storeId) return false
  const backupMarker = readMarkerStoreId(dirPath, BACKUP_MARKER, requiredDate !== null)
  if (backupMarker === 'INVALID') return false
  if (backupMarker !== null && backupMarker.storeId !== storeId) return false
  if (requiredDate !== null) return backupMarker !== null && backupMarker.date === requiredDate
  return ownerMarker !== null || backupMarker !== null
}

function runBackup(input) {
  const { mode, source, stagedDb, directory, dbPrefix, artPrefix, date, storeId, artifactsRoot, memoryArtifacts } = input
  if (mode === 'legacy_vacuum_only') {
    const db = new Database(source, { readonly: true, fileMustExist: true })
    try {
      db.prepare('VACUUM INTO ?').run(input.destination)
    } finally {
      db.close()
    }
    return
  }

  const target = join(directory, `${dbPrefix}-${date}.sqlite`)
  const artTarget = join(directory, `${artPrefix}-${date}`)
  if (existsSync(target)) {
    const snap = new Database(target, { readonly: true, fileMustExist: true })
    let existingStoreId = null
    let existingRows = []
    try {
      existingStoreId = snap.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() ?? null
      existingRows = selectArtifactRows(snap)
    } finally {
      snap.close()
    }
    if (!existingStoreId || existingStoreId !== storeId) {
      throw new Error('BACKUP_TARGET_OWNER_MISMATCH')
    }
    if ((existingRows.length > 0 || existsSync(artTarget)) && !verifyBackupArtifactOwnership(artTarget, storeId, existingRows)) {
      throw new Error('MISSING_OR_UNSAFE_BACKUP_ARTIFACTS')
    }
  } else {
    if (existsSync(artTarget)) {
      if (isExclusivelyOwnedByStore(artTarget, storeId, date)) {
        rmSync(artTarget, { recursive: true, force: true })
      } else {
        throw new Error('BACKUP_ARTIFACT_TARGET_CONFLICT')
      }
    }
    const runId = randomUUID()
    const temporaryDb = target + '.' + runId + '.tmp'
    const temporaryArt = artTarget + '.' + runId + '.tmp'
    let stagedArt = false
    try {
      if (mode === 'staged_db') {
        renameSync(stagedDb, temporaryDb)
      } else {
        const srcDb = new Database(source, { readonly: true, fileMustExist: true })
        try {
          srcDb.prepare('VACUUM INTO ?').run(temporaryDb)
        } finally {
          srcDb.close()
        }
      }
      const snap = new Database(temporaryDb, { readonly: true, fileMustExist: true })
      let rows
      try {
        rows = selectArtifactRows(snap)
      } finally {
        snap.close()
      }
      if (rows.length > 0 && !artifactsRoot && !memoryArtifacts) {
        throw new Error('BACKUP_ARTIFACTS_UNAVAILABLE')
      }
      if (artifactsRoot && (rows.length > 0 || existsSync(artifactsRoot))) {
        stageVerifiedArtifacts(artifactsRoot, temporaryArt, rows)
        writeFileSync(join(temporaryArt, BACKUP_MARKER), JSON.stringify({ storeId, date }), { flag: 'wx', mode: 0o600 })
        stagedArt = true
      } else if (memoryArtifacts && rows.length > 0) {
        stageVerifiedMemoryArtifacts(memoryArtifacts, temporaryArt, rows)
        writeFileSync(join(temporaryArt, BACKUP_MARKER), JSON.stringify({ storeId, date }), { flag: 'wx', mode: 0o600 })
        stagedArt = true
      }
      if (stagedArt) renameSync(temporaryArt, artTarget)
      try {
        renameSync(temporaryDb, target)
      } catch (err) {
        if (stagedArt) rmSync(artTarget, { recursive: true, force: true })
        throw err
      }
    } finally {
      rmSync(temporaryDb, { force: true })
      rmSync(temporaryArt, { recursive: true, force: true })
    }
  }

  const inspectOwnedBackup = (filePath, artDir) => {
    const st = lstatSync(filePath, { throwIfNoEntry: false })
    if (!st || st.isSymbolicLink() || !st.isFile()) return 'foreign'
    let isSqlite = false
    try {
      const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const hdr = Buffer.alloc(16)
        const n = readSync(fd, hdr, 0, 16, 0)
        isSqlite = n === 16 && hdr.toString('utf8') === 'SQLite format 3\0'
      } finally {
        closeSync(fd)
      }
    } catch {
      return 'foreign'
    }
    if (!isSqlite) return 'foreign'
    let snap
    let rows = []
    try {
      snap = new Database(filePath, { readonly: true, fileMustExist: true })
      const existingStoreId = snap.prepare("SELECT value FROM meta WHERE key='artifacts_store_id'").pluck().get() ?? null
      if (existingStoreId !== storeId) return 'foreign'
      rows = selectArtifactRows(snap)
    } catch {
      return 'foreign'
    } finally {
      snap?.close()
    }
    if (rows.length === 0 && !existsSync(artDir)) return 'complete'
    return verifyBackupArtifactOwnership(artDir, storeId, rows) ? 'complete' : 'incomplete'
  }

  const dbPattern = new RegExp(`^${escapeRe(dbPrefix)}-(\\d{4}-\\d{2}-\\d{2})\\.sqlite$`)
  const completeDates = []
  const incompleteDates = []
  for (const file of readdirSync(directory)) {
    const m = dbPattern.exec(file)
    if (!m) continue
    const d = m[1]
    const state = inspectOwnedBackup(join(directory, file), join(directory, `${artPrefix}-${d}`))
    if (state === 'complete') completeDates.push(d)
    else if (state === 'incomplete') incompleteDates.push(d)
  }
  completeDates.sort()
  const retainedDates = new Set(completeDates.slice(-7))
  const oldestRetained = completeDates.length >= 7 ? completeDates[completeDates.length - 7] : undefined
  for (const oldDate of completeDates.slice(0, -7)) {
    rmSync(join(directory, `${dbPrefix}-${oldDate}.sqlite`))
    const artDir = join(directory, `${artPrefix}-${oldDate}`)
    if (isExclusivelyOwnedByStore(artDir, storeId)) rmSync(artDir, { recursive: true, force: true })
  }
  const preservedIncomplete = new Set()
  for (const incDate of incompleteDates) {
    if (oldestRetained !== undefined && incDate < oldestRetained) {
      rmSync(join(directory, `${dbPrefix}-${incDate}.sqlite`))
      const artDir = join(directory, `${artPrefix}-${incDate}`)
      if (isExclusivelyOwnedByStore(artDir, storeId)) rmSync(artDir, { recursive: true, force: true })
    } else {
      preservedIncomplete.add(incDate)
    }
  }
  const artPattern = new RegExp(`^${escapeRe(artPrefix)}-(\\d{4}-\\d{2}-\\d{2})$`)
  for (const dirName of readdirSync(directory)) {
    const m = artPattern.exec(dirName)
    if (!m) continue
    const artDate = m[1]
    if (!retainedDates.has(artDate) && !preservedIncomplete.has(artDate) && artDate !== date &&
        isExclusivelyOwnedByStore(join(directory, dirName), storeId)) {
      rmSync(join(directory, dirName), { recursive: true, force: true })
    }
  }
}

try {
  runBackup(workerData)
  parentPort?.postMessage({ ok: true })
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
}
