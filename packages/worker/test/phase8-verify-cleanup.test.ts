import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { SystemClock } from '@agent-hub/common'
import { WorkspaceHarnessConfig } from '../src/config/schema.js'
import * as executable from '../src/adapters/resolve-exe.js'
import { superviseVerification } from '../src/harness/verify-cleanup.js'
import { verifyAttempt } from '../src/harness/verify-runner.js'
import * as containment from '../src/runner/kill-tree.js'
import { processAlive } from '../src/runner/process-identity.js'

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const tree = { terminate: vi.fn(), empty: vi.fn(() => true), close: vi.fn() }
  const stop = new AbortController()
  const force = new AbortController()
  const result = superviseVerification(child, tree, stop.signal, force.signal)
  return { child, tree, stop, force, result }
}

describe('verification process finalization', () => {
  afterEach(() => { vi.useRealTimers() })

  it('retains the exit status when an output pipe stays open past the drain deadline', async () => {
    vi.useFakeTimers()
    const { child, tree, result } = fixture()
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await result).toMatchObject({ code: 0, signal: null, cleanupConfirmed: false, outputTruncated: true })
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true)
    child.emit('close', 0, null)
    expect(tree.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds graceful and forced termination even without exit or close', async () => {
    vi.useFakeTimers()
    const { tree, stop, result } = fixture()
    tree.empty.mockReturnValue(false)
    stop.abort()
    await vi.advanceTimersByTimeAsync(7000)
    expect(await result).toMatchObject({ code: null, cleanupConfirmed: false })
    expect(tree.terminate.mock.calls).toEqual([[false], [true]])
    expect(tree.close).toHaveBeenCalledTimes(1)
  })

  it('waits for the process tree as well as exit and drained pipes', async () => {
    vi.useFakeTimers()
    const { child, tree, result } = fixture()
    tree.empty.mockReturnValue(false)
    child.emit('exit', 3, null)
    child.emit('close', 3, null)
    expect(tree.close).not.toHaveBeenCalled()
    tree.empty.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toMatchObject({ code: 3, cleanupConfirmed: true, outputTruncated: false })
  })

  it('coalesces cancellation, escalation and exit into a single terminal result', async () => {
    vi.useFakeTimers()
    const { child, tree, stop, force, result } = fixture()
    stop.abort()
    force.abort()
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    expect(await result).toMatchObject({ code: null, signal: 'SIGTERM', cleanupConfirmed: true })
    expect(tree.terminate.mock.calls).toEqual([[false], [true]])
    expect(tree.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

async function runCommands(source: string | string[], useJobObject = true) {
  const root = mkdtempSync(join(tmpdir(), 'verify-tree-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const warn = vi.fn()
  const emit = vi.fn()
  const log = vi.fn()
  const argv = typeof source === 'string' ? [process.execPath, '-e', source] : source
  const { verify } = WorkspaceHarnessConfig.parse({ verify: {
    commands: [{ id: 'first', argv }, { id: 'next', argv: [process.execPath, '-e', 'process.exitCode = 0'] }],
    failFast: false, totalTimeoutMs: 15000,
  } })
  const outcome = await verifyAttempt({
    root, clock: new SystemClock(), deadline: Infinity, runId: 'test', signal: new AbortController().signal,
    force: new AbortController().signal, journal: { process() {} }, useJobObject,
    emit, warn, log, patterns: [], knownSecrets: {},
  }, verify, 1)
  return { ...outcome, warn, emit, log }
}

it('propagates uncertain cleanup through verification and stops subsequent commands even with failFast off', async () => {
  const track = vi.spyOn(containment, 'trackVerificationTree').mockReturnValue({
    startTime: undefined, terminate: vi.fn(), empty() { throw new Error('query unavailable') }, close() {},
  })
  try {
    const { results, summary, cleanupUnconfirmed, emit, warn } = await runCommands('console.log("complete")')
    expect(cleanupUnconfirmed).toBe(true)
    expect(summary).toMatchObject({ status: 'unverified', failed: ['first'] })
    expect(results[0]).toMatchObject({ status: 'unavailable', exitCode: 0, tail: expect.stringContaining('VERIFY_CLEANUP_UNCONFIRMED') })
    expect(results[1]?.status).toBe('not_run')
    expect(emit).toHaveBeenCalledTimes(2)
    expect(track).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'VERIFY_CLEANUP_UNCONFIRMED')
  } finally {
    track.mockRestore()
  }
})

it('verifies a finite process tree with native containment and drains its output', async () => {
  const program = 'require("node:child_process").execFileSync(process.execPath, ["-e", "console.log(42)"], {stdio: "inherit"})'
  const { results, summary, cleanupUnconfirmed, log, warn } = await runCommands(program)
  expect(results.map(r => r.status)).toEqual(['passed', 'passed'])
  expect(summary.status).toBe('passed')
  expect(cleanupUnconfirmed).toBe(false)
  expect(log).toHaveBeenCalledWith('stdout', '[verify:first] 42')
  expect(warn).not.toHaveBeenCalled()
}, 20000)

const familyModes = process.platform === 'win32' ? ['normal', 'termination error'] : ['normal']
it.runIf(['win32', 'linux'].includes(process.platform)).each(familyModes)(
  'finishes verification with a surviving contained child holding both pipes: %s', async mode => {
    const directory = mkdtempSync(join(tmpdir(), 'verify-job-'))
    const pidFile = join(directory, 'child-pid')
    const fixtureFile = fileURLToPath(new URL('./fixtures/verify-job-family.py', import.meta.url))
    const nativeTrack = containment.trackVerificationTree
    let job: ReturnType<typeof nativeTrack> | undefined
    let parent: ChildProcess | undefined
    let descendant = 0
    let aliveAtParentExit = false
    let exitedAt = 0
    let closedAt = 0
    const tracker = vi.spyOn(containment, 'trackVerificationTree').mockImplementationOnce((child, enabled, warn) => {
      let attached = enabled
      job = nativeTrack(child, enabled, error => { attached = false; warn(error) })
      parent = child
      child.once('exit', () => {
        exitedAt = performance.now()
        if (existsSync(pidFile)) descendant = Number(readFileSync(pidFile, 'utf8'))
        aliveAtParentExit = processAlive(descendant)
      })
      child.once('close', () => { closedAt = performance.now() })
      if (attached) writeFileSync(join(directory, 'job-assigned'), '')
      if (mode === 'normal') return job
      // Inject a failure of termination only. The real kill-on-close Job stays
      // attached throughout, including the verifier's deadline and final cleanup.
      return { ...job, terminate() { throw new Error('injected termination failure') } }
    })
    try {
      const python = process.platform === 'win32' ? 'python.exe' : 'python3'
      const { results, summary, cleanupUnconfirmed, log } = await runCommands([python, fixtureFile, 'parent', directory])
      const returnedAt = performance.now()
      const uncertain = mode === 'termination error'
      expect(aliveAtParentExit, JSON.stringify({ descendant, first: results[0], output: log.mock.calls })).toBe(true)
      expect(parent?.exitCode).toBe(0)
      expect(log).toHaveBeenCalledWith('stdout', '[verify:first] child stdout')
      expect(log).toHaveBeenCalledWith('stderr', '[verify:first] child stderr')
      expect(cleanupUnconfirmed).toBe(uncertain)
      expect(summary.status).toBe(uncertain ? 'unverified' : 'passed')
      expect(results.map(r => r.status)).toEqual(uncertain ? ['unavailable', 'not_run'] : ['passed', 'passed'])
      expect(results[0]?.exitCode).toBe(0)
      if (uncertain) {
        expect(returnedAt - exitedAt).toBeLessThan(3500)
        expect(results[0]?.tail).toContain('VERIFY_CLEANUP_UNCONFIRMED')
        expect(results[0]?.tail).toContain('output truncated')
      }
      await vi.waitFor(() => expect(closedAt).toBeGreaterThanOrEqual(exitedAt))
      expect(closedAt - exitedAt).toBeLessThan(uncertain ? 3500 : 2000)
      if (uncertain) expect(closedAt - exitedAt).toBeGreaterThanOrEqual(1900)
      expect(parent?.stdout?.destroyed).toBe(true)
      expect(parent?.stderr?.destroyed).toBe(true)
      await vi.waitFor(() => expect(processAlive(descendant)).toBe(false))
    } finally {
      tracker.mockRestore()
      try { job?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
    }
  }, 20000,
)

it('bounds a real child close delayed by unread native stdout', async () => {
  // Keep a small, finite write buffered in readable mode. The OS process really
  // exits, but Node cannot deliver close until the pipe is drained or destroyed.
  const nativeTrack = containment.trackVerificationTree
  let observedChild: ChildProcess | undefined
  let exitedAt = 0
  let closedAt = 0
  let release: NodeJS.Timeout | undefined
  const hold = () => {}
  const observer = vi.spyOn(containment, 'trackVerificationTree').mockImplementation((child, ...args) => {
    observedChild = child
    child.stdout!.on('readable', hold)
    child.once('exit', () => {
      exitedAt = performance.now()
      // Release the test's hold even if the code under test regresses.
      release = setTimeout(() => { child.stdout?.off('readable', hold); child.stdout?.resume() }, 5000)
    })
    child.once('close', () => { closedAt = performance.now() })
    return nativeTrack(child, ...args)
  })
  try {
    const { results, summary, cleanupUnconfirmed, warn } = await runCommands('process.stdout.write("finite buffered output")')
    const returnedAt = performance.now()
    expect(exitedAt).toBeGreaterThan(0)
    expect(returnedAt - exitedAt).toBeGreaterThanOrEqual(1900)
    expect(returnedAt - exitedAt).toBeLessThan(3500)
    expect(observedChild?.exitCode).toBe(0)
    expect(observedChild?.stdout?.destroyed).toBe(true)
    expect(observedChild?.stderr?.destroyed).toBe(true)
    expect(results[0]).toMatchObject({ exitCode: 0, status: 'unavailable', tail: expect.stringContaining('output truncated') })
    expect(results[1]?.status).toBe('not_run')
    expect(summary.status).toBe('unverified')
    expect(cleanupUnconfirmed).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'VERIFY_CLEANUP_UNCONFIRMED')
    await vi.waitFor(() => expect(closedAt).toBeGreaterThan(exitedAt))
  } finally {
    clearTimeout(release)
    observer.mockRestore()
    observedChild?.stdout?.off('readable', hold)
    observedChild?.stdout?.destroy()
    observedChild?.stderr?.destroy()
  }
}, 12000)

it('reports a failed native spawn with no PID when a resolved executable disappears', async () => {
  const resolver = vi.spyOn(executable, 'resolveExe').mockReturnValueOnce({
    status: 'ready', exe: { command: join(tmpdir(), 'verify-absent-' + crypto.randomUUID() + '.exe'), prefixArgs: [] },
  })
  try {
    const { results, summary, cleanupUnconfirmed } = await runCommands('process.exitCode = 0')
    expect(results[0]).toMatchObject({ status: 'unavailable', exitCode: null, tail: 'Could not start executable' })
    expect(results[1]?.status).toBe('passed')
    expect(summary).toMatchObject({ status: 'unverified', reason: 'COMMAND_UNAVAILABLE' })
    expect(cleanupUnconfirmed).toBe(false)
  } finally { resolver.mockRestore() }
}, 12000)

it.runIf(process.platform === 'win32')('reports the lack of Job Object containment for a completed command', async () => {
  const { results, summary, cleanupUnconfirmed, warn } = await runCommands('console.log("complete")', false)
  expect(results[0]).toMatchObject({ status: 'unavailable', exitCode: 0, tail: expect.stringContaining('VERIFY_CLEANUP_UNCONFIRMED') })
  expect(results[1]?.status).toBe('not_run')
  expect(summary.status).toBe('unverified')
  expect(cleanupUnconfirmed).toBe(true)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Job Object unavailable'), 'PROCESS_TREE_FALLBACK')
}, 12000)
