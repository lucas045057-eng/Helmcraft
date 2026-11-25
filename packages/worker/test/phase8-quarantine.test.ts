import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { RunDispatch, RunEvent } from '@agent-hub/protocol'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import * as verification from '../src/harness/verify-runner.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'

let base: string, repo: string, state: string
let clock: FakeClock
const managers: RunManager[] = []
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'verify-quarantine-'))
  repo = join(base, 'repo')
  state = join(base, 'state', 'journal')
  mkdirSync(repo)
  mkdirSync(join(base, 'other'))
  clock = new FakeClock(1000)
})
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.cancelAll(); await manager.awaitRuns() }
  vi.restoreAllMocks()
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
})

async function worker(journal = new Journal(state, clock)) {
  const cfg = WorkerConfigSchema.parse({
    workerId: 'worker', hub: { url: 'ws://localhost:9999' }, adapters: { mock: { enabled: true } },
    workspaces: ['repo', 'alias', 'other'].map(id => ({ id, label: id, path: id === 'other' ? join(base, id) : repo,
      maxProfile: 'full', allowedAdapters: ['mock'], harness: { verify: { commands: [{ id: 'check', argv: ['node', '-v'] }] } } })),
  })
  const registry = new AdapterRegistry(cfg)
  await registry.probe(['mock'])
  const manager = new RunManager(cfg, registry, clock, journal, join(base, 'logs'), () => {})
  managers.push(manager)
  await manager.recover()
  return manager
}

function command(workspaceId = 'repo', profile = 'edit') {
  const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'change.txt', content: 'changed' }])).toString('base64url')
  return RunDispatch.parse({ runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, workspaceId, profile, adapter: 'mock',
    timeoutMs: 300000, idleTimeoutMs: 10000, notAfter: 99999, origin: { source: 'dashboard', actorType: 'owner' },
    harness: { v: 1, trust: 'owner', inject: 'fresh', board: 'off', bootstrap: false, verify: { autoFixMaxRetries: 0 } },
    prompt: '#scenario:fs harness=1 ops=' + ops })
}

it('retains an uncertain verification hold through cancellation, journal ACK, compaction and restart', async () => {
  const journal = new Journal(state, clock)
  const manager = await worker(journal)
  const first = command()
  const events: RunEvent[] = []
  manager.outbox.attach(frame => { if (frame.type === 'run.events') events.push(...frame.payload.events); return true },
    1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1'])
  // T01 verifies OS teardown. Inject its typed result here to exercise the
  // handoff even when a simultaneous cancellation takes priority in the summary.
  const verify = vi.spyOn(verification, 'verifyAttempt').mockImplementationOnce(async () => {
    expect(journal.verificationHolds.blocks('repo', repo)).toBe(true)
    manager.cancel({ runId: first.runId, force: true, graceMs: 0, reason: 'user' })
    return { summary: { status: 'unverified', reason: 'CANCELLED', attempts: 1, failed: ['check'] },
      results: [], cleanupUnconfirmed: true }
  })
  manager.accept(first, clock.now())()
  await manager.awaitRuns()
  expect(verify).toHaveBeenCalledOnce()
  expect(events).toContainEqual(expect.objectContaining({ kind: 'log', text: expect.stringContaining('workspace quarantined') }))
  expect(events.find(event => event.kind === 'finished')).toMatchObject({ verification: { status: 'unverified', reason: 'CANCELLED' } })
  expect(() => manager.accept(command(), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
  journal.acked(first.runId)
  journal.compact()
  const restarted = await worker()
  expect(() => restarted.reserve(command('alias'), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
  expect(() => restarted.accept(command('alias', 'full'), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
  const read = command('alias', 'readonly')
  read.prompt = '#scenario: success'
  restarted.accept(read, clock.now())()
  await restarted.awaitRuns()
  restarted.accept(command('other'), clock.now())()
  await restarted.awaitRuns()
}, 20000)

it('keeps a pre-spawn hold on restart, and only its original live invocation can release it', () => {
  const journal = new Journal(state, clock)
  const clear = journal.verificationHolds.begin(runId(), 'repo', repo)
  expect(new Journal(state, clock).verificationHolds.blocks('alias', repo)).toBe(true)
  expect(journal.verificationHolds.blocks('other', join(base, 'other'))).toBe(false)
  clear()
  journal.verificationHolds.begin(runId(), 'alias', repo)
  expect(clear).toThrow('Stale verification cleanup')
  expect(new Journal(state, clock).verificationHolds.blocks('repo', repo)).toBe(true)
})

it('leaves the workspace held when the verification supervisor cannot return a result', async () => {
  const journal = new Journal(state, clock), manager = await worker(journal)
  const verify = vi.spyOn(verification, 'verifyAttempt').mockRejectedValueOnce(new Error('supervision interrupted'))
  manager.accept(command(), clock.now())()
  await manager.awaitRuns()
  expect(verify).toHaveBeenCalledOnce()
  expect(() => manager.reserve(command('alias'), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
  expect(new Journal(state, clock).verificationHolds.blocks('alias', repo)).toBe(true)
}, 15000)

it('preserves an unknown physical binding from a legacy verification through recovery and acknowledgement', async () => {
  const journal = new Journal(state, clock), cmd = command()
  journal.accepted({ runId: cmd.runId, taskId: cmd.taskId, workspaceId: cmd.workspaceId })
  journal.process({ runId: cmd.runId, role: 'verify', pid: process.pid })
  const restarted = await worker()
  expect(() => restarted.accept(command('alias'), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
  new Journal(state, clock).acked(cmd.runId)
  expect(new Journal(state, clock).verificationHolds.blocks('alias', repo)).toBe(true)
  expect(() => restarted.reserve(command('other'), clock.now())).toThrow('VERIFY_CLEANUP_UNCONFIRMED')
})

it('releases the persistent hold after confirmed cleanup and permits a subsequent writer', async () => {
  const journal = new Journal(state, clock), manager = await worker(journal)
  manager.accept(command(), clock.now())()
  await manager.awaitRuns()
  expect(new Journal(state, clock).verificationHolds.blocks('alias', repo)).toBe(false)
  manager.accept(command('alias'), clock.now())()
  await manager.awaitRuns()
}, 20000)
