/**
 * Pi 独立验收 · Phase 3 · AD-1 ~ AD-8（真实 CLI 适配器）
 *
 * 本文件刻意不使用 Codex `phase3-adapters.test.ts` 的断言方式：
 *  - AD-1 用「完整 argv 深度相等」而非 `toContain`，并用真实 codex 0.166.0 的 `--help`
 *    实采基线（`fixtures/codex/0.166.0`）反查每个 flag 是否真被该子命令支持；
 *  - AD-5 覆盖 Codex 未覆盖的 PATH 查找、坏 shim 家族、非法文件名；
 *  - AD-6 用真实子进程回读 argv，证明 argsOverride「真的传到了进程」且 stdin 未被破坏；
 *  - AD-7 额外断言并发上限与「快 adapter 不被慢 adapter 阻塞」。
 */
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { AgentEvent } from '@agent-hub/protocol'
import type { Profile } from '@agent-hub/protocol'
import { claudeCodeAdapter } from '../src/adapters/claude-code.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { geminiAdapter } from '../src/adapters/gemini.js'
import { opencodeAdapter } from '../src/adapters/opencode.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { resolveExe } from '../src/adapters/resolve-exe.js'
import type { CliAdapter, Invocation, InvocationInput, ParsedItem } from '../src/adapters/types.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import type { WorkerConfig } from '../src/config/schema.js'
import { createRunTempDir, recoverRunTempFiles, removeRunTempDir, writeRunTempFiles } from '../src/runner/temp-files.js'
import { spawnRun, writePrompt } from '../src/runner/spawn.js'

const win = process.platform === 'win32'
const adapters = [codexAdapter, claudeCodeAdapter, geminiAdapter, opencodeAdapter] as const
type RealId = 'codex' | 'claude-code' | 'gemini' | 'opencode'
const resumeFlagOf: Record<RealId, string> = { codex: 'resume', 'claude-code': '--resume', gemini: '--resume',
  opencode: '--session' }
const profiles: Profile[] = ['readonly', 'edit', 'full']
const exitOk = { code: 0, signal: null, timedOut: false, cancelled: false }
const tempDirs: string[] = []

function scratch(prefix = 'pi-ad-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
})

function configWith(overrides: Record<string, unknown> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({ workerId: 'pi-worker', hub: { url: 'ws://127.0.0.1:1/ws/worker' },
    workspaces: [], adapters: { codex: { enabled: true }, 'claude-code': { enabled: true },
      gemini: { enabled: true }, opencode: { enabled: true }, mock: { enabled: true } }, ...overrides })
}

const config = configWith()
/** 刻意包含参数注入载荷、CRLF 与中文，用来证明 prompt 只走 stdin。 */
const prompt = '-& calc.exe " | del %PATH% ^ %COMSPEC% 中文 🚀\r\n第二行\r\n'
const cwd = 'C:\\工作 区\\repo 空格'
const exe = { command: process.execPath, prefixArgs: ['/opt/pi/fake-cli.js'] }

function input(adapter: CliAdapter, overrides: Partial<InvocationInput> = {}): InvocationInput {
  return { exe, prompt, cwd, profile: 'readonly', extraArgs: [], adapterConfig: config.adapters[adapter.id], ...overrides }
}

// ── AD-1 期望 argv（严格照 06 §4.3 规格书写，不引用实现内部常量） ────────────────

const sandboxMode: Record<Profile, string> = {
  readonly: 'read-only', edit: 'workspace-write', full: 'danger-full-access',
}

function expectedArgs(id: RealId, profile: Profile, session?: string, model?: string): string[] {
  const modelArgs = model ? ['--model', model] : []
  if (id === 'codex') {
    const base = session ? ['exec', 'resume', session, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
    // 0.166.0 的 `exec resume` 没有 --sandbox / -C，只能用 -c 覆写 sandbox_mode。
    const policy = session ? ['-c', 'sandbox_mode=' + JSON.stringify(sandboxMode[profile])]
      : ['--sandbox', sandboxMode[profile]]
    return [...exe.prefixArgs, ...base, ...modelArgs, ...policy, '-']
  }
  if (id === 'claude-code') {
    return [...exe.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose',
      ...(session ? ['--resume', session] : []), ...modelArgs,
      ...({ readonly: ['--permission-mode', 'plan', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit'],
        edit: ['--permission-mode', 'acceptEdits'],
        full: ['--permission-mode', 'bypassPermissions'] }[profile])]
  }
  if (id === 'gemini') {
    return [...exe.prefixArgs, '--output-format', 'stream-json', ...modelArgs,
      ...(session ? ['--resume', session] : []),
      '--approval-mode', { readonly: 'default', edit: 'auto_edit', full: 'yolo' }[profile]]
  }
  return [...exe.prefixArgs, 'run', '--format', 'json', ...modelArgs, ...(session ? ['--session', session] : [])]
}

const injectionTokens = ['calc.exe', '%PATH%', 'COMSPEC', 'del ', '第二行', '中文', '🚀']

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))('AD-1 $id：profile×resume×model 全矩阵 argv 精确、prompt 只走 stdin',
  ({ adapter }) => {
    for (const profile of profiles) {
      for (const session of [undefined, 'sess-1']) {
        for (const model of [undefined, 'provider/model-x']) {
          const label = `${adapter.id}/${profile}/${session ?? 'fresh'}/${model ?? 'default'}`
          const invocation = adapter.buildInvocation(input(adapter, { profile,
            ...(session && { resumeSessionId: session }), ...(model && { model }) }))

          expect(invocation.stdin, label).toBe(prompt)
          expect(invocation.args, label).toEqual(expectedArgs(adapter.id as RealId, profile, session, model))
          expect(invocation.command, label).toBe(exe.command)

          // args 绝对不含 prompt：既不出现整段，也不出现任何注入片段。
          expect(invocation.args, label).not.toContain(prompt)
          for (const token of injectionTokens) {
            expect(invocation.args.some(arg => arg.includes(token)), `${label} leaked ${token}`).toBe(false)
          }
          for (const arg of invocation.args) {
            expect(arg, label).not.toMatch(/[\r\n]/u)
            expect(arg.length, label).toBeLessThan(1024)
          }
          const resumeFlag = resumeFlagOf[adapter.id as RealId]
          expect(invocation.args.includes(resumeFlag), label).toBe(Boolean(session))
          expect(invocation.args.includes('provider/model-x'), label).toBe(Boolean(model))
        }
      }
    }
  })

it('AD-1 extraArgs 追加在 profile 参数之后，且仍不触碰 stdin', () => {
  for (const adapter of adapters) {
    for (const profile of profiles) {
      const invocation = adapter.buildInvocation(input(adapter, { profile, extraArgs: ['--pi-extra', 'value-1'] }))
      expect(invocation.stdin).toBe(prompt)
      const index = invocation.args.indexOf('--pi-extra')
      expect(index, adapter.id).toBeGreaterThan(0)
      expect(invocation.args[index + 1], adapter.id).toBe('value-1')
      if (adapter.id === 'codex') expect(invocation.args.at(-1)).toBe('-')
      expect(invocation.args).not.toContain(prompt)
    }
  }
})

it('AD-1 超长 prompt（40 K 字符）完全留在 stdin，argv 长度保持常量级', () => {
  const huge = '中'.repeat(40_000)
  for (const adapter of adapters) {
    const invocation = adapter.buildInvocation(input(adapter, { prompt: huge, profile: 'edit' }))
    expect(invocation.stdin).toBe(huge)
    expect(invocation.args.join('\u0000').length).toBeLessThan(1024)
    expect(invocation.args.some(arg => arg.includes('中'))).toBe(false)
  }
})

/** 从真实 `--help` 文本里收集该子命令声明支持的 flag。 */
function helpFlags(text: string): Set<string> {
  const flags = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    for (const match of line.matchAll(/(?:^|[\s,])(--[A-Za-z][A-Za-z0-9-]*)/gu)) flags.add(match[1]!)
    for (const match of line.matchAll(/(?:^|[\s,])(-[A-Za-z])(?=[\s,])/gu)) flags.add(match[1]!)
  }
  return flags
}

const helpOf = (name: string) => readFileSync(new URL('./fixtures/codex/0.166.0/' + name, import.meta.url), 'utf8')

it('AD-1 codex 0.166.0 实采基线：argv 中每个 flag 都被对应子命令帮助声明支持', () => {
  const execHelp = helpOf('exec-help.txt')
  const resumeHelp = helpOf('exec-resume-help.txt')
  const execFlags = helpFlags(execHelp)
  const resumeFlags = helpFlags(resumeHelp)

  for (const flag of ['--json', '--skip-git-repo-check', '--sandbox', '-s', '-C', '--cd', '-c', '--config', '--model']) {
    expect(execFlags.has(flag), 'codex exec 未声明 ' + flag).toBe(true)
  }
  // 这条断言记录了「为什么续跑必须改用 -c sandbox_mode=...」——resume 子命令没有沙箱 flag。
  for (const flag of ['--sandbox', '-s', '-C', '--cd']) {
    expect(resumeFlags.has(flag), 'codex exec resume 不应声明 ' + flag).toBe(false)
  }
  for (const flag of ['--json', '--skip-git-repo-check', '-c', '--config', '--model']) {
    expect(resumeFlags.has(flag), 'codex exec resume 缺少 ' + flag).toBe(true)
  }

  const possible = /\[possible values: ([^\]]+)\]/u.exec(execHelp)?.[1]?.split(',').map(value => value.trim())
  expect(possible).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  // 两个子命令都明确支持以 `-` 占位从 stdin 读 prompt（prompt 不进入 argv 的前提）
  expect(execHelp).toMatch(/if `-` is used/u)
  expect(resumeHelp).toMatch(/If `-` is used, read from stdin/u)

  for (const profile of profiles) {
    for (const session of [undefined, 'sess-1']) {
      const invocation = codexAdapter.buildInvocation(input(codexAdapter,
        { profile, ...(session && { resumeSessionId: session }) }))
      const supported = session ? resumeFlags : execFlags
      for (const flag of invocation.args.filter(arg => arg.startsWith('-') && arg.length > 1)) {
        expect(supported.has(flag), (session ? 'resume' : 'exec') + ' 不支持 ' + flag).toBe(true)
      }
      // 沙箱取值必须落在实采的 possible values 内，且出现在 argv 的 policy 位置
      expect(invocation.args.join(' ')).toContain(sandboxMode[profile])
      expect(possible).toContain(sandboxMode[profile])
      if (session) {
        expect(invocation.args).toContain('-c')
        expect(invocation.args.join('\n')).toContain('sandbox_mode=' + JSON.stringify(sandboxMode[profile]))
      } else {
        expect(invocation.args[invocation.args.indexOf('--sandbox') + 1]).toBe(sandboxMode[profile])
      }
    }
  }
})

// ── AD-2 夹具回放 ────────────────────────────────────────────────────────────

const expectations = {
  codex: { types: ['thinking', 'command', 'file_change', 'tool_use', 'tool_use', 'error', 'message', 'usage'],
    summary: '完成', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3 },
    filesChanged: ['src/a.ts'], errorMessage: 'Transient warning' },
  'claude-code': { types: ['init', 'thinking', 'tool_use', 'tool_result', 'message', 'usage'],
    summary: '完成', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, costUsd: 0.02 },
    filesChanged: ['src/a.ts'], errorMessage: undefined },
  gemini: { types: ['init', 'message', 'tool_use', 'tool_result', 'message', 'usage'],
    summary: '完成', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3 },
    filesChanged: undefined, errorMessage: undefined },
  opencode: { types: ['message', 'tool_use', 'tool_result', 'usage', 'usage'],
    summary: '完成', usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3, costUsd: 0.02 },
    filesChanged: undefined, errorMessage: undefined },
} as const

it.each(adapters.map(adapter => ({ adapter, id: adapter.id, key: adapter.id as keyof typeof expectations })))
('AD-2 $id 夹具回放：AgentEvent 序列 / sessionId / summary / usage / filesChanged 全部精确', ({ adapter, key }) => {
  const expected = expectations[key]
  const lines = readFileSync(new URL('./fixtures/' + adapter.id + '/sample-stream.jsonl', import.meta.url), 'utf8')
    .trimEnd().split(/\r?\n/u)
  const parser = adapter.createParser()
  const items: ParsedItem[] = []
  for (const line of lines) items.push(...parser.onStdout(line))
  const outcome = parser.finish(exitOk, item => items.push(item))

  // 每个事件都必须能通过协议 schema（防止适配器产出越界文本/非法枚举）
  const events = items.flatMap(item => item.kind === 'agent' ? [AgentEvent.parse(item.event)] : [])
  expect(events.map(event => event.type)).toEqual(expected.types)
  for (const event of events) {
    if (event.type === 'message') expect(event.text.length).toBeLessThanOrEqual(16_000)
    if (event.type === 'tool_use') expect(event.summary.length).toBeLessThanOrEqual(1000)
    if (event.type === 'command') expect(event.command.length).toBeLessThanOrEqual(2000)
  }
  expect(items.filter(item => item.kind === 'session')).toEqual([{ kind: 'session', cliSessionId: 'session-1' }])
  const logs = items.filter(item => item.kind === 'log')
  expect(logs).toHaveLength(3)
  expect(logs.map(log => log.kind === 'log' && log.stream)).toEqual(['stdout', 'stdout', 'stdout'])

  expect(outcome.status).toBe('succeeded')
  expect(outcome.cliSessionId).toBe('session-1')
  expect(outcome.summary).toBe(expected.summary)
  expect(outcome.usage).toEqual(expected.usage)
  expect(outcome.filesChanged).toEqual(expected.filesChanged)
  expect(outcome.errorMessage).toBe(expected.errorMessage)
})

it('AD-2 summary 取自最终结果而非中间态；filesChanged 去重', () => {
  const parser = claudeCodeAdapter.createParser()
  parser.onStdout(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '中间态' }] } }))
  parser.onStdout(JSON.stringify({ type: 'result', subtype: 'success', result: '最终结论', is_error: false }))
  expect(parser.finish(exitOk).summary).toBe('最终结论')

  const codex = codexAdapter.createParser()
  for (const path of ['src/a.ts', 'src/a.ts', 'src/b.ts']) {
    codex.onStdout(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [{ path, kind: 'update' }] } }))
  }
  expect(codex.finish(exitOk).filesChanged).toEqual(['src/a.ts', 'src/b.ts'])
})

// ── AD-3 解析降级 ────────────────────────────────────────────────────────────

const badLines: Record<string, string[]> = {
  codex: ['{not json', '{"type":"no-such-event"}', '{"type":', '{"type":"thread.started"}'],
  'claude-code': ['{not json', '{"type":"no-such-event"}', '{"type":', '{"type":"assistant","message":{}}'],
  gemini: ['{not json', '{"type":"no-such-event"}', '{"type":', '{"type":"init"}'],
  opencode: ['{not json', '{"type":"no-such-event"}', '{"type":', '{"type":"text","sessionID":"session-1"}'],
}

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))('AD-3 $id：非法 JSON / 未知 type / 半截行 / 缺字段 全部安全降级为 log',
  ({ adapter }) => {
    const parser = adapter.createParser()
    for (const line of badLines[adapter.id]!) {
      expect(parser.onStdout(line), adapter.id + ' ' + line)
        .toEqual([{ kind: 'log', stream: 'stdout', text: line }])
    }
    expect(parser.onStderr('\u0000binary\u0001'))
      .toEqual([{ kind: 'log', stream: 'stderr', text: '\u0000binary\u0001' }])
    const outcome = parser.finish(exitOk)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.errorMessage).toContain('输出格式')
  })

it('AD-3 随机垃圾（NUL / 二进制 / 超长 / 非法转义）不抛异常，产出永远合法', () => {
  const garbage = ['', ' ', 'null', '[]', '"str"', '123', '{"type":{"nested":1}}', '\u0000\u0001\u0002',
    '{"type":"message","role":"assistant","text":"' + 'x'.repeat(5000) + '"}', '\u001b[31mansi\u001b[0m',
    '{"a":"\uD800"}', '{"type":"file_change","path":null}', '{"type":"usage","inputTokens":"12"}']
  for (const adapter of adapters) {
    const parser = adapter.createParser()
    for (const line of garbage) {
      let items: ParsedItem[] = []
      expect(() => { items = parser.onStdout(line) }, adapter.id + ' ' + JSON.stringify(line)).not.toThrow()
      for (const item of items!) {
        if (item.kind === 'agent') expect(() => AgentEvent.parse(item.event)).not.toThrow()
        else expect(['log', 'session', 'progress', 'input_request']).toContain(item.kind)
      }
    }
    expect(() => parser.finish(exitOk)).not.toThrow()
  }
})

// ── AD-4 高比例失败与终态判定 ────────────────────────────────────────────────

function goodLine(id: RealId, text: string): string {
  const shape: Record<RealId, unknown> = {
    codex: { type: 'item.completed', item: { type: 'agent_message', text } },
    'claude-code': { type: 'result', subtype: 'success', result: text, is_error: false },
    gemini: { type: 'message', role: 'assistant', content: text },
    opencode: { type: 'text', sessionID: 's1', part: { type: 'text', text } },
  }
  return JSON.stringify(shape[id])
}

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))(
  'AD-4 $id：解析失败率超过一半 + 退出码 0 → succeeded + 最后 50 行 summary + 格式告警', ({ adapter }) => {
    const parser = adapter.createParser()
    for (let i = 0; i < 10; i++) parser.onStdout(goodLine(adapter.id as RealId, 'ok ' + i))
    const tail: string[] = []
    for (let i = 0; i < 100; i++) {
      const line = 'noise-' + String(i).padStart(3, '0')
      tail.push(line)
      expect(parser.onStdout(line)).toEqual([{ kind: 'log', stream: 'stdout', text: line }])
    }
    const outcome = parser.finish(exitOk)
    expect(outcome.status).toBe('succeeded')
    expect(outcome.summary).toBe(tail.slice(-50).join('\n'))
    expect(outcome.errorMessage).toContain('输出格式无法识别')
    expect(outcome.errorMessage).toContain('CLI 版本可能不兼容')
    expect(outcome.errorCode).toBeUndefined()
  })

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))('AD-4 $id：解析失败率恰好一半不触发 summary 降级', ({ adapter }) => {
  const parser = adapter.createParser()
  for (let i = 0; i < 10; i++) parser.onStdout(goodLine(adapter.id as RealId, '正常摘要'))
  const tail: string[] = []
  for (let i = 0; i < 10; i++) { tail.push('bad-' + i); parser.onStdout('bad-' + i) }
  const outcome = parser.finish(exitOk)
  expect(outcome.status).toBe('succeeded')
  // 未退化：summary 来自结构化事件（gemini/opencode 会逐条追加），不是最后 50 行原文
  expect(outcome.summary).toContain('正常摘要')
  expect(outcome.summary).not.toBe(tail.join('\n'))
  expect(outcome.summary).not.toContain('bad-')
  expect(outcome.errorMessage ?? '').not.toContain('输出格式')
})

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))(
  'AD-4 $id：非 0 退出 / timedOut / cancelled 判定正确且不误报格式告警', ({ adapter }) => {
    const build = () => {
      const parser = adapter.createParser()
      for (let i = 0; i < 10; i++) parser.onStdout('garbage-' + i)
      return parser
    }
    const failed = build().finish({ code: 1, signal: null, timedOut: false, cancelled: false })
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('NONZERO_EXIT')
    expect(failed.errorMessage ?? '').not.toContain('输出格式')

    expect(build().finish({ code: null, signal: 'SIGKILL', timedOut: true, cancelled: false }).status).toBe('timed_out')
    expect(build().finish({ code: null, signal: 'SIGKILL', timedOut: false, cancelled: true }).status).toBe('cancelled')
    expect(build().finish({ code: null, signal: 'SIGKILL', timedOut: false, cancelled: false }).status).toBe('failed')
  })

it.each([
  [codexAdapter, { type: 'turn.failed', error: { message: 'turn boom' } }],
  [claudeCodeAdapter, { type: 'result', is_error: true, result: 'claude boom' }],
  [geminiAdapter, { type: 'result', status: 'error', error: { message: 'gemini boom' } }],
  [opencodeAdapter, { type: 'error', sessionID: 's1', error: { data: { message: 'opencode boom' } } }],
] as const)('AD-4 结构化致命失败在退出码 0 下仍判 failed（%#）', (adapter, line) => {
  const parser = adapter.createParser()
  parser.onStdout(JSON.stringify(line))
  const outcome = parser.finish(exitOk)
  expect(outcome.status).toBe('failed')
  expect(outcome.errorCode).toBe('ADAPTER_ERROR')
  expect(outcome.errorMessage).toBeTruthy()
})

it('AD-4 codex 顶层 error 事件是非致命告警：按规格仍是 succeeded（只有 turn.failed 才失败）', () => {
  const parser = codexAdapter.createParser()
  expect(parser.onStdout(JSON.stringify({ type: 'error', message: 'stream boom' })))
    .toEqual([{ kind: 'agent', event: { type: 'error', message: 'stream boom', fatal: false } }])
  const outcome = parser.finish(exitOk)
  expect(outcome.status).toBe('succeeded')
  expect(outcome.errorMessage).toBe('stream boom')
  expect(codexAdapter.createParser().finish({ ...exitOk, code: 2 }).status).toBe('failed')
})

it('AD-4 非致命 warning 只记 errorMessage，不影响 succeeded', () => {
  const parser = codexAdapter.createParser()
  parser.onStdout(JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'transient' } }))
  const outcome = parser.finish(exitOk)
  expect(outcome.status).toBe('succeeded')
  expect(outcome.errorMessage).toBe('transient')
})

// ── AD-5 resolve-exe ────────────────────────────────────────────────────────

it('AD-5 显式 command：绝对可执行路径通过；相对/不存在一律 error', () => {
  const dir = scratch('pi-resolve-')
  const exePath = join(dir, win ? 'mycli.exe' : 'mycli')
  writeFileSync(exePath, '', { mode: 0o700 })
  expect(resolveExe('mycli', { command: exePath })).toEqual({ status: 'ready', exe: { command: exePath, prefixArgs: [] } })
  expect(resolveExe('mycli', { command: 'mycli' }).status).toBe('error')
  expect(resolveExe('mycli', { command: join(dir, 'missing.exe') }).status).toBe('error')
  expect(resolveExe('mycli', { command: dir }).status).toBe('error')
})

it.runIf(win)('AD-5 显式 command 的扩展名白名单：.txt/.bat 拒绝（规避 CVE-2024-27980）', () => {
  const dir = scratch('pi-resolve-ext-')
  for (const name of ['tool.txt', 'tool.bat', 'tool.ps1']) {
    const path = join(dir, name)
    writeFileSync(path, '')
    expect(resolveExe('tool', { command: path }).status, name).toBe('error')
  }
})

it('AD-5 PATH 查找：原生可执行文件命中，缺失返回 missing，非法名返回 error', () => {
  const dir = scratch('pi-path-')
  const native = join(dir, win ? 'pi-cli.exe' : 'pi-cli')
  writeFileSync(native, '', { mode: 0o700 })
  expect(resolveExe('pi-cli', { path: dir })).toEqual({ status: 'ready', exe: { command: native, prefixArgs: [] } })
  expect(resolveExe('pi-cli', { path: '"' + dir + '"' })).toMatchObject({ status: 'ready' })
  expect(resolveExe('pi-cli', { path: [join(dir, 'nope'), dir].join(win ? ';' : ':') })).toMatchObject({ status: 'ready' })
  expect(resolveExe('not-here', { path: dir })).toEqual({ status: 'missing' })
  expect(resolveExe('../escape', { path: dir }).status).toBe('error')
  expect(resolveExe('..', { path: dir }).status).toBe('error')
  expect(resolveExe('has space', { path: dir }).status).toBe('error')
})

it.runIf(win)('AD-5 Windows .cmd shim：解析出 node + 脚本；坏 shim 家族一律 error（绝不 shell 执行）', () => {
  const dir = scratch('pi-shim-')
  const bin = join(dir, 'node_modules', 'cli', 'bin')
  mkdirSync(bin, { recursive: true })
  const target = join(bin, 'main.js')
  writeFileSync(target, '#!/usr/bin/env node\n')
  writeFileSync(join(bin, 'other.js'), '')
  const npmShim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n'
    + 'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n'
    + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\cli\\bin\\main.js" %*\r\n'
  const shim = join(dir, 'pi-shim.cmd')
  writeFileSync(shim, npmShim)

  const ready = { status: 'ready', exe: { command: process.execPath, prefixArgs: [target] } }
  expect(resolveExe('pi-shim', { path: dir })).toEqual(ready)
  expect(resolveExe('pi-shim', { command: shim })).toEqual(ready)
  expect(resolveExe('pi-shim.cmd', { path: dir })).toEqual(ready)
  // shim 同目录若有 node.exe 则优先使用它
  writeFileSync(join(dir, 'node.exe'), '')
  expect(resolveExe('pi-shim', { command: shim })).toEqual({ status: 'ready', exe: { command: join(dir, 'node.exe'), prefixArgs: [target] } })
  writeFileSync(join(dir, 'native.exe'), '')
  const nativeShim = join(dir, 'pi-native.cmd')
  writeFileSync(nativeShim, '@ECHO off\r\n"%dp0%\\native.exe"   %*\r\n')
  expect(resolveExe('pi-native', { command: nativeShim })).toEqual({ status: 'ready', exe: { command: join(dir, 'native.exe'), prefixArgs: [] } })

  const bad: Array<[string, string]> = [
    ['bad-two.cmd', 'node "%~dp0\\node_modules\\cli\\bin\\main.js" %*\r\nnode "%~dp0\\node_modules\\cli\\bin\\other.js" %*\r\n'],
    ['bad-escape.cmd', 'node "%~dp0\\..\\evil.js" %*\r\n'],
    ['bad-nothing.cmd', '@echo off\r\n'],
    ['bad-missing.cmd', 'node "%~dp0\\node_modules\\cli\\bin\\gone.js" %*\r\n'],
    ['bad-huge.cmd', '@echo off\r\n' + 'REM pad\r\n'.repeat(10_000) + 'node "%~dp0\\node_modules\\cli\\bin\\main.js" %*\r\n'],
    ['bad-native.cmd', '"%dp0%\\..\\native.exe" %*\r\n'],
    ['bad-empty.cmd', ''],
  ]
  for (const [name, body] of bad) {
    const path = join(dir, name)
    writeFileSync(path, body)
    expect(resolveExe('bad', { command: path }), name).toMatchObject({ status: 'error',
      error: expect.stringContaining('adapters.<id>.command') })
  }
})

it.runIf(win)('AD-5 npm shim：从隔离 PATH 将 codex 解析到 node + codex.js（不使用 shell）', () => {
  const dir = scratch()
  const bin = join(dir, 'node_modules', '@openai', 'codex', 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'codex.js'), '')
  writeFileSync(join(dir, 'codex.cmd'), '"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
  const resolved = resolveExe('codex', { path: dir })
  expect(resolved.status).toBe('ready')
  if (resolved.status !== 'ready') return
  expect(resolved.exe.command.toLowerCase()).toMatch(/node(\.exe)?$/u)
  expect(resolved.exe.prefixArgs).toHaveLength(1)
  expect(resolved.exe.prefixArgs[0]).toMatch(/codex[\\/]bin[\\/]codex\.js$/iu)
})

// ── AD-6 argsOverride 真实生效（回读真实子进程 argv） ─────────────────────────

async function argvOf(invocation: Invocation, dir: string): Promise<{ argv: string[]; stdin: string; cwd: string }> {
  const script = join(dir, 'fake-cli.cjs')
  const capture = join(dir, 'capture.json')
  writeFileSync(script, `
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ argv: process.argv.slice(4), stdin, cwd: process.cwd() }));
});
`)
  const child = spawnRun({ ...invocation, command: process.execPath,
    args: [script, '--', capture, ...invocation.args] }, dir, process.env)
  writePrompt(child, invocation.stdin, false)
  await once(child, 'close')
  return JSON.parse(readFileSync(capture, 'utf8'))
}

it.each(adapters.map(adapter => ({ adapter, id: adapter.id })))(
  'AD-6 $id：argsOverride 覆盖 profile 参数且真实传到进程，stdin 不被破坏', async ({ adapter }) => {
    const dir = scratch('pi-override-')
    for (const profile of profiles) {
      const invocation = adapter.buildInvocation(input(adapter, { profile, cwd: dir,
        adapterConfig: { ...config.adapters[adapter.id], argsOverride: { [profile]: ['--pi-override', profile] } } }))
      expect(invocation.stdin).toBe(prompt)
      expect(invocation.args).toContain('--pi-override')
      for (const flag of ['--sandbox', '--approval-mode', '--permission-mode', '--disallowedTools']) {
        expect(invocation.args, adapter.id + '/' + profile).not.toContain(flag)
      }
      const observed = await argvOf(invocation, dir)
      expect(observed.argv).toEqual(invocation.args)
      expect(observed.stdin).toBe(prompt)
      expect(observed.cwd).toBe(dir)
      expect(observed.argv.join(' ')).toContain('--pi-override ' + profile)
      if (adapter.id === 'gemini') expect(invocation.args).toContain('--output-format')
      if (adapter.id === 'codex') expect(invocation.args.at(-1)).toBe('-')
    }
  })

it('AD-6 只覆盖对应的 profile；gemini 用 -o 覆盖时抑制默认 --output-format', () => {
  const dir = scratch('pi-override2-')
  const scoped = geminiAdapter.buildInvocation(input(geminiAdapter, { profile: 'edit', cwd: dir,
    adapterConfig: { ...config.adapters.gemini, argsOverride: { readonly: ['--approval-mode', 'default'] } } }))
  expect(scoped.args).toContain('auto_edit')
  const custom = geminiAdapter.buildInvocation(input(geminiAdapter, { profile: 'edit', cwd: dir,
    adapterConfig: { ...config.adapters.gemini, argsOverride: { edit: ['-o', 'json', '--approval-mode', 'default'] } } }))
  expect(custom.args).toContain('-o')
  expect(custom.args).not.toContain('--output-format')
  expect(custom.args).not.toContain('auto_edit')
})

it('AD-6 opencode：argsOverride 之外的临时配置仍按 profile 生成', () => {
  const expectedPermission = {
    readonly: { edit: 'deny', bash: 'deny', external_directory: 'deny' },
    edit: { edit: 'allow', bash: 'ask', external_directory: 'deny' },
    full: { '*': 'allow' },
  }
  for (const profile of profiles) {
    const invocation = opencodeAdapter.buildInvocation(input(opencodeAdapter, { profile,
      adapterConfig: { ...config.adapters.opencode, argsOverride: { [profile]: ['--pi-override'] } } }))
    expect(invocation.args).toContain('--pi-override')
    const file = invocation.tempFiles?.[0]
    expect(file?.path).toBe('opencode.json')
    expect((JSON.parse(file!.content) as { permission: unknown }).permission).toEqual(expectedPermission[profile])
    expect(invocation.env.OPENCODE_CONFIG).toBe('opencode.json')
  }
})

// ── AD-7 probe 超时与并发 ───────────────────────────────────────────────────

/** 生成一个 npm 风格 .cmd shim（Windows）或带 shebang 的脚本（POSIX）。 */
function fakeCli(dir: string, name: string, source: string): string {
  const script = join(dir, name + '.cjs')
  writeFileSync(script, source)
  if (!win) {
    const path = join(dir, name)
    writeFileSync(path, '#!' + process.execPath + '\n' + source, { mode: 0o700 })
    return path
  }
  const shim = join(dir, name + '.cmd')
  writeFileSync(shim, '@ECHO off\r\n"%_prog%" "%~dp0\\' + name + '.cjs" %*\r\n')
  return shim
}

it('AD-7 假 CLI sleep 10 s：5 s 准确超时且不阻塞其他并行 adapter', async () => {
  const dir = scratch('pi-probe-')
  const cfg = configWith({ adapters: {
    codex: { enabled: true, command: fakeCli(dir, 'slow', 'setTimeout(() => console.log("9.9.9"), 10000)') },
    gemini: { enabled: true, command: fakeCli(dir, 'fast', 'console.log(process.argv[2] === "--version" ? "gemini 1.2.3" : "help")') },
    'claude-code': { enabled: false }, opencode: { enabled: false }, mock: { enabled: false },
  } })
  const registry = new AdapterRegistry(cfg)
  const started = Date.now()
  const done = registry.probe()
  await vi.waitFor(() => expect(registry.get('gemini')?.result.status).toBe('ready'), { timeout: 4000 })
  // 快适配器在慢适配器超时之前就已经 ready（未被串行阻塞）
  expect(registry.get('codex')).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(4500)
  await done
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(4800)
  expect(elapsed).toBeLessThan(8000)
  expect(registry.get('codex')?.result).toMatchObject({ status: 'error', error: expect.stringContaining('5 s') })
  expect(registry.get('gemini')?.result).toMatchObject({ status: 'ready', version: 'gemini 1.2.3' })
}, 20_000)

it('AD-7 注册表并发上限 ≤ 2（实测同时在跑的 probe 数）', async () => {
  let running = 0, peak = 0
  const make = (id: RealId) => ({ ...codexAdapter, id, features: codexAdapter.features,
    probe: async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 40))
      running--
      return { status: 'ready' as const, version: '1.0.0' }
    } })
  const ids: RealId[] = ['codex', 'claude-code', 'gemini', 'opencode']
  const registry = new AdapterRegistry(config, [...ids.map(make), { ...codexAdapter, id: 'mock' as const,
    probe: async () => { running++; peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 40)); running--
      return { status: 'ready' as const, version: '0.1.0' } } }])
  const capabilities = await registry.probe()
  expect(peak).toBeLessThanOrEqual(2)
  expect(peak).toBeGreaterThanOrEqual(1)
  expect(capabilities).toHaveLength(5)
  expect(capabilities.every(item => item.status === 'ready')).toBe(true)
})

it('AD-7 probe 抛异常被吞掉并降级为 error（不抛给调用方）', async () => {
  const cfg = configWith({ adapters: { codex: { enabled: true }, 'claude-code': { enabled: false },
    gemini: { enabled: false }, opencode: { enabled: false }, mock: { enabled: false } } })
  const registry = new AdapterRegistry(cfg, [{ ...codexAdapter, probe: async () => { throw new Error('boom') } }])
  await expect(registry.probe()).resolves.toBeDefined()
  expect(registry.get('codex')?.result).toMatchObject({ status: 'error' })
})

// ── AD-8 Gemini delta 合并 ─────────────────────────────────────────────────

it('AD-8 1000 个 delta 合并为 ≤ 20 个 message，正文零丢失，遇 tool_use 立即冲刷', () => {
  vi.useFakeTimers()
  try {
    const parser = geminiAdapter.createParser()
    const delta = (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content })
    const items: ParsedItem[] = []
    for (let i = 0; i < 1000; i++) items.push(...parser.onStdout(delta('词 ')))
    expect(items).toHaveLength(0)

    vi.advanceTimersByTime(501)
    const flushed = parser.flushPending!()
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toMatchObject({ kind: 'agent', event: { type: 'message', role: 'assistant' } })
    items.push(...flushed)

    // tool_use 前的 pending 必须立刻冲刷，且顺序为 [message, tool_use]
    expect(parser.onStdout(delta('末段'))).toHaveLength(0)
    const toolItems = parser.onStdout(JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { p: 'a' } }))
    expect(toolItems.map(item => item.kind === 'agent' ? item.event.type : item.kind)).toEqual(['message', 'tool_use'])
    items.push(...toolItems)

    expect(parser.onStdout(delta('尾巴'))).toHaveLength(0)
    const outcome = parser.finish(exitOk, item => items.push(item))

    const messages = items.filter(item => item.kind === 'agent' && item.event.type === 'message')
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.length).toBeLessThanOrEqual(20)
    const text = messages.flatMap(item => item.kind === 'agent' && item.event.type === 'message' ? [item.event.text] : []).join('')
    expect(text).toBe('词 '.repeat(1000) + '末段' + '尾巴')
    expect(outcome.summary).toBe(text)
    expect(outcome.status).toBe('succeeded')
  } finally { vi.useRealTimers() }
})

it('AD-8 超长 delta 不丢字，分块仍在协议上限内', () => {
  const parser = geminiAdapter.createParser()
  const chunk = '字'.repeat(4000)
  const items: ParsedItem[] = []
  for (let i = 0; i < 5; i++) {
    items.push(...parser.onStdout(JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: chunk })))
  }
  items.push(...parser.flushPending!())
  const outcome = parser.finish(exitOk, item => items.push(item))
  const texts = items.flatMap(item => item.kind === 'agent' && item.event.type === 'message' ? [item.event.text] : [])
  expect(texts.join('')).toBe(chunk.repeat(5))
  for (const text of texts) expect(text.length).toBeLessThanOrEqual(16_000)
  expect(outcome.summary).toBe(chunk.repeat(5))
})

// ── opencode 临时权限配置：权限与异常路径清理 ────────────────────────────────

it('opencode tempFiles：0o600 落盘、env 改写为绝对路径、内容即 profile 权限', () => {
  const root = scratch('pi-temp-')
  const invocation = opencodeAdapter.buildInvocation(input(opencodeAdapter, { profile: 'readonly' }))
  const dir = createRunTempDir(join(root, 'tmp'))
  try {
    const env: NodeJS.ProcessEnv = {}
    writeRunTempFiles(dir, invocation, env)
    const path = join(dir, 'opencode.json')
    const written = JSON.parse(readFileSync(path, 'utf8')) as { permission: unknown }
    expect(written.permission).toEqual({ edit: 'deny', bash: 'deny', external_directory: 'deny' })
    expect(env.OPENCODE_CONFIG).toBe(path)
    if (!win) expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toMatch(/sk-|BEGIN .*PRIVATE KEY/u)
  } finally { removeRunTempDir(dir) }
})

it('opencode tempFiles：穿越/分层文件名拒绝落盘且不写任何文件', () => {
  const root = scratch('pi-temp2-')
  const outside = join(root, 'escape.json')
  const dir = createRunTempDir(join(root, 'tmp'))
  const invocation = opencodeAdapter.buildInvocation(input(opencodeAdapter, { profile: 'edit' }))
  try {
    const env: NodeJS.ProcessEnv = {}
    for (const bad of ['../escape.json', 'a/b.json', '.', '..', '']) {
      expect(() => writeRunTempFiles(dir, { ...invocation,
        tempFiles: [{ path: bad, content: '{}' }] }, env), JSON.stringify(bad)).toThrow(/Invalid Run temp filename/u)
    }
  } finally { removeRunTempDir(dir) }
  expect(existsSync(outside)).toBe(false)
})

it('opencode tempFiles：Worker 重启回收只删 run-* 残留目录，保留无关目录且幂等', () => {
  const root = scratch('pi-temp3-')
  const tmp = join(root, 'tmp')
  const stale = createRunTempDir(tmp)
  const stale2 = createRunTempDir(tmp)
  writeFileSync(join(stale, 'opencode.json'), '{}')
  const keep = join(tmp, 'keep-me')
  mkdirSync(keep)
  writeFileSync(join(keep, 'x'), 'x')
  const other = join(tmp, 'run-toolongname')
  mkdirSync(other)
  recoverRunTempFiles(tmp)
  expect(existsSync(stale)).toBe(false)
  expect(existsSync(stale2)).toBe(false)
  expect(existsSync(keep)).toBe(true)
  expect(existsSync(other)).toBe(true)
  expect(() => recoverRunTempFiles(tmp)).not.toThrow()
  expect(() => recoverRunTempFiles(join(root, 'absent'))).not.toThrow()
})

it('opencode tempFiles：removeRunTempDir 幂等（spawn 失败 / 取消后重复清理不抛）', () => {
  const root = scratch('pi-temp4-')
  const dir = createRunTempDir(root)
  writeFileSync(join(dir, 'opencode.json'), '{}')
  expect(() => removeRunTempDir(dir)).not.toThrow()
  expect(() => removeRunTempDir(dir)).not.toThrow()
  expect(existsSync(dir)).toBe(false)
})
