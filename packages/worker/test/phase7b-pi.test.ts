/**
 * Pi 独立验收 · Phase 7b Worker 侧（VF-1 ~ VF-30、TR-1 ~ TR-9、RT-9 / RT-10 / RT-12、
 * CR-1 ~ CR-3、INV-15、RT-11）
 *
 * 与 Codex 的 phase7b-*.test.ts 独立：这里自己搭 RunManager、自己写探针命令，并把
 * 「没有启动任何验证进程」做成 journal 级别（run.process role=verify）的断言，
 * 而不是只看有没有 verify 事件。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { RunDispatch, RunEvent } from '@agent-hub/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkerConfigSchema, WorkspaceHarnessConfig } from '../src/config/schema.js'
import { loadWorkerReload, resolveWorkspaces } from '../src/config/load.js'
import { compileGlob } from '../src/harness/glob.js'
import { diffManifest, scanManifest } from '../src/harness/manifest.js'
import { sensitivePaths } from '../src/harness/tamper.js'
import { resolveVerifyCommand } from '../src/harness/verify-runner.js'
import { Journal } from '../src/runner/journal.js'
import { processStartTime } from '../src/runner/process-identity.js'
import { RunManager } from '../src/runner/run-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { mockAdapter } from '../src/adapters/mock.js'
import type { CliAdapter } from '../src/adapters/types.js'

// ─────────────────────────── 夹具 ───────────────────────────

const write = (path: string, content = 'v1') => ({ op: 'write', path, content })
const encode = (ops: unknown[]) => Buffer.from(JSON.stringify(ops)).toString('base64url')
const node = (js: string, id = 'check') => ({ id, argv: [process.execPath, '-e', js] })

let base: string
let clock: FakeClock
let manager: RunManager | undefined
let savedEnv: NodeJS.ProcessEnv
let rootSeq = 0
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pi7b-'))
  clock = new FakeClock(10_000)
  manager = undefined
  rootSeq = 0
  savedEnv = { ...process.env }
})
afterEach(async () => {
  manager?.cancelAll()
  await manager?.awaitRuns()
  manager = undefined
  process.env = savedEnv
  rmSync(base, { recursive: true, force: true })
})

type Finished = Extract<RunEvent, { kind: 'finished' }>
type VerifyEvent = Extract<RunEvent, { kind: 'verify' }>
type HarnessEvent = Extract<RunEvent, { kind: 'harness' }>
type WorkspaceEvent = Extract<RunEvent, { kind: 'workspace' }>

interface Options {
  commands?: unknown[]
  local?: Record<string, unknown>
  ops?: unknown[]
  fixOps?: unknown[]
  failFast?: boolean
  retries?: number
  runTimeoutMs?: number
  adapter?: CliAdapter
  exposed?: boolean
  readonly?: boolean
  trust?: 'owner' | 'requester'
  scenario?: string
  maxFiles?: number
  /** 工作区 harness 段的额外覆盖（tamper / manifest） */
  harness?: Record<string, unknown>
  adapterEnv?: Record<string, string>
  setup?: (root: string) => void
  harnessEnabled?: boolean
}

async function launch(options: Options = {}) {
  const root = join(base, 'repo-' + rootSeq++)
  mkdirSync(root, { recursive: true })
  options.setup?.(root)
  const cfg = WorkerConfigSchema.parse({
    harness: { enabled: options.harnessEnabled ?? true },
    workerId: 'pi-worker',
    hub: { url: 'ws://localhost:9999' },
    security: { allowedEnvOverrideKeys: ['FROM_HUB'] },
    adapters: { mock: { enabled: true, env: { ANTHROPIC_API_KEY: 'adapter-only-secret', ...options.adapterEnv } } },
    workspaces: [{
      id: 'repo', label: 'Repo', path: root, maxProfile: 'full', allowedAdapters: ['mock'],
      harness: {
        ...options.harness,
        verify: { commands: options.commands ?? [node('process.exit(0)')], failFast: options.failFast ?? true, ...options.local },
      },
    }],
  })
  cfg.workspaces[0]!.configExposed = !!options.exposed
  if (options.maxFiles) cfg.workspaces[0]!.harness.manifest.maxFiles = options.maxFiles
  const registry = new AdapterRegistry(cfg, options.adapter ? [options.adapter] : undefined)
  await registry.probe(['mock'])
  const journalPath = join(base, 'journal.jsonl')
  const runs = new RunManager(cfg, registry, clock, new Journal(journalPath, clock), join(base, 'logs'), () => {})
  manager = runs
  const events: RunEvent[] = []
  runs.outbox.attach(frame => {
    if (frame.type === 'run.events') events.push(...frame.payload.events.map(event => RunEvent.parse(event)))
    return true
  }, 1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1'])
  const cmd = RunDispatch.parse({
    runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, workspaceId: 'repo', adapter: 'mock',
    profile: options.readonly ? 'readonly' : 'edit', timeoutMs: options.runTimeoutMs ?? 300_000,
    idleTimeoutMs: 10_000, notAfter: 99_999_999,
    origin: { source: 'dashboard', actorType: options.trust ?? 'owner' }, env: { FROM_HUB: 'hub-private-env' },
    harness: { v: 1, trust: options.trust ?? 'owner', inject: 'fresh', board: 'write', bootstrap: false,
      verify: { autoFixMaxRetries: options.retries ?? 0 } },
    prompt: '#scenario:' + (options.scenario ?? 'fs') + ' harness=1 ops=' + encode(options.ops ?? [write('src.txt')]) +
      ' fixOps=' + encode(options.fixOps ?? []),
  })
  runs.accept(cmd, clock.now())()
  const journal = () => existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
  const verifyProcesses = () => journal().split(/\r?\n/u).filter(line => line.includes('"type":"run.process"'))
    .map(line => JSON.parse(line) as { role: string }).filter(record => record.role === 'verify')
  const settle = async (): Promise<Finished> => {
    await runs.awaitRuns()
    const event = events.find(item => item.kind === 'finished')
    if (event?.kind !== 'finished') throw new Error('no finished event')
    return event
  }
  return { runs, cmd, events, settle, root, journal, verifyProcesses }
}

const harnessOf = (events: RunEvent[]): HarnessEvent => {
  const event = events.find(item => item.kind === 'harness')
  if (event?.kind !== 'harness') throw new Error('no harness event')
  return event
}
const workspacesOf = (events: RunEvent[]) => events.filter((item): item is WorkspaceEvent => item.kind === 'workspace')
const verifyResults = (events: RunEvent[]) =>
  events.filter((item): item is VerifyEvent & { phase: 'result' } => item.kind === 'verify' && item.phase === 'result')
const indexOf = (events: RunEvent[], test: (event: RunEvent) => boolean) => events.findIndex(test)
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const waitDead = async (pids: number[], timeoutMs = 15_000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pids.every(pid => !alive(pid))) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return pids.every(pid => !alive(pid))
}

// ─────────────────────── VF-1：argv 白名单 ───────────────────────

const verifyConfig = (argv: string[]) => () => WorkspaceHarnessConfig.parse({ verify: { commands: [{ id: 'c', argv }] } })

it.each([
  'cmd', 'CMD', 'CMD.EXE', 'cmD.ExE', 'powershell', 'PowerShell.EXE', 'pwsh', 'pwsh.exe', 'bash', 'BASH.EXE', 'sh',
  'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'wsl', 'wsl.exe',
  'C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  '/bin/bash', '/usr/bin/sh',
])('VF-1 rejects shell interpreter %s as argv[0]', exe => {
  expect(verifyConfig([exe])).toThrow(/VERIFY_SHELL_FORBIDDEN/u)
})

it('VF-1 rejects relative paths with separators, NUL bytes and oversized argv', () => {
  for (const exe of ['./node', '../node', 'sub/node', 'sub\\node', '.\\node.exe', 'node ', ' two', 'node:flavour', '']) {
    expect(() => verifyConfig([exe])()).toThrow()
  }
  expect(() => verifyConfig(['node', 'a\u0000b'])()).toThrow()
  expect(() => verifyConfig(['node', 'z'.repeat(4097)])()).toThrow()
  // 9 × 4000 = 36 000 > 32 KiB，但每个参数都在 4096 以内
  expect(() => verifyConfig(['node', ...Array<string>(9).fill('y'.repeat(4000))])()).toThrow(/32 KiB/u)
  expect(verifyConfig(['node'])()).toMatchObject({ verify: { commands: [{ argv: ['node'] }] } })
  expect(verifyConfig([process.execPath])()).toMatchObject({ verify: { commands: [{ argv: [process.execPath] }] } })
  expect(verifyConfig(['node.exe'])()).toBeTruthy()
})

// ─────────────────────── VF-2：命令解析 ───────────────────────

it('VF-2 resolves bare names, absolute paths and npm .cmd shims without a shell', () => {
  expect(resolveVerifyCommand('node')).toMatchObject({ status: 'ready' })
  expect(resolveVerifyCommand(process.execPath)).toMatchObject({ status: 'ready' })
  expect(resolveVerifyCommand('pi-no-such-verify-binary')).toEqual({ status: 'missing' })
  if (process.platform !== 'win32') return
  const dir = join(base, 'shim')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'probe.js'), 'process.exit(0)\n')
  writeFileSync(join(dir, 'probe.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\bin\\probe.js" %*\r\n')
  const resolved = resolveVerifyCommand(join(dir, 'probe.cmd'))
  expect(resolved).toMatchObject({ status: 'ready', exe: { prefixArgs: [join(dir, 'bin', 'probe.js')] } })
  if (resolved.status === 'ready') expect(resolved.exe.command.toLowerCase()).toMatch(/node(?:\.exe)?$/u)
  writeFileSync(join(dir, 'broken.cmd'), '@ECHO off\r\ngarbage %*\r\n')
  expect(resolveVerifyCommand(join(dir, 'broken.cmd'))).toMatchObject({ status: 'error' })
})

it('VF-2/RT-10 reports unresolved commands as unavailable without spawning any process', async () => {
  const run = await launch({ commands: [{ id: 'missing', argv: ['pi-no-such-verify-binary'] }] })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'unverified', reason: 'COMMAND_UNAVAILABLE', attempts: 1 } })
  expect(verifyResults(run.events)[0]!.results[0]).toMatchObject({ status: 'unavailable', exitCode: null })
  expect(run.verifyProcesses()).toHaveLength(0)
  expect(end.errorCode).toBeUndefined()
})

// ─────────────────────── VF-3 / RT-9：验证环境隔离 ───────────────────────

const envProbe = `
const keys = Object.keys(process.env)
const bad = keys.filter(key => /^(?:ANTHROPIC|OPENAI|GEMINI|GOOGLE_|CLAUDE_|OPENCODE)/u.test(key)
  || /^AGENT_WORKER/u.test(key) || /^HUB_/u.test(key) || key === 'FROM_HUB' || key === 'HUB_TEST_PRIVATE')
if (process.env.CI !== '1') bad.push('CI')
if (process.env.MARK !== 'on') bad.push('MARK')
if (!keys.includes('TOKEN_FROM_PROCESS')) bad.push('TOKEN_FROM_PROCESS')
console.log(bad.length ? 'LEAK ' + bad.join(',') : 'CLEAN ' + keys.length)
process.exit(bad.length ? 2 : 0)
`

it('VF-3/RT-9 isolates the verification environment from adapter, Hub and Worker secrets', async () => {
  process.env.TOKEN_FROM_PROCESS = 'allowed-by-passEnv'
  process.env.AGENT_WORKER_TOKEN = 'worker-private'
  process.env.HUB_TOKEN = 'hub-private'
  process.env.HUB_TEST_PRIVATE = 'hub-private-2'
  const run = await launch({
    commands: [{ id: 'env', argv: [process.execPath, '-e', envProbe], env: { MARK: 'on' }, passEnv: ['TOKEN_FROM_PROCESS'] }],
    adapterEnv: { OPENAI_API_KEY: 'adapter-openai', GEMINI_API_KEY: 'adapter-gemini' },
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'passed', attempts: 1 })
  const log = readFileSync(join(base, 'logs', run.cmd.runId, 'output.log'), 'utf8')
  expect(log).toContain('[verify:env] CLEAN')
  expect(log).not.toContain('LEAK')
  expect(log).toMatch(/\[verify:env\] CLEAN \d+/u)
})

it('VF-3 ignores a Hub-supplied env override that is not whitelisted', async () => {
  const run = await launch({ commands: [node("console.log(process.env.FROM_HUB || 'absent');process.exit(process.env.FROM_HUB ? 3 : 0)")] })
  const end = await run.settle()
  expect(end.verification?.status).toBe('passed')
  expect(readFileSync(join(base, 'logs', run.cmd.runId, 'output.log'), 'utf8')).toContain('[verify:check] absent')
})

// ─────────────────────── VF-4 / VF-5 / VF-6 / VF-24 ───────────────────────

it('VF-4 emits the ordered verify pair and a passed conclusion after round zero', async () => {
  const run = await launch({ commands: [node("console.log('suite ok');process.exit(0)")] })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'passed', attempts: 1, failed: [] } })
  expect(run.events[0]!.kind).toBe('started')
  expect(run.events[1]!.kind).toBe('harness')
  expect(run.events.at(-1)!.kind).toBe('finished')
  const round = indexOf(run.events, event => event.kind === 'workspace')
  const started = indexOf(run.events, event => event.kind === 'verify' && event.phase === 'started')
  const result = indexOf(run.events, event => event.kind === 'verify' && event.phase === 'result')
  expect(round).toBeGreaterThan(1)
  expect(started).toBeGreaterThan(round)
  expect(result).toBeGreaterThan(started)
  expect(run.events.filter(item => item.kind === 'verify')).toHaveLength(2)
  expect(run.events.find(item => item.kind === 'verify')).toMatchObject({ attempt: 1, commands: ['check'] })
  // INV-14：最后一次 verify result 的 attempt = 最后一个 workspace round + 1
  expect(verifyResults(run.events).at(-1)!.attempt).toBe(workspacesOf(run.events).at(-1)!.round + 1)
  // ORD-4：验证输出带 [verify:<id>] 前缀
  expect(run.events.some(event => event.kind === 'log' && event.text.startsWith('[verify:check] '))).toBe(true)
})

it('VF-5/24 redacts the failed tail, keeps failFast not_run, and never changes finished.status', async () => {
  const secret = 'pi-verify-secret-value'
  const command = { id: 'check', argv: [process.execPath, '-e',
    "console.log(process.env.LEAK_ME);console.error('boom');process.exit(2)"], env: { LEAK_ME: secret } }
  const run = await launch({ commands: [command, node('process.exit(0)', 'second')], failFast: true })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'failed', attempts: 1, failed: ['check'] } })
  expect(verifyResults(run.events)[0]!.results).toMatchObject([
    { id: 'check', status: 'failed', exitCode: 2 }, { id: 'second', status: 'not_run', exitCode: null },
  ])
  const tail = verifyResults(run.events)[0]!.results[0]!.tail!
  expect(tail).toContain('boom')
  expect(tail).not.toContain(secret)
  expect(JSON.stringify(run.events)).not.toContain(secret)
  expect(readFileSync(join(base, 'logs', run.cmd.runId, 'output.log'), 'utf8')).not.toContain(secret)
})

it('VF-6 runs every command when failFast is false and reports only real failures', async () => {
  const run = await launch({ failFast: false, commands: [node('process.exit(0)', 'a'), node('process.exit(4)', 'b'),
    node('process.exit(0)', 'c')] })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'failed', failed: ['b'] })
  const [result] = verifyResults(run.events)
  expect(result!.results!.map(item => item.status)).toEqual(['passed', 'failed', 'passed'])
})

// ─────────────────────── VF-7 / VF-8：超时与预算 ───────────────────────

const treeProbe = `
const fs = require('fs')
const { spawn } = require('child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
fs.writeFileSync('pids.txt', [process.pid, child.pid].join(','))
console.log('tree ready')
setInterval(() => {}, 1000)
`
const readPids = (root: string) => readFileSync(join(root, 'pids.txt'), 'utf8').split(',').map(Number)

it('VF-7 kills the whole verification process tree on the per-command timeout', async () => {
  const run = await launch({ commands: [{ id: 'check', argv: [process.execPath, '-e', treeProbe], timeoutMs: 1500 }] })
  await vi.waitFor(() => expect(existsSync(join(run.root, 'pids.txt'))).toBe(true), { timeout: 20_000 })
  const pids = readPids(run.root)
  expect(pids.every(pid => alive(pid))).toBe(true)
  // 命令自身的 timeoutMs（而非 Run 预算）：虚拟时钟推进后应先优雅后强杀整棵树
  clock.advance(2000)
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'failed', failed: ['check'] } })
  expect(verifyResults(run.events)[0]!.results[0]).toMatchObject({ status: 'timed_out' })
  expect(await waitDead(pids)).toBe(true)
}, 40_000)

it('VF-8 turns Run budget exhaustion into unverified/BUDGET_EXHAUSTED while keeping succeeded', async () => {
  const run = await launch({ runTimeoutMs: 300_000, commands: [{ id: 'slow', argv: [process.execPath, '-e', treeProbe], timeoutMs: 600_000 }] })
  await vi.waitFor(() => expect(existsSync(join(run.root, 'pids.txt'))).toBe(true), { timeout: 20_000 })
  const pids = readPids(run.root)
  clock.advance(310_000)
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'unverified', reason: 'BUDGET_EXHAUSTED', failed: [] } })
  expect(end.errorCode).toBeUndefined()
  expect(verifyResults(run.events)[0]!.status).toBe('aborted')
  expect(await waitDead(pids)).toBe(true)
}, 40_000)

// ─────────────────────── VF-9 / VF-10：取消与关机 ───────────────────────

it('VF-9 cancelling during verification keeps succeeded and reports CANCELLED', async () => {
  const run = await launch({ runTimeoutMs: 600_000, commands: [{ id: 'slow', argv: [process.execPath, '-e', treeProbe], timeoutMs: 600_000 }] })
  await vi.waitFor(() => expect(existsSync(join(run.root, 'pids.txt'))).toBe(true), { timeout: 20_000 })
  const pids = readPids(run.root)
  expect(run.runs.seen(run.cmd.runId)).toBe('running')
  run.runs.cancel({ runId: run.cmd.runId, force: true, graceMs: 0, reason: 'user' })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'unverified', reason: 'CANCELLED' } })
  expect(await waitDead(pids)).toBe(true)
}, 40_000)

it('VF-10 Worker shutdown during verification reports WORKER_SHUTDOWN', async () => {
  const run = await launch({ runTimeoutMs: 600_000, commands: [{ id: 'slow', argv: [process.execPath, '-e', treeProbe], timeoutMs: 600_000 }] })
  await vi.waitFor(() => expect(existsSync(join(run.root, 'pids.txt'))).toBe(true), { timeout: 20_000 })
  const pids = readPids(run.root)
  run.runs.cancelAll()
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'unverified', reason: 'WORKER_SHUTDOWN' } })
  expect(await waitDead(pids)).toBe(true)
}, 40_000)

// ─────────────────────── VF-11 ~ VF-15 ───────────────────────

it('VF-11/VF-12 skip verification for no changes and board-only changes without spawning anything', async () => {
  const run = await launch({
    ops: [{ op: 'mkdir', path: '.board' }, write('.board/HANDOFF.md', '# HANDOFF')],
    commands: [node('require("fs").writeFileSync("ran.txt","1")')],
  })
  expect((await run.settle()).verification).toMatchObject({ status: 'skipped', reason: 'NO_CHANGES', attempts: 0 })
  expect(run.events.some(event => event.kind === 'verify')).toBe(false)
  expect(run.verifyProcesses()).toHaveLength(0)
  expect(existsSync(join(run.root, 'ran.txt'))).toBe(false)
  expect(workspacesOf(run.events)[0]!.changes).toMatchObject({ boardOnly: true })
})

it('VF-13/RT-10 skips with NO_COMMANDS and spawns no process when the workspace has no commands', async () => {
  const run = await launch({ commands: [] })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'NO_COMMANDS', attempts: 0 })
  expect(harnessOf(run.events).applied).toMatchObject({ verify: false, autoFixMaxRetries: 0,
    downgrades: [{ field: 'verify', reason: 'NO_COMMANDS' }] })
  expect(run.verifyProcesses()).toHaveLength(0)
  expect(run.events.some(event => event.kind === 'verify')).toBe(false)
})

it('VF-14 disables verification with CONFIG_EXPOSED and never runs a command', async () => {
  const probe = join(base, 'exposed-ran.txt')
  const run = await launch({ exposed: true, commands: [node(`require('fs').writeFileSync(${JSON.stringify(probe)},'1')`)] })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'CONFIG_EXPOSED', attempts: 0 })
  expect(harnessOf(run.events).applied.downgrades).toEqual([{ field: 'verify', reason: 'CONFIG_EXPOSED' }])
  // 黑板功能不受影响
  expect(harnessOf(run.events).applied.board).toBe('write')
  expect(run.verifyProcesses()).toHaveLength(0)
  expect(existsSync(probe)).toBe(false)
})

it('VF-15 reports CLI_NOT_SUCCEEDED and fails the run when the CLI itself fails', async () => {
  const run = await launch({ scenario: 'fail' })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'failed', verification: { status: 'skipped', reason: 'CLI_NOT_SUCCEEDED', attempts: 0 } })
  expect(run.verifyProcesses()).toHaveLength(0)
})

// ─────────────────────── VF-16 ~ VF-20：自动修复 ───────────────────────

it('VF-16/19 repairs once, keeps the last zero-exit summary and sums usage across rounds', async () => {
  const calls: string[] = []
  const adapter: CliAdapter = {
    ...mockAdapter,
    buildInvocation(input) { calls.push(input.prompt); return mockAdapter.buildInvocation(input) },
    createParser() {
      const parser = mockAdapter.createParser()
      return { ...parser, finish(exit, emit) {
        const outcome = parser.finish(exit, emit)
        const round = calls.at(-1)?.includes('mode="autofix"') ? 1 : 0
        return { ...outcome, summary: 'summary-' + round, cliSessionId: 'session-' + round,
          filesChanged: ['shared.txt', 'round-' + round], usage: { inputTokens: 5, outputTokens: round } }
      } }
    },
  }
  const run = await launch({
    adapter, retries: 1, fixOps: [write('src.txt', 'fixed')],
    commands: [node("process.exit(require('fs').readFileSync('src.txt','utf8')==='fixed'?0:1)")],
  })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', summary: 'summary-1', cliSessionId: 'session-1',
    usage: { inputTokens: 10, outputTokens: 1 }, verification: { status: 'passed', attempts: 2,
      autoFix: { attempts: 1, stoppedBy: 'PASSED' } } })
  expect(workspacesOf(run.events).map(event => event.round)).toEqual([0, 1])
  expect(verifyResults(run.events).map(event => event.attempt)).toEqual([1, 2])
  // 预解析（planReservation 的一次 buildInvocation）+ 两轮组合 prompt
  const composed = calls.filter(prompt => prompt.includes('<agent_hub_harness'))
  expect(composed).toHaveLength(2)
  expect(composed[1]).toContain('mode="autofix"')
  expect(composed[1]).toContain('AUTOFIX 1/1')
})

it('VF-17 stops at MAX_RETRIES after exhausting two repair rounds', async () => {
  const run = await launch({ retries: 2, commands: [node('process.exit(1)')] })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'failed', attempts: 3,
    autoFix: { attempts: 2, stoppedBy: 'MAX_RETRIES' } } })
  expect(workspacesOf(run.events).map(event => event.round)).toEqual([0, 1, 2])
  expect(verifyResults(run.events).map(event => event.attempt)).toEqual([1, 2, 3])
}, 40_000)

it('VF-18 refuses to repair when the remaining budget is below the threshold', async () => {
  const run = await launch({ retries: 1, runTimeoutMs: 60_000, commands: [node('process.exit(1)')] })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'failed', attempts: 1,
    autoFix: { attempts: 0, stoppedBy: 'BUDGET' } } })
  expect(workspacesOf(run.events).map(event => event.round)).toEqual([0])
})

it('VF-20 never repairs for a requester-trusted run even when a hostile Hub asks for retries', async () => {
  const run = await launch({ trust: 'requester', retries: 2, local: { maxAutoFixRetries: 2 },
    fixOps: [write('src.txt', 'fixed')], commands: [node('process.exit(1)')] })
  const end = await run.settle()
  expect(harnessOf(run.events).applied).toMatchObject({ trust: 'requester', autoFixMaxRetries: 0 })
  expect(workspacesOf(run.events).map(event => event.round)).toEqual([0])
  expect(end.verification).toMatchObject({ status: 'failed', attempts: 1 })
  expect(end.verification?.autoFix).toBeUndefined()
})

it('VF-20b clamps the Hub request to the local maxAutoFixRetries ceiling', async () => {
  const off = await launch({ retries: 2, local: { maxAutoFixRetries: 0 }, commands: [node('process.exit(1)')] })
  const offEnd = await off.settle()
  expect(harnessOf(off.events).applied.autoFixMaxRetries).toBe(0)
  expect(workspacesOf(off.events).map(event => event.round)).toEqual([0])
  expect(offEnd.verification).toMatchObject({ status: 'failed', attempts: 1 })
  const clamped = await launch({ retries: 2, local: { maxAutoFixRetries: 1 }, commands: [node('process.exit(1)')] })
  const clampedEnd = await clamped.settle()
  expect(harnessOf(clamped.events).applied.autoFixMaxRetries).toBe(1)
  expect(clampedEnd.verification).toMatchObject({ status: 'failed', attempts: 2, autoFix: { attempts: 1, stoppedBy: 'MAX_RETRIES' } })
}, 40_000)

// ─────────────────────── VF-21 / VF-22 / VF-23 ───────────────────────

it('VF-21 ignores node_modules/dist noise but trips on a CI workflow change', async () => {
  const ignored = await launch({ ops: [{ op: 'mkdir', path: 'node_modules/pkg' }, write('node_modules/pkg/index.js'),
    { op: 'mkdir', path: 'dist' }, write('dist/bundle.js')] })
  expect((await ignored.settle()).verification).toMatchObject({ status: 'skipped', reason: 'NO_CHANGES' })
  const ci = await launch({ ops: [{ op: 'mkdir', path: '.github/workflows' }, write('.github/workflows/ci.yml', 'on: push')] })
  const end = await ci.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK' })
  expect(workspacesOf(ci.events)[0]!.tamper?.paths).toContain('.github/workflows/ci.yml')
})

it('VF-22/TR-6 compares hashed files by content, not by mtime', async () => {
  const root = join(base, 'manifest')
  mkdirSync(root)
  const cfg = WorkspaceHarnessConfig.parse({ verify: { commands: [{ id: 'c', argv: ['node'] }] } })
  const sensitive = sensitivePaths(root, cfg)
  const file = join(root, 'package.json')
  writeFileSync(file, '{"a":1}')
  const pre = await scanManifest(root, cfg.manifest, sensitive)
  const stamp = pre.entries.get('package.json')!.mtimeMs / 1000
  // 只有 mtime 变化 → 不算修改
  utimesSync(file, stamp + 20, stamp + 20)
  const bumped = await scanManifest(root, cfg.manifest, sensitive)
  expect(bumped.entries.get('package.json')!.mtimeMs).not.toBe(pre.entries.get('package.json')!.mtimeMs)
  expect(bumped.entries.get('package.json')!.sha256).toBe(pre.entries.get('package.json')!.sha256)
  expect(diffManifest(pre, bumped, sensitive).changes.total).toBe(0)
  // 内容变化但 mtime 被 utimes 还原 → 仍靠 sha256 抓到
  writeFileSync(file, '{"a":2}')
  utimesSync(file, stamp, stamp)
  const restored = await scanManifest(root, cfg.manifest, sensitive)
  expect(restored.entries.get('package.json')!.size).toBe(pre.entries.get('package.json')!.size)
  expect(Math.abs(restored.entries.get('package.json')!.mtimeMs - pre.entries.get('package.json')!.mtimeMs))
    .toBeLessThan(1)
  expect(diffManifest(pre, restored, sensitive)).toMatchObject({ changes: { modified: 1, total: 1 },
    tamper: { paths: ['package.json'] } })
  // 大小变化 → modified
  writeFileSync(file, '{"a":1234567890}')
  expect(diffManifest(pre, await scanManifest(root, cfg.manifest, sensitive), sensitive).changes.modified).toBe(1)
  // Windows 上仅改大小写的重命名：以小写作为比较键、展示保留大小写 → 不是变更
  writeFileSync(join(root, 'Readme.txt'), 'x')
  const withReadme = await scanManifest(root, cfg.manifest, sensitive)
  renameSync(join(root, 'Readme.txt'), join(root, 'README.txt'))
  const renamed = await scanManifest(root, cfg.manifest, sensitive)
  expect(diffManifest(withReadme, renamed, sensitive).changes.total).toBe(process.platform === 'win32' ? 0 : 2)
})

it('VF-23 fails closed with MANIFEST_INCOMPLETE when a repair round truncates the manifest', async () => {
  const flood = [{ op: 'mkdir', path: 'flood' },
    ...Array.from({ length: 1000 }, (_, index) => write('flood/f' + index + '.txt', 'x'))]
  const run = await launch({
    retries: 1, maxFiles: 1000, ops: [write('src.txt', 'broken')], fixOps: flood,
    commands: [node('process.exit(1)')],
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'unverified', reason: 'MANIFEST_INCOMPLETE',
    autoFix: { attempts: 1, stoppedBy: 'MANIFEST_INCOMPLETE' } })
  expect(workspacesOf(run.events).at(-1)!.changes?.truncated).toBe(true)
  expect(verifyResults(run.events)).toHaveLength(1)
}, 60_000)

// ─────────────────────── VF-30 ───────────────────────

it('VF-30 flags every non-board file a readonly run changed', async () => {
  const run = await launch({ readonly: true, ops: [{ op: 'mkdir', path: 'src' }, write('src/app.ts'),
    { op: 'mkdir', path: '.board' }, write('.board/LESSONS.md', 'x')] })
  const end = await run.settle()
  expect(end.status).toBe('succeeded')
  const post = workspacesOf(run.events)[0]!
  expect(post).toMatchObject({ readonlyCheck: 'violation' })
  expect(post.readonlyPaths).toEqual(expect.arrayContaining(['src/app.ts']))
})

// ─────────────────────── TR-1：glob 方言 ───────────────────────

it.each([
  ['**/AGENTS.md', 'AGENTS.md', true], ['**/AGENTS.md', 'docs/AGENTS.md', true], ['**/AGENTS.md', 'a/b/c/AGENTS.md', true],
  ['AGENTS.md', 'docs/AGENTS.md', false], ['docs/**', 'docs/a/b.md', true], ['docs/**', 'docs', false],
  ['**/*.config.*', 'vitest.config.ts', true], ['**/*.config.*', 'packages/app/vite.config.mjs', true],
  ['*', 'a.ts', true], ['*', 'a/b.ts', false], ['?.ts', 'a.ts', true], ['?.ts', 'ab.ts', false],
  ['**/{a,b}.ts', 'x/b.ts', true], ['**/{a,b}.ts', 'x/c.ts', false], ['**/tsconfig*.json', 'tsconfig.base.json', true],
  ['**/tsconfig*.json', 'deep/tsconfig.json', true], ['.github/**', '.github/workflows/ci.yml', true],
  ['**/.npmrc', 'packages/app/.npmrc', true], ['**/package.json', 'node_modules/x/package.json', true],
])('TR-1 glob %s vs %s', (pattern, path, expected) => expect(compileGlob(String(pattern)).test(String(path))).toBe(expected))

it('TR-1 matches Windows paths case-insensitively and keeps POSIX matching exact', () => {
  expect(compileGlob('**/AGENTS.md', true).test('docs/agents.MD')).toBe(true)
  expect(compileGlob('**/AGENTS.md', false).test('docs/agents.md')).toBe(false)
})

// ─────────────────────── TR-2 / TR-3 / TR-4 / TR-5 ───────────────────────

it('TR-2 skips verification for a package.json edit without spawning any process', async () => {
  const run = await launch({ ops: [write('package.json', '{"scripts":{}}')],
    commands: [node('require("fs").writeFileSync("ran.txt","1");process.exit(0)')] })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK', attempts: 0 })
  expect(workspacesOf(run.events)[0]!.tamper).toMatchObject({ paths: ['package.json'] })
  expect(run.verifyProcesses()).toHaveLength(0)
  expect(run.events.some(event => event.kind === 'verify')).toBe(false)
  expect(existsSync(join(run.root, 'ran.txt'))).toBe(false)
})

it('TR-3 trips on every default-sensitive path in a single run', async () => {
  const paths = ['vitest.config.ts', 'tsconfig.json', '.github/workflows/ci.yml', 'AGENTS.md', 'pnpm-lock.yaml', 'docs/AGENTS.md']
  const run = await launch({
    ops: [{ op: 'mkdir', path: '.github/workflows' }, { op: 'mkdir', path: 'docs' },
      ...paths.map(path => write(path, 'tampered'))],
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK', attempts: 0 })
  expect(workspacesOf(run.events)[0]!.tamper?.paths).toEqual(expect.arrayContaining(paths))
  expect(run.verifyProcesses()).toHaveLength(0)
})

it('TR-4 never treats .board edits as tampering', async () => {
  const run = await launch({
    ops: [{ op: 'mkdir', path: '.board' }, write('.board/HANDOFF.md', '# HANDOFF'),
      write('.board/LESSONS.md', '# LESSONS'), write('.board/DECISIONS.md', '# DECISIONS')],
    setup(root) { mkdirSync(join(root, '.board')); writeFileSync(join(root, '.board', 'PROJECT_STATE.md'), '# PROJECT STATE') },
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'NO_CHANGES' })
  expect(workspacesOf(run.events)[0]!.tamper).toBeUndefined()
})

it('TR-5 protects a script referenced by argv even when it appears during the run', async () => {
  const run = await launch({
    setup(root) { mkdirSync(join(root, 'scripts')); writeFileSync(join(root, 'scripts', 'verify.mjs'), 'process.exit(0)\n') },
    commands: [{ id: 'script', argv: [process.execPath, 'scripts/verify.mjs'] }],
    ops: [write('scripts/verify.mjs', 'process.exit(0) // weakened\n')],
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK', attempts: 0 })
  expect(workspacesOf(run.events)[0]!.tamper?.paths).toContain('scripts/verify.mjs')
  expect(run.verifyProcesses()).toHaveLength(0)
})

// ─────────────────────── TR-7 / TR-8 / TR-9 ───────────────────────

it('TR-7 treats a junction created anywhere in the workspace as tampering', async () => {
  if (process.platform !== 'win32') return
  const run = await launch({
    setup(root) { mkdirSync(join(root, 'vendor', 'real'), { recursive: true }) },
    ops: [{ op: 'symlink', path: 'vendor/alias', target: 'vendor/real' }],
  })
  const end = await run.settle()
  expect(end.verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK' })
  const tamper = workspacesOf(run.events)[0]!.tamper
  expect(tamper?.links).toBe(1)
  expect(tamper?.paths).toContain('vendor/alias')
})

it('TR-8 honours extraPaths and replaceDefaults', async () => {
  const extra = await launch({ harness: { tamper: { extraPaths: ['local.settings'] } }, ops: [write('local.settings', 'x')] })
  expect((await extra.settle()).verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK' })
  const replaced = await launch({ harness: { tamper: { replaceDefaults: true, extraPaths: ['local.settings'] } },
    ops: [write('package.json', '{}')] })
  expect((await replaced.settle()).verification).toMatchObject({ status: 'passed' })
  expect(workspacesOf(replaced.events)[0]!.tamper).toBeUndefined()
  const both = await launch({ harness: { tamper: { replaceDefaults: true, extraPaths: ['local.settings'] } }, ops: [write('local.settings', 'x')] })
  expect((await both.settle()).verification).toMatchObject({ status: 'skipped', reason: 'TAMPER_RISK' })
})

it('TR-9 stops the repair loop on tampering without reporting the earlier failure', async () => {
  const run = await launch({ retries: 2, ops: [write('src.txt', 'broken')], fixOps: [write('tsconfig.json', '{}')],
    commands: [node('process.exit(1)')] })
  const end = await run.settle()
  expect(end).toMatchObject({ status: 'succeeded', verification: { status: 'skipped', reason: 'TAMPER_RISK',
    autoFix: { attempts: 1, stoppedBy: 'TAMPER_RISK' } } })
  expect(workspacesOf(run.events).map(event => event.round)).toEqual([0, 1])
  expect(end.verification?.failed).toEqual([])
}, 40_000)

// ─────────────────────── CR-1 ~ CR-3 ───────────────────────

it('CR-1 synthesises succeeded + unverified/WORKER_RESTARTED after cli_exited but before verification', async () => {
  const dir = join(base, 'cr1'), id = runId()
  const journal = new Journal(dir, clock)
  journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'repo' })
  journal.progress(id, 7)
  journal.process({ runId: id, role: 'cli', pid: process.pid })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 0, outcome: { kind: 'finished',
    status: 'succeeded', exitCode: 0, signal: null, durationMs: 42, summary: 'cli done', cliSessionId: 's-1' } })
  const [record] = await new Journal(dir, clock).recover()
  expect(record!.finished).toMatchObject({ seq: 8, status: 'succeeded', summary: 'cli done', cliSessionId: 's-1',
    verification: { status: 'unverified', reason: 'WORKER_RESTARTED', attempts: 0, failed: [] } })
  expect(record!.finished?.errorCode).toBeUndefined()
})

it('CR-1b keeps CLI_NOT_SUCCEEDED when the crashed run never succeeded', async () => {
  const dir = join(base, 'cr1b'), id = runId()
  const journal = new Journal(dir, clock)
  journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'repo' })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 0, outcome: { kind: 'finished',
    status: 'failed', exitCode: 2, signal: null, durationMs: 9, summary: 'bad', errorCode: 'NONZERO_EXIT' } })
  const [record] = await new Journal(dir, clock).recover()
  expect(record!.finished).toMatchObject({ status: 'failed', errorCode: 'NONZERO_EXIT',
    verification: { status: 'skipped', reason: 'CLI_NOT_SUCCEEDED' } })
})

it('CR-3 keeps the last successful round when a repair round crashed', async () => {
  const dir = join(base, 'cr3'), id = runId()
  const journal = new Journal(dir, clock)
  journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'repo' })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 1,
    outcome: { kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, durationMs: 10, summary: 'good round',
      cliSessionId: 's-0', usage: { outputTokens: 4 } } })
  journal.cliExited(id, { round: 1, verifyRequested: true, verifyAttempts: 1,
    outcome: { kind: 'finished', status: 'failed', exitCode: 3, signal: null, durationMs: 20, summary: 'bad round',
      cliSessionId: 's-1', usage: { outputTokens: 5 } } })
  const [record] = await new Journal(dir, clock).recover()
  expect(record!.finished).toMatchObject({ status: 'succeeded', summary: 'good round', cliSessionId: 's-0',
    usage: { outputTokens: 9 }, verification: { status: 'unverified', reason: 'WORKER_RESTARTED', attempts: 1 } })
})

it('CR-2 kills the orphaned verification process tree recorded in the journal', async () => {
  const dir = join(base, 'cr2')
  const children: ChildProcess[] = []
  const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  children.push(orphan)
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
  children.push(bystander)
  await new Promise(resolve => setTimeout(resolve, 500))
  const pid = orphan.pid!
  const startTime = processStartTime(pid)
  const id = runId()
  const journal = new Journal(dir, clock)
  journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'repo' })
  journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 1, outcome: { kind: 'finished',
    status: 'succeeded', exitCode: 0, signal: null, durationMs: 5, summary: '' } })
  journal.process({ runId: id, role: 'verify', pid, ...(startTime && { pidStartTime: startTime }) })
  await new Journal(dir, clock).recover()
  if (startTime) {
    expect(await waitDead([pid], 10_000)).toBe(true)
    // 没有 pidStartTime 匹配的 bystander 不受影响
    expect(alive(bystander.pid!)).toBe(true)
  }
  for (const child of children) { try { child.kill('SIGKILL') } catch { /* already gone */ } }
}, 30_000)

// ─────────────────────── INV-15 ───────────────────────

const treeDigest = (root: string) => {
  const rows: string[] = []
  const walk = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      const rel = relative(root, full).split(sep).join('/')
      if (item.isDirectory()) { rows.push('d ' + rel); walk(full); continue }
      const stat = statSync(full)
      rows.push('f ' + rel + ' ' + stat.size + ' ' + stat.mtimeMs)
    }
  }
  walk(root)
  return rows.sort()
}

it('INV-15 writes nothing into the workspace across prepare, verify and autofix', async () => {
  const run = await launch({ retries: 1, ops: [write('src.txt', 'broken')], fixOps: [write('src.txt', 'fixed')],
    commands: [node("process.exit(require('fs').readFileSync('src.txt','utf8')==='fixed'?0:1)")] })
  const before = treeDigest(run.root)
  const end = await run.settle()
  expect(end.verification?.status).toBe('passed')
  const after = treeDigest(run.root)
  const changed = after.filter(row => !before.includes(row)).concat(before.filter(row => !after.includes(row)))
  // 唯一的差异来自 mock CLI（子进程）写入的 src.txt；Worker 自己不产生任何路径变化
  expect(changed.length).toBeLessThanOrEqual(1)
  expect(changed.every(row => row.includes('src.txt'))).toBe(true)
  expect(existsSync(join(run.root, '.board'))).toBe(false)
}, 40_000)

// ─────────────────────── RT-11：配置热重载攻击 ───────────────────────

it('RT-11 freezes verification configuration while the config lives inside a workspace', async () => {
  const dir = join(base, 'reload')
  const workspace = join(dir, 'repo')
  const other = join(dir, 'other')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(other, { recursive: true })
  const configPath = join(workspace, 'worker.yaml')
  const stateDir = join(dir, 'state')
  const shape = (otherHarness?: Record<string, unknown>) => ({
    workerId: 'pi-worker', hub: { url: 'ws://localhost:9999' },
    workspaces: [
      { id: 'repo', label: 'Repo', path: workspace, allowedAdapters: ['mock'], maxProfile: 'edit',
        harness: { verify: { commands: [{ id: 'check', argv: ['node', '-e', 'process.exit(0)'] }] } } },
      { id: 'other', label: 'Other', path: other, allowedAdapters: ['mock'], maxProfile: 'edit',
        ...(otherHarness ? { harness: otherHarness } : {}) },
    ],
  })
  writeFileSync(configPath, JSON.stringify(shape()))
  const previous = resolveWorkspaces(WorkerConfigSchema.parse(shape()), configPath, stateDir)
  expect(previous.workspaces[0]!.configExposed).toBe(true)
  const blocked: string[] = []
  // 攻击 1：给另一个（未暴露的）工作区加一条会成功执行的验证命令
  writeFileSync(configPath, JSON.stringify(shape({ verify: { commands: [{ id: 'evil', argv: ['node', '-e', 'process.exit(0)'] }] } })))
  const next = loadWorkerReload(configPath, stateDir, previous, true, id => blocked.push(id))
  expect(blocked).toContain('other')
  expect(next.workspaces.find(ws => ws.id === 'other')!.harness.verify.commands).toEqual([])
  // 攻击 2：改写暴露工作区自己的命令
  blocked.length = 0
  const rewritten = shape() as { workspaces: Array<{ harness: { verify: { commands: unknown[] } } }> }
  rewritten.workspaces[0]!.harness.verify.commands = [{ id: 'check', argv: ['node', '-e', 'process.exit(9)'] }]
  writeFileSync(configPath, JSON.stringify(rewritten))
  const frozen = loadWorkerReload(configPath, stateDir, previous, true, id => blocked.push(id))
  expect(blocked).toContain('repo')
  expect(frozen.workspaces[0]!.harness.verify.commands[0]!.argv.join(' '))
    .toBe(previous.workspaces[0]!.harness.verify.commands[0]!.argv.join(' '))
  // 非验证字段的普通热更新仍然生效
  blocked.length = 0
  const labels = shape() as { workspaces: Array<{ label: string }> }
  labels.workspaces[0]!.label = 'Renamed'
  writeFileSync(configPath, JSON.stringify(labels))
  const applied = loadWorkerReload(configPath, stateDir, previous, true, id => blocked.push(id))
  expect(applied.workspaces[0]!.label).toBe('Renamed')
  expect(blocked).toEqual([])
})
