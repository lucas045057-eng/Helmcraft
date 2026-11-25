import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRedactor } from '@agent-hub/common'
import { BOARD_DIR, BOARD_FILES, BOARD_HARD_CAP_BYTES, BoardFileName, lintBoardFile } from '@agent-hub/protocol'
import type { BoardUnsafeReason, BoardFileSnapshot, BoardSnapshot } from '@agent-hub/protocol'
import type { BigIntStats } from 'node:fs'

const nativeFs = { lstat, open, realpath }
type ReaderFs = typeof nativeFs
class Unsafe extends Error {
  constructor(readonly reason: BoardUnsafeReason) { super(reason) }
}
function reason(error: unknown): BoardUnsafeReason {
  if (error instanceof Unsafe) return error.reason
  return (error as NodeJS.ErrnoException)?.code === 'ELOOP' ? 'LINK' : 'IO_ERROR'
}
function absent(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function afterLookup(error: unknown): never {
  if (absent(error) || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') throw new Unsafe('RACE')
  throw error
}
function same(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino }
async function checkPath(path: string, fs: ReaderFs) {
  const actual = await fs.realpath(path).catch(afterLookup)
  if ((process.platform === 'win32' ? actual.toLowerCase() !== path.toLowerCase() : actual !== path)) throw new Unsafe('ESCAPES_ROOT')
}
export async function checkBoardDir(root: string, fs = nativeFs) {
  const path = resolve(root, BOARD_DIR)
  try {
    const stat = await fs.lstat(path, { bigint: true })
    if (stat.isSymbolicLink()) throw new Unsafe('LINK')
    if (!stat.isDirectory()) throw new Unsafe('NOT_DIR')
    await checkPath(path, fs)
    return { dir: 'present' as const, stat }
  } catch (error) {
    return absent(error) ? { dir: 'absent' as const } : { dir: 'unsafe' as const, dirReason: reason(error) }
  }
}
async function readFileChecked(path: string, cap: number, mode: 'content' | 'digest', fs: ReaderFs) {
  const before = await fs.lstat(path, { bigint: true })
  if (before.isSymbolicLink()) throw new Unsafe('LINK')
  if (!before.isFile()) throw new Unsafe('NOT_FILE')
  if (before.nlink > 1n) throw new Unsafe('HARDLINK')
  await checkPath(path, fs)
  const fd = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(afterLookup)
  try {
    const stat = await fd.stat({ bigint: true })
    if (!same(before, stat) || !stat.isFile() || stat.nlink !== 1n) throw new Unsafe('RACE')
    await checkPath(path, fs)
    const bytes = Number(stat.size)
    let raw: Buffer | undefined
    let digest: string | undefined
    if (mode === 'content' || bytes <= cap) {
      const size = Math.min(bytes, cap)
      const hash = mode === 'digest' ? createHash('sha256') : undefined
      // AGENTS.md is streamed into a digest. Only board files retain a content buffer.
      const buffer = Buffer.alloc(hash ? Math.min(size, 8192) : size)
      let offset = 0
      while (offset < size) {
        const start = hash ? 0 : offset
        const { bytesRead } = await fd.read(buffer, start, Math.min(buffer.length - start, size - offset), offset)
        if (bytesRead === 0) throw new Unsafe('RACE')
        hash?.update(buffer.subarray(start, start + bytesRead))
        offset += bytesRead
      }
      if (hash) digest = hash.digest('hex')
      else raw = buffer
    }
    const final = await fs.lstat(path, { bigint: true }).catch(() => { throw new Unsafe('RACE') })
    if (!same(stat, final) || final.nlink !== 1n || final.ctimeNs !== stat.ctimeNs || final.size !== stat.size) throw new Unsafe('RACE')
    return { bytes, raw, digest }
  } finally { await fd.close() }
}
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex')
export async function readAgentsMd(root: string, fs = nativeFs): Promise<BoardSnapshot['agentsMd']> {
  try {
    const { bytes, digest } = await readFileChecked(resolve(root, 'AGENTS.md'), 256 * 1024, 'digest', fs)
    return { status: 'present', bytes, ...(digest && { sha256: digest }) }
  } catch (error) { return { status: absent(error) ? 'absent' : 'unsafe', bytes: 0 } }
}
function empty(file: BoardFileName, status: BoardFileSnapshot['status'], cause?: BoardUnsafeReason): BoardFileSnapshot {
  return { file, status, bytes: 0, lines: 0, overBudget: false, schemaOk: false, ...(cause && { reason: cause }) }
}
export async function readBoard(root: string, knownSecrets: Record<string, string> = {}, patterns: string[] = [],
  fs = nativeFs): Promise<BoardSnapshot> {
  const agentsMd = await readAgentsMd(root, fs)
  const { dir, dirReason, stat } = await checkBoardDir(root, fs)
  const capturedAt = Date.now()
  const unavailable = (status: 'absent' | 'unsafe', cause?: BoardUnsafeReason): BoardSnapshot => ({
    dir: status, ...(cause && { dirReason: cause }), capturedAt, agentsMd,
    files: BoardFileName.options.map(file => empty(file, status, cause)),
  })
  if (dir !== 'present') return unavailable(dir, dirReason)
  const files: BoardFileSnapshot[] = []
  for (const file of BoardFileName.options) {
    try {
      const { raw, bytes } = await readFileChecked(resolve(root, BOARD_DIR, file), BOARD_HARD_CAP_BYTES, 'content', fs)
      if (!raw || raw.includes(0)) { files.push({ ...empty(file, 'invalid', 'BINARY'), bytes }); continue }
      const truncated = bytes > BOARD_HARD_CAP_BYTES
      const buffer = truncated ? raw.subarray(0, raw.lastIndexOf(10) + 1) : raw
      const text = new TextDecoder().decode(buffer)
      const redact = createRedactor(knownSecrets, patterns)
      const redacted = Buffer.from(text.split('\n').map(line => redact(line)).join('\n'))
      // Replacement markers and malformed UTF-8 can expand the decoded byte length.
      const prefix = redacted.subarray(0, BOARD_HARD_CAP_BYTES)
      const content = redacted.length <= BOARD_HARD_CAP_BYTES ? redacted.toString('utf8')
        : prefix.subarray(0, prefix.lastIndexOf(10) + 1).toString('utf8')
      const lint = lintBoardFile(file, text)
      const budget = BOARD_FILES[file]
      files.push({ file, status: truncated ? 'oversize' : 'present', bytes, ...lint, sha256: sha(buffer),
        overBudget: bytes > budget.budgetBytes || lint.lines > budget.budgetLines, ...((truncated || redacted.length > BOARD_HARD_CAP_BYTES) && { truncated: true }),
        content })
    } catch (error) { files.push(absent(error) ? empty(file, 'absent') : empty(file, 'unsafe', reason(error))) }
  }
  const final = await checkBoardDir(root, fs)
  if (!final.stat || !same(stat, final.stat)) return unavailable('unsafe', 'RACE')
  return { dir, files, agentsMd, capturedAt }
}
