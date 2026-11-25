import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runId, taskId, SystemClock } from '@agent-hub/common'
import { RunDispatch, type RunEvent } from '@agent-hub/protocol'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { mockAdapter } from '../src/adapters/mock.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { Journal } from '../src/runner/journal.js'
import * as spawnModule from '../src/runner/spawn.js'
import { RunManager } from '../src/runner/run-manager.js'

async function fixture(pipeHolder = false) {
  const base = mkdtempSync(join(tmpdir(), 'phase7c-'))
  const config = WorkerConfigSchema.parse({ shutdown: { pipeDrainTimeoutMs: 200 }, workerId: 'worker', hub: { url: 'ws://localhost:8080' },
    adapters: { mock: { enabled: true } }, workspaces: [{ id: 'repo', label: 'Repo', path: base, maxProfile: 'edit',
      allowedAdapters: ['mock'], harness: { verify: { commands: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(1)'] }] } } }] })
  const holder = process.platform === 'win32'
    ? { command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', 'start', '/b', 'ping.exe', '-n', '15', '127.0.0.1'] }
    : { command: process.execPath, args: ['-e', "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},14000)'],{stdio:['ignore',1,2]}).unref()"] }
  const adapter = { ...mockAdapter, buildInvocation: pipeHolder ? () => ({ ...holder, stdin: '', env: {} }) : mockAdapter.buildInvocation }
  const registry = new AdapterRegistry(config, [adapter])
  await registry.probe(['mock'])
  const clock = new SystemClock()
  const privateDir = mkdtempSync(join(tmpdir(), 'phase7c-state-'))
  const manager = new RunManager(config, registry, clock, new Journal(join(privateDir, 'journal'), clock), join(privateDir, 'logs'), () => {})
  const events: RunEvent[] = []
  manager.outbox.attach(frame => { if (frame.type === 'run.events') events.push(...frame.payload.events); return true },
    1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1'])
  const encode = (ops: object[]) => Buffer.from(JSON.stringify(ops)).toString('base64url')
  const command = () => RunDispatch.parse({ taskId: taskId(), runId: runId(), taskNo: 1, attempt: 1, adapter: 'mock',
    workspaceId: 'repo', profile: 'edit', timeoutMs: 300000, idleTimeoutMs: 30000, notAfter: Date.now() + 60000,
    origin: { source: 'dashboard', actorType: 'owner' },
    prompt: '#scenario:fs harness=1 ops=' + encode([{ op: 'write', path: 'sample.txt', content: 'one' }]) +
      ' fixOps=' + encode([{ op: 'delete', path: 'sample.txt' }]),
    harness: { v: 1, board: 'off', trust: 'owner', inject: 'fresh', bootstrap: false, verify: { autoFixMaxRetries: 1 } } })
  return { manager, events, run: () => {
    const cmd = command()
    manager.accept(cmd, Date.now())()
    return cmd.runId
  }, close: async () => {
    manager.cancelAll(); await manager.awaitRuns()
    rmSync(privateDir, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true })
  } }
}
it('F1 reruns required checks after a repair restores the original workspace', async () => {
  const f = await fixture()
  try {
    f.run(); await f.manager.awaitRuns()
    expect(f.events.filter(e => e.kind === 'verify' && e.phase === 'result')).toHaveLength(2)
    expect(f.events.at(-1)).toMatchObject({ kind: 'finished', verification: { status: 'failed', attempts: 2 } })
  } finally { await f.close() }
}, 30000)
it('F4 releases the writer after CLI exit while a descendant holds its pipes', async () => {
  const f = await fixture(true)
  try {
    const start = Date.now()
    f.run(); await f.manager.awaitRuns()
    expect(f.events.at(-1)).toMatchObject({ kind: 'finished', status: 'succeeded' })
    expect(Date.now() - start).toBeLessThan(11000)
    f.run(); await f.manager.awaitRuns()
    expect(f.events.filter(e => e.kind === 'started')).toHaveLength(2)
  } finally { await f.close() }
}, 35000)

it('F4 honors cancellation during pipe drain and logs the deadline once', async () => {
  const f = await fixture()
  const spawn = spawnModule.spawnRun
  let id: string
  let releaseClose: (() => void) | undefined
  const held = vi.spyOn(spawnModule, 'spawnRun').mockImplementation((...args) => {
    const child = spawn(...args)
    child.once('exit', () => queueMicrotask(() => f.manager.cancel({ runId: id, force: false, graceMs: 0, reason: 'user' })))
    const emit = child.emit.bind(child)
    child.emit = (event, ...values) => {
      if (event !== 'close') return emit(event, ...values)
      releaseClose = () => emit(event, ...values)
      return true
    }
    return child
  })
  try {
    id = f.run()
    await f.manager.awaitRuns()
    releaseClose?.()
    expect(f.events.filter(e => e.kind === 'log' && e.stream === 'system' && /drain/i.test(e.text))).toHaveLength(1)
    expect(f.events.filter(e => e.kind === 'finished')).toMatchObject([{ verification: { reason: 'CANCELLED' } }])
  } finally { held.mockRestore(); await f.close() }
}, 10000)
