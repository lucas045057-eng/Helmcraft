import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { createRedactor, type Clock } from '@agent-hub/common'
import type { RunEvent, VerificationSummary, VerifyCommandResult } from '@agent-hub/protocol'
import type { VerifyCommand, Workspace } from '../config/schema.js'
import { resolveExe } from '../adapters/resolve-exe.js'
import { buildEnvironment } from '../security/env.js'
import { resolveWorkspaceSubdir } from '../security/workspace.js'
import { superviseVerification } from './verify-cleanup.js'
import { trackVerificationTree } from '../runner/kill-tree.js'
import { LocalLogStream } from '../runner/local-log.js'
import type { Journal } from '../runner/journal.js'

type AbortReason = 'CANCELLED' | 'WORKER_SHUTDOWN' | 'BUDGET_EXHAUSTED'
interface Context {
  root: string; runId: string; clock: Clock; deadline: number; signal: AbortSignal
  force: AbortSignal; warn(message: string, code?: string): void
  journal: Pick<Journal, 'process'>; useJobObject: boolean; patterns: string[]; knownSecrets: Record<string, string>
  log(stream: 'stdout' | 'stderr', text: string): void
  emit(event: Omit<Extract<RunEvent, { kind: 'verify' }>, 'seq' | 'ts'>): void
}
export function resolveVerifyCommand(exe: string) {
  return isAbsolute(exe) ? resolveExe(basename(exe), { command: exe }) : resolveExe(exe)
}
async function execute(cmd: VerifyCommand, ctx: Context, deadline: number) {
  const start = ctx.clock.monotonic()
  const result: VerifyCommandResult = { id: cmd.id, status: 'unavailable', exitCode: null, signal: null, durationMs: 0 }
  let budgetExpired = false
  const resolved = resolveVerifyCommand(cmd.argv[0]!)
  if (resolved.status !== 'ready') {
    result.tail = resolved.status === 'missing' ? 'Executable was not found' : resolved.error
    return { result, budgetExpired }
  }
  let cwd: string
  try { cwd = resolveWorkspaceSubdir(ctx.root, cmd.cwd) } catch { result.tail = 'Invalid verification working directory'; return { result, budgetExpired } }
  const { env, knownSecrets } = buildEnvironment(process.env, cmd)
  const deadlineLimited = deadline <= start + cmd.timeoutMs
  const until = Math.min(start + cmd.timeoutMs, deadline)
  if (ctx.clock.monotonic() >= until) return { result: { ...result, status: 'not_run' as const }, budgetExpired: true }
  const launch = () => spawn(resolved.exe.command, [...resolved.exe.prefixArgs, ...cmd.argv.slice(1)], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false,
  })
  let child: ReturnType<typeof launch>
  try { child = launch() } catch { result.tail = 'Could not start executable'; return { result, budgetExpired } }
  if (!child.pid) {
    // Node reports an asynchronous spawn error even though no process exists.
    child.once('error', () => {})
    child.stdout.destroy()
    child.stderr.destroy()
    result.tail = 'Could not start executable'
    return { result, budgetExpired }
  }
  const tree = trackVerificationTree(child, ctx.useJobObject, () =>
    ctx.warn('Windows Job Object unavailable; descendant cleanup cannot be confirmed', 'PROCESS_TREE_FALLBACK'))
  let tail = ''
  const streams = (['stdout', 'stderr'] as const).map(stream => {
    const scrub = createRedactor({ ...ctx.knownSecrets, ...knownSecrets }, ctx.patterns)
    const lines = new LocalLogStream(line => scrub(stripVTControlCharacters(line)), clean => {
      const text = clean.replace(/[\r\n]+$/, '')
      tail = (tail ? tail + '\n' + text : text).slice(-4096).split('\n').slice(-64).join('\n')
      ctx.log(stream, '[verify:' + cmd.id + '] ' + text)
    })
    const pipe = child[stream]
    const onData = (chunk: Buffer) => lines.push(chunk)
    pipe.on('data', onData)
    return () => { pipe.off('data', onData); lines.finish() }
  })
  const timeout = new AbortController()
  const emergency = new AbortController()
  const terminal = superviseVerification(child, tree, AbortSignal.any([ctx.signal, timeout.signal]),
    AbortSignal.any([ctx.force, emergency.signal]))
  const cancelTimer = ctx.clock.setInterval(() => {
    cancelTimer()
    if (child.exitCode === null && child.signalCode === null) {
      budgetExpired = deadlineLimited
      timeout.abort()
    }
  }, Math.max(1, until - ctx.clock.monotonic()))
  let journalFailed = false
  try {
    ctx.journal.process({ runId: ctx.runId, role: 'verify', pid: child.pid, ...(tree.startTime && { pidStartTime: tree.startTime }) })
  } catch {
    journalFailed = true
    emergency.abort()
  }
  try {
    const state = await terminal
    result.exitCode = state.code
    result.signal = state.signal
    const cleanupUnconfirmed = !state.cleanupConfirmed
    for (const finish of streams) finish()
    result.durationMs = Math.floor(ctx.clock.monotonic() - start)
    if (cleanupUnconfirmed) {
      ctx.warn('Verification cleanup could not be confirmed', 'VERIFY_CLEANUP_UNCONFIRMED')
      const notice = state.outputTruncated ? 'Verification output truncated; cleanup unconfirmed' : 'Verification cleanup unconfirmed'
      result.tail = (tail + '\nVERIFY_CLEANUP_UNCONFIRMED: ' + notice).trim().split('\n').slice(-64).join('\n').slice(-4096)
    } else {
      if (journalFailed) throw new Error('Verification process journal unavailable')
      result.status = timeout.signal.aborted ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed'
      if (result.status !== 'passed') result.tail = tail
    }
    return { result, budgetExpired, cleanupUnconfirmed }
  } finally {
    cancelTimer()
  }
}
export async function verifyAttempt(ctx: Context, config: Workspace['harness']['verify'], attempt: number) {
  const deadline = Math.min(ctx.deadline, ctx.clock.monotonic() + config.totalTimeoutMs)
  const commands = config.commands.map(c => c.id)
  ctx.emit({ kind: 'verify', phase: 'started', attempt, commands })
  const results: VerifyCommandResult[] = []
  let failed = false
  let cleanupUnconfirmed = false
  let aborted: AbortReason | 'INTERNAL' | undefined
  for (const cmd of config.commands) {
    if (ctx.signal.aborted) aborted = ctx.signal.reason as AbortReason
    else if (ctx.clock.monotonic() >= deadline) aborted = 'BUDGET_EXHAUSTED'
    if (cleanupUnconfirmed || aborted || (failed && config.failFast)) {
      results.push({ id: cmd.id, status: 'not_run', exitCode: null, signal: null, durationMs: 0 })
      continue
    }
    let execution: Awaited<ReturnType<typeof execute>>
    try { execution = await execute(cmd, ctx, deadline) }
    catch {
      ctx.warn('Could not supervise verification command', 'VERIFY_PROCESS_ERROR')
      aborted = 'INTERNAL'
      results.push({ id: cmd.id, status: 'unavailable', exitCode: null, signal: null, durationMs: 0, tail: 'Verification process supervision failed' })
      continue
    }
    const { result, budgetExpired } = execution
    cleanupUnconfirmed ||= execution.cleanupUnconfirmed === true
    if (ctx.signal.aborted) aborted = ctx.signal.reason as AbortReason
    else if (budgetExpired || ctx.clock.monotonic() >= deadline) aborted = 'BUDGET_EXHAUSTED'
    results.push(result)
    failed ||= result.status !== 'passed'
  }
  const status = aborted ? 'aborted' : failed ? 'failed' : 'passed'
  ctx.emit({ kind: 'verify', phase: 'result', attempt, commands, status, results })
  // Legacy peers accept a closed set of summary reasons. The command evidence
  // carries the precise diagnostic; the local supervisor consumes a typed flag.
  const reason = aborted ?? (cleanupUnconfirmed ? 'INTERNAL' : results.some(r => r.status === 'unavailable') ? 'COMMAND_UNAVAILABLE' : undefined)
  const summary: VerificationSummary = { status: reason ? 'unverified' : failed ? 'failed' : 'passed', ...(reason && { reason }), attempts: attempt,
    failed: results.filter(r => r.status !== 'passed' && r.status !== 'not_run').map(r => r.id) }
  return { summary, results, cleanupUnconfirmed }
}
