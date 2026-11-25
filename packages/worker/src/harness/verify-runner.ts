import { spawn } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { createRedactor, type Clock } from '@agent-hub/common'
import type { RunEvent, VerificationSummary, VerifyCommandResult } from '@agent-hub/protocol'
import type { VerifyCommand, Workspace } from '../config/schema.js'
import { resolveExe } from '../adapters/resolve-exe.js'
import { buildEnvironment } from '../security/env.js'
import { resolveWorkspaceSubdir } from '../security/workspace.js'
import { trackProcessTree } from '../runner/kill-tree.js'
import { LocalLogStream } from '../runner/local-log.js'
import type { Journal } from '../runner/journal.js'

type AbortReason = 'CANCELLED' | 'WORKER_SHUTDOWN' | 'BUDGET_EXHAUSTED'
interface Context {
  root: string; runId: string; clock: Clock; deadline: number; signal: AbortSignal
  force: AbortSignal; warn(message: string, code?: string): void
  journal: Journal; useJobObject: boolean; patterns: string[]; knownSecrets: Record<string, string>
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
  let tail = ''
  const streams = (['stdout', 'stderr'] as const).map(stream => {
    const scrub = createRedactor({ ...ctx.knownSecrets, ...knownSecrets }, ctx.patterns)
    const lines = new LocalLogStream(line => scrub(stripVTControlCharacters(line)), clean => {
      const text = clean.replace(/[\r\n]+$/, '')
      tail = (tail ? tail + '\n' + text : text).slice(-4096).split('\n').slice(-64).join('\n')
      ctx.log(stream, '[verify:' + cmd.id + '] ' + text)
    })
    child[stream].on('data', (chunk: Buffer) => lines.push(chunk))
    return lines
  })
  let errored = false
  child.once('error', () => { errored = true })
  const closed = new Promise<void>(resolve => child.once('close', (code, signal) => {
    result.exitCode = code
    result.signal = signal
    resolve()
  }))
  if (!child.pid) { await closed; result.tail = 'Could not start executable'; return { result, budgetExpired } }
  const tree = trackProcessTree(child.pid, { useJobObject: ctx.useJobObject, onWarning: warning => {
    const survived = typeof warning === 'object' && warning && 'code' in warning && warning.code === 'ORPHAN_SURVIVED'
    if (survived) errored = true
    ctx.warn(survived ? 'Verification process tree survived termination' : 'Verification process tree fallback',
      survived ? 'ORPHAN_SURVIVED' : 'PROCESS_TREE_FALLBACK')
  } })
  let killing: Promise<void> | undefined
  const grace = new AbortController()
  const stop = () => { killing ??= tree.kill({ force: ctx.force.aborted, graceMs: 5000, signal: AbortSignal.any([grace.signal, ctx.force]) }).catch(() => { errored = true }) }
  let timedOut = false
  const cancelTimer = ctx.clock.setInterval(() => {
    cancelTimer()
    timedOut = true
    budgetExpired = deadlineLimited
    stop()
  }, Math.max(1, until - ctx.clock.monotonic()))
  ctx.signal.addEventListener('abort', stop, { once: true })
  child.once('exit', () => { grace.abort(); killing ??= tree.kill({ force: true }).catch(() => { errored = true }) })
  try {
    ctx.journal.process({ runId: ctx.runId, role: 'verify', pid: child.pid, ...(tree.startTime && { pidStartTime: tree.startTime }) })
    if (ctx.signal.aborted) stop()
    await closed
    await killing
    for (const stream of streams) stream.finish()
    result.status = timedOut ? 'timed_out' : errored ? 'unavailable' : result.exitCode === 0 ? 'passed' : 'failed'
    if (result.status !== 'passed') result.tail = tail
    result.durationMs = Math.floor(ctx.clock.monotonic() - start)
  } finally {
    ctx.signal.removeEventListener('abort', stop)
    cancelTimer()
    try { await tree.kill({ force: true }) } finally { tree.close() }
  }
  return { result, budgetExpired }
}
export async function verifyAttempt(ctx: Context, config: Workspace['harness']['verify'], attempt: number) {
  const deadline = Math.min(ctx.deadline, ctx.clock.monotonic() + config.totalTimeoutMs)
  const commands = config.commands.map(c => c.id)
  ctx.emit({ kind: 'verify', phase: 'started', attempt, commands })
  const results: VerifyCommandResult[] = []
  let failed = false
  let aborted: AbortReason | 'INTERNAL' | undefined
  for (const cmd of config.commands) {
    if (ctx.signal.aborted) aborted = ctx.signal.reason as AbortReason
    else if (ctx.clock.monotonic() >= deadline) aborted = 'BUDGET_EXHAUSTED'
    if (aborted || (failed && config.failFast)) {
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
    if (ctx.signal.aborted) aborted = ctx.signal.reason as AbortReason
    else if (budgetExpired || ctx.clock.monotonic() >= deadline) aborted = 'BUDGET_EXHAUSTED'
    results.push(result)
    failed ||= result.status !== 'passed'
  }
  const status = aborted ? 'aborted' : failed ? 'failed' : 'passed'
  ctx.emit({ kind: 'verify', phase: 'result', attempt, commands, status, results })
  const reason = aborted ?? (results.some(r => r.status === 'unavailable') ? 'COMMAND_UNAVAILABLE' : undefined)
  const summary: VerificationSummary = { status: reason ? 'unverified' : failed ? 'failed' : 'passed', ...(reason && { reason }), attempts: attempt,
    failed: results.filter(r => r.status !== 'passed' && r.status !== 'not_run').map(r => r.id) }
  return { summary, results }
}
