import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { expect, it } from 'vitest'
import { Journal } from '../src/runner/journal.js'
import { acquireWorkerLock, WorkerAlreadyRunning } from '../src/runner/lock.js'

it('rebuilds a restart terminal marker after the last journaled send', async () => {
  const base = mkdtempSync(join(tmpdir(), 'worker-journal-'))
  try {
    const path = join(base, 'state', 'journal.jsonl'), clock = new FakeClock(1000)
    const id = runId(1000)
    const journal = new Journal(path, clock)
    journal.accepted({ runId: id, taskId: taskId(1000), workspaceId: 'sandbox' })
    journal.progress(id, 31)
    const restarted = new Journal(path, clock)
    expect(await restarted.recover()).toEqual([expect.objectContaining({
      runId: id, finished: expect.objectContaining({ seq: 32, status: 'failed', errorCode: 'WORKER_RESTARTED' }),
    })])
    restarted.acked(id)
    expect(await new Journal(path, clock).recover()).toEqual([])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

it('retains the active instance lock and releases it at shutdown', () => {
  const base = mkdtempSync(join(tmpdir(), 'worker-lock-'))
  try {
    const path = join(base, 'worker.lock')
    const release = acquireWorkerLock(path)
    expect(() => acquireWorkerLock(path)).toThrow(WorkerAlreadyRunning)
    release()
    acquireWorkerLock(path)()
  } finally { rmSync(base, { recursive: true, force: true }) }
}, 10_000)
