import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { RunDispatch, RunEvent } from '@agent-hub/protocol'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { RunManager } from '../src/runner/run-manager.js'
import { Journal } from '../src/runner/journal.js'
import { mockAdapter } from '../src/adapters/mock.js'
import type { CliAdapter, InvocationInput } from '../src/adapters/types.js'
import { AdapterRegistry } from '../src/adapters/registry.js'

let base: string, clock: FakeClock, manager: RunManager
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'vf-run-')); clock = new FakeClock(10000) })
afterEach(async () => { manager?.cancelAll(); await manager?.awaitRuns(); rmSync(base, { recursive: true, force: true }) })
const write = (path: string, content = 'v1') => ({ op: 'write', path, content })
const script = (js: string, id = 'check') => ({ id, argv: ['node', '-e', js] })
async function launch(options: { commands?: unknown[]; ops?: unknown[]; fixOps?: unknown[]; failFast?: boolean; retries?: number; timeoutMs?: number;
  adapter?: CliAdapter; exposed?: boolean; readonly?: boolean; trust?: 'owner' | 'requester'; scenario?: string; maxFiles?: number
  subdir?: string; setup?: (root: string) => void } = {}) {
  const root = join(base, 'repo')
  mkdirSync(root)
  options.setup?.(root)
  const cfg = WorkerConfigSchema.parse({ workerId: 'test-worker', hub: { url: 'ws://localhost:9999' },
    security: { allowedEnvOverrideKeys: ['FROM_HUB'] }, adapters: { mock: { enabled: true, env: { ANTHROPIC_API_KEY: 'adapter-only' } } },
    workspaces: [{ id: 'repo', label: 'Repo', path: root, maxProfile: 'full', allowedAdapters: ['mock'],
      harness: { verify: { commands: options.commands ?? [script('process.exit(0)')], failFast: options.failFast ?? true } } }] })
  cfg.workspaces[0]!.configExposed = !!options.exposed
  if (options.maxFiles) cfg.workspaces[0]!.harness.manifest.maxFiles = options.maxFiles
  const registry = new AdapterRegistry(cfg, options.adapter ? [options.adapter] : undefined)
  await registry.probe(['mock'])
  manager = new RunManager(cfg, registry, clock, new Journal(join(base, 'journal'), clock), join(base, 'logs'), () => {})
  const events: RunEvent[] = []
  manager.outbox.attach(frame => { if (frame.type === 'run.events') events.push(...frame.payload.events.map(e => RunEvent.parse(e))); return true },
    1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1'])
  const encode = (ops: unknown[]) => Buffer.from(JSON.stringify(ops)).toString('base64url')
  const cmd = RunDispatch.parse({ runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, workspaceId: 'repo', adapter: 'mock',
    profile: options.readonly ? 'readonly' : 'edit', timeoutMs: options.timeoutMs ?? 300000, idleTimeoutMs: 10000, notAfter: 99999,
    origin: { source: 'dashboard', actorType: 'owner' }, env: { FROM_HUB: 'dev-only' }, ...(options.subdir && { subdir: options.subdir }),
    harness: { v: 1, trust: options.trust ?? 'owner', inject: 'fresh', board: 'write', bootstrap: false, verify: { autoFixMaxRetries: options.retries ?? 0 } },
    prompt: '#scenario:' + (options.scenario ?? 'fs') + ' harness=1 ops=' + encode(options.ops ?? [write('src.txt')]) + ' fixOps=' + encode(options.fixOps ?? []) })
  manager.accept(cmd, clock.now())()
  const settle = async () => { await manager.awaitRuns(); return events.find(e => e.kind === 'finished')! }
  return { events, cmd, settle }
}
it.each([
  ['NO_CHANGES', { ops: [] }], ['NO_COMMANDS', { commands: [] }], ['CONFIG_EXPOSED', { exposed: true }],
  ['NO_CHANGES', { ops: [{ op: 'mkdir', path: '.board' }, write('.board/package.json')] }], ['TAMPER_RISK', { ops: [write('package.json')] }],
  ['MANIFEST_INCOMPLETE', { maxFiles: 1, ops: [write('a'), write('b')] }], ['CLI_NOT_SUCCEEDED', { scenario: 'fail' }],
] as const)('VF skip or fail closed with %s', async (reason, options) => {
  const run = await launch({ ...options })
  expect((await run.settle()).verification).toMatchObject({ reason, attempts: 0 })
  expect(run.events.some(e => e.kind === 'verify')).toBe(false)
})
it.each([true, false])('VF-3/5/6/24 isolates the environment and redacts failed output, failFast=%s', async failFast => {
  const cmd = { ...script("console.log(process.env.TOKEN);process.exit(process.env.CI==='1'&&!process.env.FROM_HUB&&!process.env.ANTHROPIC_API_KEY&&!process.env.HUB_TEST&&!process.env.AGENT_WORKER_TEST?2:9)"), env: { TOKEN: 'synthetic-output-value', HUB_TEST: 'hub-private', AGENT_WORKER_TEST: 'worker-private' } }
  const run = await launch({ commands: [cmd, script('process.exit(0)', 'second')], failFast })
  expect(await run.settle()).toMatchObject({ status: 'succeeded', verification: { status: 'failed', failed: ['check'] } })
  const result = run.events.find(e => e.kind === 'verify' && e.phase === 'result')
  expect(result).toMatchObject({ results: [{ exitCode: 2, status: 'failed' }, { status: failFast ? 'not_run' : 'passed' }] })
  const local = readFileSync(join(base, 'logs', run.cmd.runId, 'output.log'), 'utf8')
  expect(local).toContain('[verify:check]')
  expect(local + JSON.stringify(run.events)).not.toContain('synthetic-output-value')
}, 20000)
it.each([
  [{ fixOps: [write('src.txt', 'fixed')] }, 'passed', 'PASSED', 2], [{ retries: 2 }, 'failed', 'MAX_RETRIES', 3],
  [{ maxFiles: 1, fixOps: [write('extra.txt')] }, 'unverified', 'MANIFEST_INCOMPLETE', 1],
  [{ timeoutMs: 60000 }, 'failed', 'BUDGET', 1], [{ fixOps: [write('package.json')] }, 'skipped', 'TAMPER_RISK', 1],
] as const)('VF-16–19 / TR-9 repairs under bounded retries %j', async (options, status, stoppedBy, attempts) => {
  const run = await launch({ retries: 1, ...options, commands: [script("process.exit(require('fs').readFileSync('src.txt','utf8')==='fixed'?0:1)")] })
  expect(await run.settle()).toMatchObject({ status: 'succeeded', verification: { status, attempts, autoFix: { stoppedBy } } })
  const rounds = run.events.filter(e => e.kind === 'workspace')
  expect(rounds.filter(e => !e.changes?.truncated).every(e => e.changes?.sample.some(p => p.path === 'src.txt' && p.change === 'added'))).toBe(true)
  expect(run.events.filter(e => e.kind === 'started')).toHaveLength(1)
}, 30000)
it.each(['cancel', 'shutdown', 'budget', 'command'] as const)('VF-7–10 preserves round zero after %s', async mode => {
  const run = await launch({ commands: [{ ...script("console.log('ready');setInterval(()=>{},1000)"), timeoutMs: mode === 'command' ? 20000 : 600000 }] })
  await vi.waitFor(() => { manager.outbox.flush(); expect(run.events.some(e => e.kind === 'log' && e.text.includes('[verify:check] ready'))).toBe(true) }, { timeout: 10000 })
  clock.advance(11000); manager.tick()
  expect(manager.seen(run.cmd.runId)).toBe('running')
  if (mode === 'shutdown') manager.cancelAll()
  else if (mode === 'cancel') manager.cancel({ runId: run.cmd.runId, force: true, graceMs: 0, reason: 'user' })
  else clock.advance(mode === 'budget' ? 300000 : 20000)
  const reason = { cancel: 'CANCELLED', shutdown: 'WORKER_SHUTDOWN', budget: 'BUDGET_EXHAUSTED', command: undefined }[mode]
  const end = await run.settle()
  expect(end.status).toBe('succeeded')
  expect(end.verification).toMatchObject(reason ? { status: 'unverified', reason } : { status: 'failed' })
}, 30000)
it('VF-2 marks an unresolved command unavailable', async () => {
  const run = await launch({ commands: [{ id: 'check', argv: ['no-such-phase7b-check'] }] })
  expect((await run.settle()).verification).toMatchObject({ reason: 'COMMAND_UNAVAILABLE' })
})
it('RT-13 reports an ordinary test edit in the manifest when local test discovery passes', async () => {
  const run = await launch({ ops: [write('example.test.cjs', "require('node:assert').ok(true)")],
    commands: [script("for(const f of require('fs').readdirSync('.').filter(p=>p.endsWith('.test.cjs')))require('./'+f)")] })
  expect((await run.settle()).verification?.status).toBe('passed')
  expect(run.events.find(e => e.kind === 'workspace')).toMatchObject({ changes: { total: 1, sample: [{ path: 'example.test.cjs', change: 'added' }] } })
})
it('VF-5 bounds the failed command tail by both lines and characters', async () => {
  const cmd = script("for(let n=0;n<256;n++)console.log(n+' '+'x'.repeat(96));process.exitCode=1")
  const run = await launch({ commands: [cmd] })
  await run.settle()
  const event = run.events.find(e => e.kind === 'verify' && e.phase === 'result')
  if (event?.kind !== 'verify' || event.phase !== 'result') throw new Error('Missing verification result')
  const tail = event.results[0]!.tail!
  expect(tail.length).toBeLessThanOrEqual(4096)
  expect(tail.split('\n').length).toBeLessThanOrEqual(64)
  expect(tail).toContain('255 ')
})
it('keeps one blackboard per project folder: a task in Forma reads and writes Forma/.board only', async () => {
  const calls: InvocationInput[] = []
  const adapter: CliAdapter = { ...mockAdapter, buildInvocation(input) { calls.push(input); return mockAdapter.buildInvocation(input) } }
  const board = (dir: string, notes: string) => { mkdirSync(join(dir, '.board'), { recursive: true }); writeFileSync(join(dir, '.board', 'HANDOFF.md'), notes) }
  const run = await launch({ adapter, subdir: 'Forma', ops: [write('.board/HANDOFF.md', 'forma updated')], setup: root => {
    board(root, 'root notes'); board(join(root, 'Forma'), 'forma notes') } })
  // 只改了项目黑板 → 仍算「只动了黑板」，不触发验证
  expect((await run.settle()).verification).toMatchObject({ reason: 'NO_CHANGES' })
  const prompt = calls.find(call => call.prompt.includes('<blackboard'))!.prompt
  expect(prompt).toContain('forma notes')
  expect(prompt).not.toContain('root notes')
  expect(prompt).toContain('R4 Blackboard (.board)')
  const post = run.events.find(e => e.kind === 'workspace')
  expect(post?.kind === 'workspace' && post.board?.files.find(file => file.file === 'HANDOFF.md')?.content).toBe('forma updated')
  expect(readFileSync(join(base, 'repo', '.board', 'HANDOFF.md'), 'utf8')).toBe('root notes')
})

it('VF-30 detects readonly changes outside the board', async () => {
  const run = await launch({ readonly: true })
  await run.settle()
  expect(run.events.find(e => e.kind === 'workspace')).toMatchObject({ readonlyCheck: 'violation', readonlyPaths: ['src.txt'] })
})

it.each([false, true])('VF-16/19 uses the last CLI session and refreshes the board when resume=%s', async resume => {
  const calls: InvocationInput[] = []
  const adapter: CliAdapter = { ...mockAdapter, features: { ...mockAdapter.features, resume },
    buildInvocation(input) { calls.push(input); return mockAdapter.buildInvocation(input) },
    createParser() {
      const parser = mockAdapter.createParser()
      return { ...parser, finish(exit, emit) {
        const outcome = parser.finish(exit, emit)
        const round = calls.at(-1)?.prompt.includes('mode="autofix"') ? 1 : 0
        return { ...outcome, summary: 'summary-' + round, cliSessionId: 'session-' + round,
          filesChanged: ['shared.txt', 'round-' + round], usage: { inputTokens: 3, outputTokens: round } }
      } }
    } }
  const ops = [{ op: 'mkdir', path: '.board' }, write('.board/HANDOFF.md', 'earlier notes'), write('src.txt')]
  const verify = script("const fs=require('fs');if(fs.readFileSync('src.txt','utf8')!=='fixed'){fs.writeFileSync('.board/HANDOFF.md','newly measured board');process.exit(1)}")
  const run = await launch({ adapter, retries: 1, ops, fixOps: [write('src.txt', 'fixed')], commands: [verify] })
  expect(await run.settle()).toMatchObject({ status: 'succeeded', summary: 'summary-1', cliSessionId: 'session-1',
    usage: { inputTokens: 6, outputTokens: 1 }, filesChanged: ['shared.txt', 'round-0', 'round-1'], verification: { status: 'passed' } })
  const fix = calls.at(-1)!
  expect(fix.resumeSessionId).toBe(resume ? 'session-0' : undefined)
  expect(fix.prompt.includes('newly measured board')).toBe(!resume)
  expect(fix.prompt).toContain('"autofix": {')
  expect(fix.prompt).toContain('src.txt')
}, 20000)
it('CR-3 replays the last successful round once when a subsequent repair exits nonzero', async () => {
  const path = join(base, 'recovery'), id = runId()
  const journal = new Journal(path, clock)
  journal.accepted({ runId: id, workspaceId: 'repo', taskId: taskId() })
  const outcome = { kind: 'finished' as const, status: 'succeeded' as const, exitCode: 0, signal: null, durationMs: 1, summary: 'original', cliSessionId: 's1', usage: { outputTokens: 3 } }
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 0, outcome })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 1, outcome })
  journal.process({ runId: id, pid: process.pid, role: 'cli' })
  journal.cliExited(id, { round: 1, verifyRequested: true, verifyAttempts: 1,
    outcome: { ...outcome, status: 'failed', exitCode: 2, summary: 'failed repair' } })
  journal.compact()
  const [record] = await new Journal(path, clock).recover()
  expect(record?.finished).toMatchObject({ status: 'succeeded', exitCode: 0, summary: 'original', cliSessionId: 's1', usage: { outputTokens: 6 },
    verification: { status: 'unverified', reason: 'WORKER_RESTARTED', attempts: 1, failed: [] } })
})
