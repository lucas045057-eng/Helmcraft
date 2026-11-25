import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { processAlive, processStartTime } from './process-identity.js'

export class WorkerAlreadyRunning extends Error {}
function isOwnerAlive(owner: { pid: number; started?: string }) {
  if (!processAlive(owner.pid)) return false
  const started = owner.started && processStartTime(owner.pid)
  return !started || started === owner.started
}
function guardState(path: string): 'held' | 'stale' | 'absent' {
  try {
    const content = readFileSync(path, 'utf8')
    try {
      const owner = JSON.parse(content)
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        if (!processAlive(owner.pid)) return 'stale'
        const started = owner.started && processStartTime(owner.pid)
        if (started) return started === owner.started ? 'held' : 'stale'
      }
    } catch { /* A crash can leave an empty or partially written guard. */ }
    return Date.now() - statSync(path).mtimeMs > 30000 ? 'stale' : 'held'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

function openGuard(path: string, identity: string): number {
  const open = () => openSync(path, 'wx', 0o600)
  let fd: number
  try { fd = open() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (guardState(path) === 'held') throw new WorkerAlreadyRunning('Worker lock acquisition is in progress')
    // Serialize stale removers so a late contender cannot unlink the replacement.
    const recovery = path + '.reap'
    const claim = openGuard(recovery, identity)
    try {
      const state = guardState(path)
      if (state === 'held') throw new WorkerAlreadyRunning('Worker lock acquisition is in progress')
      if (state === 'stale') rmSync(path)
      try { fd = open() } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkerAlreadyRunning('Worker lock acquisition is in progress')
        throw retryError
      }
    } finally { closeSync(claim); rmSync(recovery) }
  }
  try { writeFileSync(fd, identity); return fd }
  catch (error) { closeSync(fd); rmSync(path); throw error }
}

export function acquireWorkerLock(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const guard = path + '.acquire'
  const identity = JSON.stringify({ pid: process.pid, started: processStartTime(process.pid) })
  const lock = openGuard(guard, identity)
  try {
    let previous: string | undefined
    try { previous = readFileSync(path, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (previous !== undefined) {
      const current = JSON.parse(previous) as { pid: number; started?: string }
      if (isOwnerAlive(current)) {
        throw new WorkerAlreadyRunning('A Worker is already running')
      }
      rmSync(path)
    }
    writeFileSync(path, identity, { flag: 'wx', mode: 0o600, flush: true })
  } finally { closeSync(lock); rmSync(guard) }
  return () => { if (readFileSync(path, 'utf8') === identity) rmSync(path) }
}
