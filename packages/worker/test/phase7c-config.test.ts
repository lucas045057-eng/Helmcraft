import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { acquireWorkerLock, WorkerAlreadyRunning } from '../src/runner/lock.js'
import { resolveWorkspaces } from '../src/config/load.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

it('F10 marks a workspace nested in Worker state as configExposed', () => {
  const base = mkdtempSync(join(tmpdir(), 'state-root-'))
  try {
    const path = join(base, 'worker-state', 'state', 'workspace')
    mkdirSync(path, { recursive: true })
    const config = WorkerConfigSchema.parse({ workerId: 'worker', hub: { url: 'ws://localhost' },
      workspaces: [{ id: 'repo', label: 'repo', allowedAdapters: ['mock'], path, maxProfile: 'edit' }] })
    expect(resolveWorkspaces(config, join(base, 'worker.yaml'), join(base, 'worker-state')).workspaces[0]?.configExposed).toBe(true)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

it('F12 recovers abandoned acquisition guards and respects a fresh guard', () => {
  const base = mkdtempSync(join(tmpdir(), 'acquire-'))
  try {
    const path = join(base, 'worker.lock'), guard = path + '.acquire'
    writeFileSync(guard, JSON.stringify({ pid: process.pid }))
    expect(() => acquireWorkerLock(path)).toThrow(WorkerAlreadyRunning)
    writeFileSync(guard, JSON.stringify({ pid: 2147483647, started: 'dead' }))
    acquireWorkerLock(path)()
    writeFileSync(guard, '')
    expect(() => acquireWorkerLock(path)).toThrow(WorkerAlreadyRunning)
    const stale = new Date(Date.now() - 31000)
    utimesSync(guard, stale, stale)
    acquireWorkerLock(path)()
    writeFileSync(guard, JSON.stringify({ pid: process.pid }))
    utimesSync(guard, stale, stale)
    acquireWorkerLock(path)()
  } finally { rmSync(base, { recursive: true, force: true }) }
})
