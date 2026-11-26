import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { eq, asc, inArray } from 'drizzle-orm'
import { ulid } from '@agent-hub/common'
import type { RunArtifactView } from '@agent-hub/protocol'
import type { Repos } from '../../services/store.js'
import { runArtifacts } from './schema.js'

export type ArtifactKind = 'visual_before' | 'visual_after' | 'inbound_image' | 'inbound_audio' | 'inbound_file'
export type ArtifactRow = typeof runArtifacts.$inferSelect

const safeExt = (mimeType: string) => {
  if (mimeType === 'image/png') return 'png'
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'audio/ogg' || mimeType === 'audio/opus') return 'ogg'
  if (mimeType === 'audio/mpeg') return 'mp3'
  if (mimeType === 'audio/wav') return 'wav'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return 'txt'
  return 'bin'
}

const OWNER_FILE = '.agent-hub-owner.json'
const BACKUP_MARKER_FILE = '.agent-hub-backup.json'

export class ArtifactStore {
  readonly root: string | null
  private realRoot: string | null = null
  private owned = false
  private readonly memory = new Map<string, Buffer>()
  constructor(dbPath: string, private readonly reposFn: () => Repos, private readonly storeId = 'default') {
    if (dbPath === ':memory:') {
      this.root = null
    } else {
      const absDb = resolve(dbPath)
      const base = basename(absDb)
      const dirName = base.toLowerCase() === 'hub.sqlite' ? 'artifacts' : `${base}.artifacts`
      this.root = resolve(dirname(absDb), dirName)
      const before = lstatSync(this.root, { throwIfNoEntry: false })
      if (before && (before.isSymbolicLink() || !before.isDirectory())) {
        throw new Error('UNSAFE_ARTIFACT_ROOT')
      }
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const after = lstatSync(this.root)
      if (after.isSymbolicLink() || !after.isDirectory()) throw new Error('UNSAFE_ARTIFACT_ROOT')
      const realParent = realpathSync.native(dirname(this.root))
      const real = realpathSync.native(this.root)
      if (real !== resolve(realParent, basename(this.root))) throw new Error('UNSAFE_ARTIFACT_ROOT')
      this.realRoot = real
      this.initOwnership()
    }
  }

  private readOwnershipMarker(): string | 'INVALID' | null {
    if (!this.realRoot) return null
    const markerPath = join(this.realRoot, OWNER_FILE)
    const lst = lstatSync(markerPath, { throwIfNoEntry: false })
    if (!lst) return null
    if (lst.isSymbolicLink() || !lst.isFile()) return 'INVALID'
    try {
      const fd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1 || st.size > 4096) return 'INVALID'
        const parsed = JSON.parse(readFileSync(fd, 'utf8')) as { storeId?: unknown }
        return typeof parsed.storeId === 'string' && parsed.storeId ? parsed.storeId : 'INVALID'
      } finally {
        closeSync(fd)
      }
    } catch {
      return 'INVALID'
    }
  }

  private readBackupMarkerStoreId(): string | 'INVALID' | null {
    if (!this.realRoot) return null
    const markerPath = join(this.realRoot, BACKUP_MARKER_FILE)
    const lst = lstatSync(markerPath, { throwIfNoEntry: false })
    if (!lst) return null
    if (lst.isSymbolicLink() || !lst.isFile()) return 'INVALID'
    try {
      const fd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1 || st.size > 4096) return 'INVALID'
        const parsed = JSON.parse(readFileSync(fd, 'utf8')) as { storeId?: unknown }
        return typeof parsed.storeId === 'string' && parsed.storeId ? parsed.storeId : 'INVALID'
      } finally {
        closeSync(fd)
      }
    } catch {
      return 'INVALID'
    }
  }

  private initOwnership() {
    if (!this.realRoot) return
    const existing = this.readOwnershipMarker()
    if (existing !== null) {
      this.owned = existing === this.storeId
      return
    }
    const backupOwner = this.readBackupMarkerStoreId()
    if (backupOwner !== null && backupOwner !== this.storeId) {
      this.owned = false
      return
    }
    try {
      const entries = readdirSync(this.realRoot, { withFileTypes: true }).filter(e =>
        e.name !== OWNER_FILE && !(backupOwner === this.storeId && e.name === BACKUP_MARKER_FILE))
      let allKnown = true
      if (entries.length) {
        const db = this.reposFn()
        for (const taskEntry of entries) {
          if (taskEntry.isSymbolicLink() || !taskEntry.isDirectory() || !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(taskEntry.name)) {
            allKnown = false
            break
          }
          const files = readdirSync(join(this.realRoot, taskEntry.name), { withFileTypes: true })
          for (const f of files) {
            const match = /^(art_[0-9A-HJKMNP-TV-Z]{26})\.[a-z0-9]+$/u.exec(f.name)
            if (f.isSymbolicLink() || !f.isFile() || !match) { allKnown = false; break }
            const row = db.select({ id: runArtifacts.id, taskId: runArtifacts.taskId }).from(runArtifacts).where(eq(runArtifacts.id, match[1]!)).get()
            if (!row || row.taskId !== taskEntry.name) { allKnown = false; break }
          }
          if (!allKnown) break
        }
      }
      if (!allKnown) {
        this.owned = false
        return
      }
      const markerPath = join(this.realRoot, OWNER_FILE)
      writeFileSync(markerPath, JSON.stringify({ storeId: this.storeId }), { flag: 'wx', mode: 0o600 })
      this.owned = this.readOwnershipMarker() === this.storeId
      if (this.owned && backupOwner === this.storeId) {
        rmSync(join(this.realRoot, BACKUP_MARKER_FILE), { force: true })
      }
    } catch {
      this.owned = this.readOwnershipMarker() === this.storeId
    }
  }

  private safePath(rel: string): { abs: string; parent: string } {
    if (!this.root || !this.realRoot || !rel || rel.includes('\0') || isAbsolute(rel)) throw new Error('INVALID_ARTIFACT_PATH')
    const abs = resolve(this.realRoot, rel)
    const relCheck = relative(this.realRoot, abs)
    if (!relCheck || relCheck.startsWith('..') || isAbsolute(relCheck)) throw new Error('ARTIFACT_PATH_ESCAPE')
    return { abs, parent: dirname(abs) }
  }

  private assertSafeParent(parent: string) {
    if (!this.realRoot) return
    const st = lstatSync(parent, { throwIfNoEntry: false })
    if (!st) return
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('UNSAFE_ARTIFACT_DIR')
    const realParent = realpathSync.native(parent)
    const rel = relative(this.realRoot, realParent)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('ARTIFACT_PATH_ESCAPE')
  }

  save(input: {
    taskId: string
    runId?: string | null
    kind: ArtifactKind
    label: string
    mimeType: string
    data: Buffer
    meta?: unknown
    now: number
    repos?: Repos
  }): ArtifactRow {
    const id = 'art_' + ulid(input.now)
    const sha256 = createHash('sha256').update(input.data).digest('hex')
    const rel = input.taskId + '/' + id + '.' + safeExt(input.mimeType)
    let writtenAbs: string | undefined
    if (this.root) {
      if (!this.owned || this.readOwnershipMarker() !== this.storeId) {
        throw new Error('ARTIFACT_STORE_OWNERSHIP_MISMATCH')
      }
      const { abs, parent } = this.safePath(rel)
      this.assertSafeParent(parent)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      this.assertSafeParent(parent)
      const tmp = abs + '.tmp-' + randomUUID()
      writeFileSync(tmp, input.data, { flag: 'wx', mode: 0o600 })
      try {
        renameSync(tmp, abs)
      } catch (err) {
        rmSync(tmp, { force: true })
        throw err
      }
      writtenAbs = abs
    } else {
      this.memory.set(id, Buffer.from(input.data))
    }
    const row: typeof runArtifacts.$inferInsert = {
      id,
      taskId: input.taskId,
      runId: input.runId ?? null,
      kind: input.kind,
      label: input.label.slice(0, 200),
      mimeType: input.mimeType,
      bytes: input.data.length,
      sha256,
      storageRelPath: rel,
      metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
      createdAt: input.now,
    }
    const db = input.repos ?? this.reposFn()
    try {
      db.insert(runArtifacts).values(row).run()
    } catch (err) {
      if (writtenAbs) rmSync(writtenAbs, { force: true })
      else this.memory.delete(id)
      throw err
    }
    return row as ArtifactRow
  }

  get(id: string, db = this.reposFn()): ArtifactRow | undefined {
    return db.select().from(runArtifacts).where(eq(runArtifacts.id, id)).get()
  }

  listForRun(runId: string, db = this.reposFn()): ArtifactRow[] {
    return db.select().from(runArtifacts).where(eq(runArtifacts.runId, runId)).orderBy(asc(runArtifacts.createdAt)).all()
  }

  listForTask(taskId: string, db = this.reposFn()): ArtifactRow[] {
    return db.select().from(runArtifacts).where(eq(runArtifacts.taskId, taskId)).orderBy(asc(runArtifacts.createdAt)).all()
  }

  readBytes(row: ArtifactRow): Buffer | undefined {
    if (!this.root) {
      const mem = this.memory.get(row.id)
      if (!mem) return undefined
      if (mem.length !== row.bytes || createHash('sha256').update(mem).digest('hex') !== row.sha256) return undefined
      return mem
    }
    try {
      const { abs, parent } = this.safePath(row.storageRelPath)
      this.assertSafeParent(parent)
      const lst = lstatSync(abs, { throwIfNoEntry: false })
      if (!lst || lst.isSymbolicLink() || !lst.isFile()) return undefined
      const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.nlink !== 1 || st.size !== row.bytes) return undefined
        const buf = readFileSync(fd)
        if (buf.length !== row.bytes || createHash('sha256').update(buf).digest('hex') !== row.sha256) return undefined
        return buf
      } finally {
        closeSync(fd)
      }
    } catch {
      return undefined
    }
  }

  unlink(row: Pick<ArtifactRow, 'id' | 'storageRelPath'>) {
    if (!this.root) {
      this.memory.delete(row.id)
      return
    }
    if (!this.owned || this.readOwnershipMarker() !== this.storeId) return
    try {
      const { abs, parent } = this.safePath(row.storageRelPath)
      this.assertSafeParent(parent)
      rmSync(abs, { force: true })
    } catch { /* Ignore unsafe or missing artifact paths on cleanup */ }
  }

  reconcile(db = this.reposFn()) {
    if (!this.realRoot || !this.owned || this.readOwnershipMarker() !== this.storeId) return 0
    let removed = 0
    try {
      for (const taskDir of readdirSync(this.realRoot, { withFileTypes: true })) {
        if (!taskDir.isDirectory() || taskDir.isSymbolicLink() || !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(taskDir.name)) continue
        const dirPath = join(this.realRoot, taskDir.name)
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          const filePath = join(dirPath, entry.name)
          const st = lstatSync(filePath, { throwIfNoEntry: false })
          if (!st || st.isSymbolicLink() || !st.isFile()) continue
          const match = /^(art_[0-9A-HJKMNP-TV-Z]{26})\.[a-z0-9]+(\.tmp-[0-9a-f-]+)?$/u.exec(entry.name)
          if (!match) continue
          if (match[2]) {
            rmSync(filePath, { force: true })
            removed++
            continue
          }
          const artId = match[1]!
          const row = db.select({ id: runArtifacts.id, taskId: runArtifacts.taskId }).from(runArtifacts).where(eq(runArtifacts.id, artId)).get()
          if (!row || row.taskId !== taskDir.name) {
            rmSync(filePath, { force: true })
            removed++
          }
        }
      }
    } catch { /* Ignore directory scan errors during startup/cleanup */ }
    return removed
  }

  async reconcileAsync(db = this.reposFn(), opts: { batchFiles?: number } = {}): Promise<number> {
    if (!this.realRoot || !this.owned || this.readOwnershipMarker() !== this.storeId) return 0
    const batchFiles = Math.max(1, opts.batchFiles ?? 50)
    let removed = 0
    try {
      const taskDirs = await readdir(this.realRoot, { withFileTypes: true })
      const queue: Array<{ taskName: string; filePath: string; artId?: string; isTmp: boolean }> = []
      const flushBatch = () => {
        if (!queue.length) return
        if (!this.owned || this.readOwnershipMarker() !== this.storeId) {
          queue.length = 0
          return
        }
        const artIds = [...new Set(queue.flatMap(item => (item.artId ? [item.artId] : [])))]
        const existingById = new Map<string, string>()
        if (artIds.length) {
          for (const row of db.select({ id: runArtifacts.id, taskId: runArtifacts.taskId }).from(runArtifacts).where(inArray(runArtifacts.id, artIds)).all()) {
            existingById.set(row.id, row.taskId)
          }
        }
        for (const item of queue.splice(0)) {
          const st = lstatSync(item.filePath, { throwIfNoEntry: false })
          if (!st || st.isSymbolicLink() || !st.isFile()) continue
          if (item.isTmp) {
            rmSync(item.filePath, { force: true })
            removed++
            continue
          }
          if (item.artId && existingById.get(item.artId) !== item.taskName) {
            rmSync(item.filePath, { force: true })
            removed++
          }
        }
      }
      for (const taskDir of taskDirs) {
        if (!taskDir.isDirectory() || taskDir.isSymbolicLink() || !/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u.test(taskDir.name)) continue
        const dirPath = join(this.realRoot, taskDir.name)
        const entries = await readdir(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          const filePath = join(dirPath, entry.name)
          const st = await lstat(filePath).catch(() => undefined)
          if (!st || st.isSymbolicLink() || !st.isFile()) continue
          const match = /^(art_[0-9A-HJKMNP-TV-Z]{26})\.[a-z0-9]+(\.tmp-[0-9a-f-]+)?$/u.exec(entry.name)
          if (!match) continue
          queue.push({ taskName: taskDir.name, filePath, isTmp: Boolean(match[2]), ...(match[1] && !match[2] && { artId: match[1] }) })
          if (queue.length >= batchFiles) {
            flushBatch()
            await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate))
          }
        }
      }
      flushBatch()
    } catch { /* Ignore directory scan errors during startup/cleanup */ }
    return removed
  }

  toView(row: ArtifactRow): RunArtifactView {
    return {
      id: row.id,
      taskId: row.taskId,
      runId: row.runId,
      kind: row.kind,
      label: row.label,
      mimeType: row.mimeType,
      bytes: row.bytes,
      sha256: row.sha256,
      meta: row.metaJson ? (JSON.parse(row.metaJson) as RunArtifactView['meta']) : null,
      createdAt: row.createdAt,
      url: '/api/v1/artifacts/' + row.id,
    }
  }
}
