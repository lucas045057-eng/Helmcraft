/**
 * Pi 独立验收 · Phase 3 · Windows 实机门禁
 *   WIN-8  中文 + 空格工作区：完整 resolveWorkspaceSubdir + 真实子进程 + filesChanged 映射
 *   WIN-10 计划任务安装 / 结构核查 / 卸载（finally 保证不留垃圾任务）
 *   WIN-11 Ed25519 私钥 ACL 实测（icacls / Get-Acl）
 *   doctor 结构化诊断 + 正确探测本机 codex-cli 0.166.0
 *
 * 说明：本文件不发起任何真实 LLM 调用，只使用 `--version` / `--help` / 本地假 CLI。
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { runId, SystemClock, taskId } from '@agent-hub/common'
import { RunDispatch } from '@agent-hub/protocol'
import { stringify } from 'yaml'
import { codexAdapter } from '../src/adapters/codex.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { CliAdapter } from '../src/adapters/types.js'
import { main } from '../src/cli.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { doctor } from '../src/doctor.js'
import { identityPermissionsArePrivate, loadIdentity, readIdentity } from '../src/identity.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'
import { mapWorkspaceFile, resolveWorkspaceSubdir } from '../src/security/workspace.js'
import { powershell, psArgs, psEnv, psLiteral } from '../src/windows-powershell.js'

const win = process.platform === 'win32'
const dirs: string[] = []

function scratch(prefix = 'pi-win3-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => { vi.restoreAllMocks() })
afterAll(() => { for (const dir of dirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } })

/** Windows 上 schtasks /XML 输出为 UTF-16LE（带 BOM），此处统一解码。 */
function decodeWindows(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  const zeros = buf.subarray(0, Math.min(buf.length, 64)).filter(byte => byte === 0).length
  return zeros > 8 ? buf.toString('utf16le') : buf.toString('utf8')
}

function ps(script: string): string {
  return execFileSync(powershell, psArgs(script), { encoding: 'utf8', shell: false, windowsHide: true, env: psEnv(),
    stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 断言字符串没有 UTF-8 解码损坏（替换字符 / 双重编码）。 */
function expectCleanText(value: string, label: string) {
  expect(value, label).not.toContain('\uFFFD')
  expect(JSON.parse(JSON.stringify(value)), label).toBe(value)
  expect(Buffer.from(value, 'utf8').toString('utf8'), label).toBe(value)
}

function writeConfig(root: string, draft: Record<string, unknown>): { path: string; cfg: ReturnType<typeof WorkerConfigSchema.parse> } {
  const path = join(root, 'worker 配置.yaml')
  writeFileSync(path, stringify(draft), 'utf8')
  return { path, cfg: WorkerConfigSchema.parse(draft) }
}

// ── WIN-8 中文 + 空格工作区 ─────────────────────────────────────────────────

it('WIN-8 中文 + 空格工作区：resolveWorkspaceSubdir / mapWorkspaceFile 无乱码且越界被拒', () => {
  const root = scratch('pi 中文 根-')
  const wsRoot = join(root, '中文 工作区 测试')
  const sub = join(wsRoot, '子 目录')
  mkdirSync(sub, { recursive: true })
  const file = join(sub, '文件 一.txt')
  writeFileSync(file, '内容')

  const rootReal = realpathSync.native(wsRoot)
  const subReal = realpathSync.native(sub)
  expectCleanText(rootReal, 'workspace root')
  expectCleanText(subReal, 'subdir')

  expect(resolveWorkspaceSubdir(wsRoot)).toBe(rootReal)
  expect(resolveWorkspaceSubdir(wsRoot, '子 目录')).toBe(subReal)
  expect(resolveWorkspaceSubdir(wsRoot, '子 目录/')).toBe(subReal)
  expectCleanText(resolveWorkspaceSubdir(wsRoot, '子 目录'), 'resolved subdir')

  expect(mapWorkspaceFile(rootReal, subReal, '文件 一.txt')).toBe('子 目录/文件 一.txt')
  // 相对工作区根的写法要相对 root 解析
  expect(mapWorkspaceFile(rootReal, rootReal, '子 目录\\文件 一.txt')).toBe('子 目录/文件 一.txt')
  expect(mapWorkspaceFile(rootReal, rootReal, '子 目录/文件 一.txt')).toBe('子 目录/文件 一.txt')
  expect(mapWorkspaceFile(rootReal, subReal, join(sub, '文件 一.txt'))).toBe('子 目录/文件 一.txt')
  for (const path of ['../../../escape.txt', '..\\..\\escape.txt', 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    '\\\\server\\share\\x', 'con', 'aux.txt', 'x:stream']) {
    expect(() => mapWorkspaceFile(rootReal, subReal, path), path).toThrow()
  }
  expect(() => mapWorkspaceFile(rootReal, subReal, '..\\..\\escape.txt')).toThrow(/outside the workspace/u)
  // 工作区内部的 .. 不得越界：返回值仍然是工作区内的相对路径
  for (const path of ['子 目录/../文件 一.txt', '.', '子 目录/../..']) {
    const mapped = mapWorkspaceFile(rootReal, subReal, path)
    expect(mapped.startsWith('..'), path).toBe(false)
    expect(mapped.includes(':'), path).toBe(false)
    expect(realpathSync.native(mapped ? join(rootReal, mapped.split('/')[0]!) : rootReal)).toBeTruthy()
  }
  for (const subdir of ['../..', '..', 'C:\\Windows', '\\\\server\\share', 'con', 'x ', 'a:stream']) {
    expect(() => resolveWorkspaceSubdir(wsRoot, subdir), subdir).toThrow()
  }
})

it('WIN-8 完整 RunManager 链路：中文 + 空格 cwd，真实子进程 + 真实 codex 解析器，filesChanged 映射正确无乱码', async () => {
  const root = scratch('pi win8 ')
  const wsRoot = join(root, '中文 工作区 测试')
  const sub = join(wsRoot, '子 目录')
  mkdirSync(sub, { recursive: true })
  const logsRoot = join(root, '日志 根目录')
  const capture = join(root, 'capture.json')
  const script = join(root, 'fake mock cli.cjs')
  writeFileSync(script, `
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ cwd: process.cwd(), prompt }));
  const lines = [
    { type: 'thread.started', thread_id: '会话-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '文件 一.txt', kind: 'add' }] } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '深 层\\\\deep.txt', kind: 'update' }] } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: '../../../escape.txt', kind: 'add' }] } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'D:/Windows/System32/x.txt', kind: 'delete' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: '完成 ✅ 中文' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } }
  ];
  process.stdout.write(lines.map(line => JSON.stringify(line)).join('\\n') + '\\n');
});
`)

  // 真实的 codex 适配器 + 真实的 codex 解析器，只把可执行文件换成假 CLI。
  const adapter: CliAdapter = {
    ...codexAdapter,
    probe: async () => ({ status: 'ready', version: '0.166.0', exe: { command: process.execPath, prefixArgs: [script] } }),
  }
  const draft = { workerId: 'pi-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    adapters: { codex: { enabled: true } },
    workspaces: [{ id: 'repo', label: '中文 仓库', path: wsRoot, allowedAdapters: ['codex'], maxProfile: 'edit' }] }
  const cfg = WorkerConfigSchema.parse({ ...draft, localLogs: { dir: logsRoot } })
  const registry = new AdapterRegistry(cfg, [adapter])
  await registry.probe()
  expect(registry.get('codex')?.result.status).toBe('ready')

  const clock = new SystemClock()
  const journal = new Journal(join(root, '状态', 'journal.jsonl'), clock)
  const warn = vi.fn()
  const manager = new RunManager(cfg, registry, clock, journal, logsRoot, warn, join(root, '临时 目录'))
  const frames: Array<{ type: string; payload: unknown }> = []
  manager.outbox.attach(frame => { frames.push(frame as never); return true }, 1 << 20, 8 << 20)

  const prompt = '请分析 "子 目录" 里的文件 & 报告 -- 中文 😀'
  const dispatch = RunDispatch.parse({ runId: runId(Date.now()), taskId: taskId(Date.now()), taskNo: 1, attempt: 1,
    adapter: 'codex', workspaceId: 'repo', subdir: '子 目录', profile: 'edit', prompt,
    timeoutMs: 60_000, idleTimeoutMs: 60_000, notAfter: Date.now() + 120_000,
    origin: { source: 'dashboard', actorType: 'owner' } })

  manager.reserve(dispatch, Date.now())()
  await manager.awaitRuns()

  // 真实子进程的 cwd 必须是中文子目录的真实路径，无乱码
  expect(existsSync(capture), '假 CLI 未运行').toBe(true)
  const observed = JSON.parse(readFileSync(capture, 'utf8')) as { cwd: string; prompt: string }
  expect(observed.cwd).toBe(realpathSync.native(sub))
  expectCleanText(observed.cwd, 'child cwd')
  expect(observed.prompt).toBe(prompt)

  const events = frames.flatMap(frame => frame.type === 'run.events'
    ? (frame.payload as { events: Array<Record<string, unknown>> }).events : [])
  const finished = events.find(event => event.kind === 'finished')
  expect(finished, '没有 finished 事件').toBeDefined()
  expectCleanText(String(finished!.summary), 'finished summary')
  expect(finished).toMatchObject({ status: 'succeeded', cliSessionId: '会话-1', summary: '完成 ✅ 中文',
    // CLI 上报的路径是相对其 cwd 的（cwd = <root>/中文 工作区 测试/子 目录）
    filesChanged: ['子 目录/文件 一.txt', '子 目录/深 层/deep.txt', '<outside-workspace>', '<outside-workspace>'] })

  const fileChanges = events.filter(event => event.kind === 'agent')
    .map(event => event.event as { type: string; path?: string })
    .filter(event => event.type === 'file_change')
    .map(event => event.path)
  expect(fileChanges).toEqual(['子 目录/文件 一.txt', '子 目录/深 层/deep.txt', '<outside-workspace>', '<outside-workspace>'])
  for (const path of fileChanges.slice(0, 2)) {
    expectCleanText(path!, 'filesChanged')
    expect(path).toMatch(/^子 目录\//u)
    expect(path).not.toContain('\\')
  }
  // 越界路径必须被记为告警
  expect(warn.mock.calls.some(call => String(call[1]) === 'PATH_REJECTED')).toBe(true)

  // 本地日志落在中文目录下，内容无乱码
  const logPath = join(logsRoot, dispatch.runId, 'output.log')
  expect(existsSync(logPath)).toBe(true)
  const log = readFileSync(logPath, 'utf8')
  expectCleanText(log, 'local log')
  expect(log).toContain('完成 ✅ 中文')
})

it('WIN-8 真实 mock-cli 在中文 + 空格工作区子目录中正常执行（succeeded + summary 正确）', async () => {
  const root = scratch('pi win8 mock ')
  const wsRoot = join(root, '中文 工作区 测试')
  mkdirSync(join(wsRoot, '子 目录'), { recursive: true })
  const logsRoot = join(root, '日志 根目录')
  const draft = { workerId: 'pi-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'repo', label: '中文 仓库', path: wsRoot, allowedAdapters: ['mock'], maxProfile: 'edit' }] }
  const cfg = WorkerConfigSchema.parse({ ...draft, localLogs: { dir: logsRoot } })
  const registry = new AdapterRegistry(cfg)
  await registry.probe()
  expect(registry.get('mock')?.result.status, 'mock-cli 必须可用').toBe('ready')

  const clock = new SystemClock()
  const journal = new Journal(join(root, '状态', 'journal.jsonl'), clock)
  const manager = new RunManager(cfg, registry, clock, journal, logsRoot, vi.fn(), join(root, '临时 目录'))
  const frames: Array<{ type: string; payload: unknown }> = []
  manager.outbox.attach(frame => { frames.push(frame as never); return true }, 1 << 20, 8 << 20)
  const dispatch = RunDispatch.parse({ runId: runId(Date.now()), taskId: taskId(Date.now()), taskNo: 1, attempt: 1,
    adapter: 'mock', workspaceId: 'repo', subdir: '子 目录', profile: 'edit',
    prompt: '#scenario: success n=3', timeoutMs: 60_000, idleTimeoutMs: 60_000,
    notAfter: Date.now() + 120_000, origin: { source: 'dashboard', actorType: 'owner' } })

  manager.reserve(dispatch, Date.now())()
  await manager.awaitRuns()

  const events = frames.flatMap(frame => frame.type === 'run.events'
    ? (frame.payload as { events: Array<Record<string, unknown>> }).events : [])
  const finished = events.find(event => event.kind === 'finished') as Record<string, unknown> | undefined
  expect(finished).toBeDefined()
  expect(finished).toMatchObject({ status: 'succeeded', summary: 'Mock response 3', cliSessionId: 'mock-session' })
  expect(events.find(event => event.kind === 'started')).toMatchObject({ adapter: 'mock', effectiveProfile: 'edit' })
  expect(readFileSync(join(logsRoot, dispatch.runId, 'output.log'), 'utf8')).toContain('Mock response 3')
})

// ── WIN-10 计划任务 ────────────────────────────────────────────────────────

it.runIf(win)('WIN-10 计划任务：注册可见 / Interactive+Limited+Hidden / 卸载后彻底消失', async () => {
  const root = scratch('pi task ')
  const wsRoot = join(root, '中文 工作区')
  mkdirSync(wsRoot, { recursive: true })
  const { path } = writeConfig(root, { workerId: 'pi-task-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    adapters: {}, workspaces: [{ id: 'repo', label: 'Repo', path: wsRoot, allowedAdapters: ['mock'], maxProfile: 'readonly' }] })
  const task = 'AgentWorkerPiTest_' + randomUUID().slice(0, 8)
  const currentSid = ps('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value')
  const queryXml = () => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'),
    ['/Query', '/TN', task, '/XML'], { encoding: 'buffer', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const queryText = () => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'),
    ['/Query', '/TN', task], { encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exists = () => ps(`
$task = Get-ScheduledTask -TaskName ${psLiteral(task)} -TaskPath '\\' -ErrorAction SilentlyContinue
if ($null -eq $task) { 'absent' } else { 'present' }
`)

  try {
    expect(await main(['install-task', '--config', path, '--task-name', task])).toBe(0)
    expect(exists()).toBe('present')

    // schtasks /Query 直接确认存在
    expect(queryText()).toContain(task)

    const xml = decodeWindows(queryXml())
    expect(xml).toContain('<LogonTrigger>')
    // 登录用户身份、交互式令牌（不是 SYSTEM / ServiceAccount / Password）
    expect(xml).toMatch(/<LogonType>Interactive(?:Token|\/InteractiveToken)?<\/LogonType>/u)
    expect(xml).not.toContain('<LogonType>ServiceAccount</LogonType>')
    expect(xml).not.toContain('<LogonType>Password</LogonType>')
    expect(xml).not.toContain('<LogonType>S4U</LogonType>')
    // Limited（LeastPrivilege）：schtasks XML 会省略默认值，改用 Export-ScheduledTask 核实
    const exported = ps(`(Get-ScheduledTask -TaskName ${psLiteral(task)} -TaskPath '\\' | Export-ScheduledTask)`)
    expect(exported).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(exported).not.toContain('HighestAvailable')
    expect(xml).not.toContain('<RunLevel>HighestAvailable</RunLevel>')
    expect(xml).not.toContain('<RunLevel>LUA</RunLevel>')
    // 隐藏窗口
    expect(xml).toMatch(/<Hidden>true<\/Hidden>/u)
    // 失败重启：1 分钟 / 999 次
    const restart = /<RestartOnFailure>([\s\S]*?)<\/RestartOnFailure>/u.exec(xml)?.[1]
    expect(restart).toContain('<Interval>PT1M</Interval>')
    expect(restart).toContain('<Count>999</Count>')

    // 主体 / 触发器的用户必须是当前登录用户（不勾选“不管用户是否登录都要运行”）
    const principal = ps(`
$task = Get-ScheduledTask -TaskName ${psLiteral(task)} -TaskPath '\\'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner = ([System.Security.Principal.NTAccount] $task.Principal.UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value
$trigger = ([System.Security.Principal.NTAccount] $task.Triggers[0].UserId).Translate([System.Security.Principal.SecurityIdentifier]).Value
'{0}|{1}|{2}|{3}|{4}' -f $task.Principal.RunLevel, $task.Principal.LogonType, $owner, $trigger, $sid
`).split('|')
    expect(principal[0]).toBe('Limited')
    expect(principal[1]).toBe('Interactive')
    expect(principal[2]).toBe(currentSid)
    expect(principal[3]).toBe(currentSid)
    expect(principal[4]).toBe(currentSid)

    // 动作：隐藏窗口启动 node agent-worker.mjs run，且配置路径（含中文/空格）原样保留
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/u.exec(xml)?.[1]
    expect(encoded).toBeDefined()
    const launch = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(launch).toContain('agent-worker.mjs')
    expect(launch).toContain('worker 配置.yaml')
    expect(launch).toContain('-WindowStyle Hidden')
  } finally {
    // 铁律：无论断言如何失败，都必须卸载，不留垃圾计划任务
    try { await main(['uninstall-task', '--task-name', task]) } catch { /* 继续核对 */ }
  }

  expect(() => queryXml()).toThrow()
  expect(() => queryText()).toThrow()
  expect(exists()).toBe('absent')
}, 120_000)

// ── WIN-11 私钥 ACL ────────────────────────────────────────────────────────

it.runIf(win)('WIN-11 Ed25519 私钥：仅当前用户可读、无继承权限（icacls 实测）', () => {
  const root = scratch("pi key ' ")
  const key = join(root, "密钥 ' 中文.key")
  const identity = loadIdentity(key, true)
  expect(identity.privateKey.asymmetricKeyType).toBe('ed25519')
  expect(readFileSync(key, 'utf8')).toContain('BEGIN PRIVATE KEY')
  expect(identityPermissionsArePrivate(key)).toBe(true)

  const icacls = (args: string[] = []) => execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [key, ...args], { encoding: 'utf8', shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const listing = icacls()
  const aces = listing.split(/\r?\n/u).map(line => line.trim()).filter(line => line.includes(':'))
  // 只有一条显式 ACE，且没有任何继承项
  expect(aces).toHaveLength(1)
  expect(listing).not.toContain('(I)')
  expect(listing.toUpperCase()).not.toContain('BUILTIN\\ADMINISTRATORS')
  expect(listing.toUpperCase()).not.toContain('NT AUTHORITY\\SYSTEM')
  expect(listing.toUpperCase()).not.toContain('EVERYONE')
  expect(listing.toUpperCase()).not.toContain('BUILTIN\\USERS')

  const acl = ps(`
$path = ${psLiteral(key)}
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $path
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
'{0}|{1}|{2}|{3}' -f $acl.AreAccessRulesProtected, $rules.Count, $rules[0].IdentityReference.Value,
  (($rules[0].AccessControlType -eq 'Allow') -and (($rules[0].FileSystemRights -band
    [System.Security.AccessControl.FileSystemRights]::Read) -eq [System.Security.AccessControl.FileSystemRights]::Read))
`).split('|')
  expect(acl[0]).toBe('True')          // DACL 受保护：不继承
  expect(acl[1]).toBe('1')             // 只有一条规则
  expect(acl[2]).toBe(ps('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'))
  expect(acl[3]).toBe('True')

  // 破坏 ACL → 检测出问题；再次 loadIdentity 必须自动收紧
  icacls(['/grant', '*S-1-1-0:(R)'])
  expect(identityPermissionsArePrivate(key)).toBe(false)
  expect(loadIdentity(key).fingerprint).toBe(identity.fingerprint)
  expect(identityPermissionsArePrivate(key)).toBe(true)
  expect(icacls().toUpperCase()).not.toContain('EVERYONE')

  // 拒绝把目录当私钥
  expect(() => loadIdentity(root)).toThrow()
  // 非 Ed25519 私钥必须拒绝
  const wrong = join(root, 'wrong.key')
  writeFileSync(wrong, execFileSync(process.execPath, ['-e', `
const { generateKeyPairSync } = require('node:crypto')
process.stdout.write(generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
`], { encoding: 'utf8', shell: false, windowsHide: true }))
  expect(() => readIdentity(wrong)).toThrow(/Ed25519/u)
}, 60_000)

// ── doctor ────────────────────────────────────────────────────────────────

function codexOnPath(): boolean {
  try {
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['codex.exe'], { stdio: 'ignore' })
    return true
  } catch {
    try {
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), ['codex.cmd'], { stdio: 'ignore' })
      return true
    } catch { return false }
  }
}

it.runIf(win && codexOnPath())('doctor：结构化诊断 + 真实探测本机 codex-cli 0.166.0（不发起 LLM 请求）', async () => {
  const root = scratch('pi doctor ')
  const wsRoot = join(root, '中文 工作区 测试')
  mkdirSync(wsRoot, { recursive: true })
  const { path } = writeConfig(root, { workerId: 'pi-doctor-worker', hub: { url: 'ws://127.0.0.1:9/ws/worker' },
    adapters: { codex: { enabled: true } },
    workspaces: [{ id: 'repo', label: '中文 仓库', path: wsRoot, allowedAdapters: ['codex'], maxProfile: 'readonly' }] })
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  // 1) 身份缺失 → 结构化报告 + 非 0 退出码，且不得擅自生成文件
  expect(await main(['doctor', '--config', path])).toBe(1)
  const missing = JSON.parse(log.mock.lastCall![0]) as Record<string, unknown>
  expect(missing).toMatchObject({
    ok: false,
    node: { version: process.version, status: 'ok' },
    config: { status: 'ok', path },
    workspaces: [{ id: 'repo', path: realpathSync.native(wsRoot) }],
    workspaceStatus: 'ok',
    identity: { status: 'missing' },
    hub: { status: 'skipped' },
  })
  expect(existsSync(join(root, 'identity.key'))).toBe(false)
  const adapters = missing.adapters as Array<Record<string, unknown>>
  expect(adapters).toHaveLength(1)
  expect(adapters[0]).toMatchObject({ id: 'codex', version: expect.stringMatching(/^codex-cli \d+\.\d+\.\d+/u),
    features: { resume: true, liveInput: false, structuredOutput: true } })
  // 已登录的机器上必须是 ready；未登录时必须明确报 not authenticated（不能静默 ready）
  const codexReady = adapters[0]!.status === 'ready'
  if (!codexReady) expect(adapters[0]).toMatchObject({ status: 'error', error: 'not authenticated' })
  expect(String(adapters[0]!.binPath).toLowerCase()).toMatch(/node(\.exe)?$/u)
  const exe = adapters[0]!.exe as { command: string; prefixArgs: string[] }
  expect(exe.prefixArgs[0]).toMatch(/codex[\\/]bin[\\/]codex\.js$/iu)
  // jobObject / 节点都在报告里有明确状态
  expect(['ok', 'warning', 'not_applicable']).toContain((missing.jobObject as { status: string }).status)
  expect(Object.keys(missing).sort()).toEqual(['adapters', 'config', 'hub', 'identity', 'jobObject', 'node',
    'ok', 'workspaceStatus', 'workspaces'].sort())

  // 2) 生成身份后：适配器 ready 则全绿，否则只因未登录而失败
  loadIdentity(join(root, 'identity.key'), true)
  expect(await main(['doctor', '--config', path])).toBe(codexReady ? 0 : 1)
  const healthy = JSON.parse(log.mock.lastCall![0]) as Record<string, unknown>
  expect(healthy).toMatchObject({ ok: codexReady, identity: { status: 'ok', type: 'ed25519', acl: { status: 'ok' } } })

  // 3) --check-hub 不通时明确报错
  expect(await main(['doctor', '--config', path, '--check-hub'])).toBe(1)
  expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ hub: { status: 'error' } })

  // 4) --dump-help 的实采基线：exec 有 --sandbox，exec resume 没有
  expect(await main(['doctor', '--config', path, '--dump-help'])).toBe(codexReady ? 0 : 1)
  const dumped = JSON.parse(log.mock.lastCall![0]) as { adapters: Array<{ help?: Record<string, string> }> }
  const help = dumped.adapters[0]!.help!
  expect(help['exec --help']).toContain('--sandbox')
  expect(help['exec --help']).toMatch(/\[possible values: read-only, workspace-write, danger-full-access\]/u)
  expect(help['exec resume --help']).not.toContain('--sandbox')
  expect(help['exec resume --help']).toContain('-c, --config')
  expect(help['--help']).toContain('Usage: codex')
}, 120_000)

it('doctor：坏配置 / 缺失配置 / 工作区不存在都返回结构化失败而不是抛异常', async () => {
  const root = scratch('pi doctor bad ')
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  const missing = join(root, 'absent.yaml')
  expect(await doctor(missing, { dumpHelp: false, checkHub: false }))
    .toMatchObject({ ok: false, config: { status: 'missing' } })

  const broken = join(root, 'broken.yaml')
  writeFileSync(broken, 'workerId: [\n', 'utf8')
  expect(await doctor(broken, { dumpHelp: false, checkHub: false }))
    .toMatchObject({ ok: false, config: { status: 'error' } })

  const badWorkspace = join(root, 'bad-workspace.yaml')
  writeFileSync(badWorkspace, stringify({ workerId: 'pi-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    adapters: {}, workspaces: [{ id: 'repo', label: 'X', path: join(root, 'no-such-dir'), allowedAdapters: ['mock'],
      maxProfile: 'readonly' }] }), 'utf8')
  const report = await doctor(badWorkspace, { dumpHelp: false, checkHub: false })
  expect(report).toMatchObject({ ok: false, workspaceStatus: 'error' })
  expect(String((report as { workspaceError?: string }).workspaceError).length).toBeGreaterThan(0)

  // 环境/配置问题不得生成任何文件
  expect(log).not.toHaveBeenCalled()
  expect(existsSync(join(root, 'identity.key'))).toBe(false)
}, 60_000)
