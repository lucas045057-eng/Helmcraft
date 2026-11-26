import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isBoardPath } from '@agent-hub/protocol'
import type { ManifestChange, ManifestDiffSummary, ManifestSummary, TamperInfo } from '@agent-hub/protocol'
import type { Workspace } from '../config/schema.js'
import { withinWorkspace } from '../security/workspace.js'
import { compileGlob, manifestKey } from './glob.js'

const excluded = new Set('.git node_modules .pnpm-store dist build out coverage .next .nuxt .turbo .cache .venv venv __pycache__ target .idea .vs'.split(' '))
type Entry = { path: string; size: number; mtimeMs: number; sha256?: string; target?: string; linkIdentity?: string }
export interface Manifest { summary: ManifestSummary; entries: Map<string, Entry> }
export async function scanManifest(
  root: string,
  config: Workspace['harness']['manifest'],
  sensitive: (path: string) => boolean,
  pinnedPaths: readonly string[] = [],
  unbaselined = false,
): Promise<Manifest> {
  const start = performance.now()
  const entries = new Map<string, Entry>()
  const summary = { files: 0, bytes: 0, hashed: 0, links: 0, truncated: unbaselined, durationMs: 0 }
  const ignores = config.exclude.map(p => compileGlob(p))
  const hashRegularFile = async (full: string, stat: Awaited<ReturnType<typeof lstat>>, entry: Entry): Promise<boolean> => {
    const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const initial = await handle.stat({ bigint: true })
      if (initial.ino !== stat.ino || initial.dev !== stat.dev || !initial.isFile() || initial.size !== stat.size ||
          manifestKey(await realpath(full)) !== manifestKey(full)) { summary.truncated = true; return false }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(Math.min(65536, entry.size))
      let bytes = 0
      while (bytes < entry.size) {
        if (performance.now() - start > config.maxScanMs) { summary.truncated = true; return false }
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, entry.size - bytes), bytes)
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        bytes += bytesRead
      }
      if (bytes !== entry.size || (await handle.stat({ bigint: true })).ctimeNs !== initial.ctimeNs) { summary.truncated = true; return false }
      entry.sha256 = hash.digest('hex')
      summary.hashed++
      return true
    } finally { await handle.close() }
  }
  const dirs = ['']
  try {
    scan: while (dirs.length) {
      if (performance.now() - start > config.maxScanMs) { summary.truncated = true; break }
      const dir = dirs.pop()!
      const absolute = join(root, dir)
      if (manifestKey(await realpath(absolute)) !== manifestKey(absolute)) { summary.truncated = true; break }
      for (const item of await readdir(absolute, { withFileTypes: true })) {
        if (performance.now() - start > config.maxScanMs) { summary.truncated = true; break scan }
        const path = dir ? dir + '/' + item.name : item.name
        if (ignores.some(re => re.test(path) || (item.isDirectory() && re.test(path + '/')))) continue
        if (item.isDirectory() && excluded.has(manifestKey(item.name))) continue
        const full = join(root, path)
        const stat = await lstat(full, { bigint: true })
        if (stat.isDirectory()) { dirs.push(path); continue }
        if (!stat.isFile() && !stat.isSymbolicLink()) continue
        if (entries.size >= config.maxFiles || path.length > 512) { summary.truncated = true; break scan }
        const entry: Entry = { path, size: Number(stat.size), mtimeMs: Number(stat.mtimeNs) / 1e6 }
        if (stat.isSymbolicLink()) {
          const target = resolve(dirname(full), await readlink(full))
          entry.target = withinWorkspace(root, target) ? relative(root, target).split(sep).join('/') : 'OUTSIDE'
          entry.linkIdentity = createHash('sha256').update(manifestKey(target)).digest('hex')
          summary.links++
        } else {
          if (entry.size <= 8 * 1024 * 1024 && sensitive(path)) {
            if (!(await hashRegularFile(full, stat, entry))) break scan
          }
          summary.files++
          summary.bytes += entry.size
        }
        entries.set(manifestKey(path), entry)
      }
    }
  } catch { summary.truncated = true }
  for (const rel of pinnedPaths) {
    const key = manifestKey(rel)
    const existing = entries.get(key)
    if (existing) {
      if (existing.target === undefined && !existing.sha256) {
        summary.truncated = true
      }
      continue
    }
    const full = resolve(root, rel)
    if (!withinWorkspace(root, full) || rel.length > 512) { summary.truncated = true; continue }
    try {
      const parentDir = dirname(full)
      const parentStat = await lstat(parentDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
        throw e
      })
      if (parentStat === null) continue
      if (manifestKey(await realpath(parentDir)) !== manifestKey(parentDir)) { summary.truncated = true; continue }
      const stat = await lstat(full, { bigint: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
        throw e
      })
      if (stat === null) continue
      if (stat.isSymbolicLink()) {
        if (entries.size >= config.maxFiles) { summary.truncated = true; continue }
        const target = resolve(dirname(full), await readlink(full))
        entries.set(key, {
          path: rel,
          size: Number(stat.size),
          mtimeMs: Number(stat.mtimeNs) / 1e6,
          target: withinWorkspace(root, target) ? relative(root, target).split(sep).join('/') : 'OUTSIDE',
          linkIdentity: createHash('sha256').update(manifestKey(target)).digest('hex'),
        })
        summary.links++
        continue
      }
      if (!stat.isFile() || entries.size >= config.maxFiles || Number(stat.size) > 8 * 1024 * 1024) {
        summary.truncated = true
        continue
      }
      const entry: Entry = { path: rel, size: Number(stat.size), mtimeMs: Number(stat.mtimeNs) / 1e6 }
      if (!(await hashRegularFile(full, stat, entry))) continue
      summary.files++
      summary.bytes += entry.size
      entries.set(key, entry)
    } catch { summary.truncated = true }
  }
  summary.durationMs = Math.floor(performance.now() - start)
  summary.truncated ||= summary.durationMs > config.maxScanMs
  return { entries, summary }
}
export function diffManifest(pre: Manifest, post: Manifest, sensitive: (path: string) => boolean) {
  const changes: ManifestDiffSummary = { total: 0, added: 0, modified: 0, deleted: 0, links: 0, boardOnly: true, sample: [],
    truncated: pre.summary.truncated || post.summary.truncated }
  const tamper: TamperInfo = { total: 0, paths: [], links: 0 }
  for (const key of [...new Set([...pre.entries.keys(), ...post.entries.keys()])].sort()) {
    const a = pre.entries.get(key), b = post.entries.get(key)
    const path = (b ?? a)!.path
    let change: ManifestChange
    if (a?.linkIdentity !== b?.linkIdentity) change = 'link'
    else if (!a) change = 'added'
    else if (!b) change = 'deleted'
    else if (a.target === undefined && (a.sha256 && b.sha256 ? a.sha256 !== b.sha256 : a.size !== b.size || a.mtimeMs !== b.mtimeMs)) change = 'modified'
    else continue
    changes[change === 'link' ? 'links' : change]++
    changes.total++
    changes.boardOnly &&= isBoardPath(key)
    if (changes.sample.length < 200) changes.sample.push({ path, change })
    if (change === 'link' || sensitive(path)) {
      tamper.total++
      if (change === 'link') tamper.links++
      if (tamper.paths.length < 50) tamper.paths.push(path)
    }
  }
  return { changes, ...(tamper.total && { tamper }) }
}
