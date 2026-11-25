import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runId, SystemClock, taskId } from '@agent-hub/common'
import { RunDispatch } from '@agent-hub/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { opencodeAdapter } from '../src/adapters/opencode.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { main } from '../src/cli.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { identityPermissionsArePrivate, loadIdentity } from '../src/identity.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'
import { powershell, psArgs, psLiteral } from '../src/windows-powershell.js'
import { stringify } from 'yaml'

const dirs: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'worker 任务 空格-'))
  dirs.push(root)
  const cwd = join(root, '中文 工作区')
  mkdirSync(cwd)
  const path = join(root, "worker's 测试.yaml")
  const draft = { workerId: 'test-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    adapters: { opencode: { enabled: true } }, workspaces: [
      { id: 'repo', label: 'Repo', path: cwd, allowedAdapters: ['opencode'], maxProfile: 'readonly' },
    ] }
  return { root, cwd, path, draft }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it.each(['success', 'cancel', 'spawn', 'materialize'])('cleans Run temp files after %s', async mode => {
  const { root, cwd, draft } = setup()
  const capture = join(root, 'capture.json')
  const script = join(root, 'adapter.cjs')
  writeFileSync(script, `
    const fs = require('node:fs');
    const path = process.env.OPENCODE_CONFIG;
    let prompt = '';
    process.stdin.setEncoding('utf8').on('data', chunk => prompt += chunk).on('end', () => {
      fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ path, cwd: process.cwd(), prompt,
        content: fs.readFileSync(path, 'utf8'), mode: fs.statSync(path).mode & 511 }));
      if (${mode === 'cancel'}) setInterval(() => {}, 60_000);
    });
  `)
  const config = WorkerConfigSchema.parse({ ...draft, security: { allowedEnvOverrideKeys: ['OPENCODE_CONFIG'] } })
  const registry = new AdapterRegistry(config, [{ ...opencodeAdapter,
    probe: async () => ({ status: 'ready', exe: { command: mode === 'spawn' ? join(root, 'missing.exe') : process.execPath, prefixArgs: [script] } }),
    buildInvocation(input) {
      const call = opencodeAdapter.buildInvocation(input)
      if (mode === 'materialize') call.tempFiles?.push({ path: '../escape.json', content: 'bad' })
      return call
    },
  }])
  await registry.probe()
  const clock = new SystemClock()
  const journal = new Journal(join(root, 'state', 'journal.jsonl'), clock)
  const tempRoot = join(root, 'temp')
  const manager = new RunManager(config, registry, clock, journal, join(root, 'logs'), vi.fn(), tempRoot)
  mkdirSync(join(tempRoot, 'run-abc123'), { recursive: true })
  writeFileSync(join(tempRoot, 'run-abc123', 'stale.json'), 'stale')
  await manager.recover()
  expect(readdirSync(tempRoot)).toEqual([])
  const prompt = '-& calc.exe " | del %PATH% ^ 中文'
  const dispatch = RunDispatch.parse({
    runId: runId(Date.now()), taskId: taskId(Date.now()), taskNo: 1, attempt: 1, adapter: 'opencode',
    workspaceId: 'repo', profile: 'readonly', prompt, timeoutMs: 60_000, idleTimeoutMs: 60_000,
    notAfter: Date.now() + 60_000, origin: { source: 'dashboard', actorType: 'owner' },
    env: { OPENCODE_CONFIG: join(root, 'wrong.json') },
  })
  manager.reserve(dispatch, Date.now())()
  try {
    if (mode === 'cancel') {
      await vi.waitFor(() => expect(existsSync(capture)).toBe(true), { timeout: 5000 })
      manager.cancel({ runId: dispatch.runId, reason: 'user', force: true, graceMs: 0 })
    }
    await manager.awaitRuns()
    if (mode === 'success' || mode === 'cancel') {
      const report = JSON.parse(readFileSync(capture, 'utf8'))
      expect(report).toMatchObject({ cwd, prompt, content: expect.stringContaining('"bash":"deny"') })
      if (process.platform !== 'win32') expect(report.mode).toBe(0o600)
      expect(existsSync(report.path)).toBe(false)
    }
    expect(existsSync(join(root, 'escape.json'))).toBe(false)
    expect(readdirSync(tempRoot)).toEqual([])
  } finally {
    manager.cancelAll()
    await manager.awaitRuns()
  }
}, 12_000)

it('doctor reports invalid config and missing identity without modifying files', async () => {
  const { root, path, draft } = setup()
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  writeFileSync(path, 'bad: [')
  expect(await main(['doctor', '--config', path])).toBe(1)
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ config: { status: 'error' } })
  writeFileSync(path, stringify({ ...draft, adapters: {} }))
  expect(await main(['doctor', '--config', path])).toBe(1)
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ config: { status: 'ok' }, identity: { status: 'missing' } })
  expect(existsSync(join(root, 'identity.key'))).toBe(false)
})

it('doctor inventories adapters, detects the Ed25519 key and optionally checks Hub health', async () => {
  const { root, cwd, path, draft } = setup()
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const hub = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404, { 'Content-Type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve))
  try {
    const address = hub.address()
    if (!address || typeof address === 'string') throw new Error('Missing Hub address')
    writeFileSync(path, stringify({ ...draft, adapters: { mock: { enabled: true } },
      hub: { url: 'ws://127.0.0.1:' + address.port + '/ws/worker' } }))
    expect(loadIdentity(join(root, 'identity.key'), true).privateKey.asymmetricKeyType).toBe('ed25519')
    expect(await main(['doctor', '--config', path, '--check-hub', '--dump-help'])).toBe(0)
    expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({
      node: { version: process.version, status: 'ok' }, config: { status: 'ok', path },
      workspaces: [{ id: 'repo', path: cwd }], identity: { status: 'ok', acl: { status: 'ok' } },
      jobObject: { status: expect.any(String) }, hub: { status: 'ok', httpStatus: 200 },
      adapters: [{ id: 'mock', status: 'ready', exe: { command: process.execPath } }],
    })
  } finally { await new Promise<void>(resolve => hub.close(() => resolve())) }
}, 12_000)

it.runIf(process.platform === 'win32')('installs and uninstalls a limited interactive Windows task', async () => {
  const { path, draft } = setup()
  writeFileSync(path, stringify(draft))
  const task = 'AgentWorker-Test-' + randomUUID()
  const query = () => execFileSync('schtasks.exe', ['/Query', '/TN', task, '/XML'],
    { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
  try {
    expect(await main(['install-task', '--config', path, '--task-name', task])).toBe(0)
    const output = query()
    const xml = output.toString(output[1] === 0 || output[0] === 255 ? 'utf16le' : 'utf8')
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<Hidden>true</Hidden>')
    const restart = /<RestartOnFailure>([\s\S]*?)<\/RestartOnFailure>/.exec(xml)?.[1]
    expect(restart).toContain('<Interval>PT1M</Interval>')
    expect(restart).toContain('<Count>999</Count>')
    const actual = execFileSync(powershell, psArgs(`
$task = Get-ScheduledTask -TaskName ${psLiteral(task)} -TaskPath '\\'
$task.Principal.RunLevel.ToString()
([System.Security.Principal.NTAccount] $task.Triggers[0].UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value
[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
`), { encoding: 'utf8', windowsHide: true, shell: false }).trim().split(/\r?\n/)
    expect(actual[0]).toBe('Limited')
    expect(actual[1]).toBe(actual[2])
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(xml)?.[1]
    expect(encoded).toBeDefined()
    const launch = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(launch).toContain('测试.yaml')
    expect(launch).toContain("worker''s 测试.yaml")
  } finally {
    await main(['uninstall-task', '--task-name', task])
  }
  expect(query).toThrow()
}, 30_000)

it.runIf(process.platform === 'win32')('removes pre-existing explicit ACL grants from an Ed25519 private key', () => {
  const { root } = setup()
  const key = join(root, "密钥 ' worker.key")
  const first = loadIdentity(key, true)
  const icacls = (args: string[]) => execFileSync('icacls.exe', [key, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(identityPermissionsArePrivate(key)).toBe(true)
  icacls(['/grant', '*S-1-1-0:(R)'])
  expect(identityPermissionsArePrivate(key)).toBe(false)
  expect(loadIdentity(key).fingerprint).toBe(first.fingerprint)
  expect(identityPermissionsArePrivate(key)).toBe(true)
  expect(icacls([]).match(/:\(R\)/g)).toHaveLength(1)
}, 12_000)
