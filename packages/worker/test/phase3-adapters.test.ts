import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentEvent } from '@agent-hub/protocol'
import { resolveExe } from '../src/adapters/resolve-exe.js'
import { claudeCodeAdapter } from '../src/adapters/claude-code.js'
import { codexAdapter } from '../src/adapters/codex.js'
import { geminiAdapter } from '../src/adapters/gemini.js'
import { opencodeAdapter } from '../src/adapters/opencode.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { InvocationInput, ParsedItem } from '../src/adapters/types.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

const adapters = [codexAdapter, claudeCodeAdapter, geminiAdapter, opencodeAdapter]
const config = WorkerConfigSchema.parse({ workerId: 'test-worker', hub: { url: 'ws://localhost/ws/worker' },
  workspaces: [], adapters: { codex: { enabled: true }, gemini: { enabled: true }, opencode: { enabled: true } } })
const cwd = join(process.cwd(), '中文 工作区')
const prompt = '-& calc.exe " | del %PATH% ^ \n中文'
const exit = { code: 0, signal: null, timedOut: false, cancelled: false }
const expectedTypes = [
  ['thinking', 'command', 'file_change', 'tool_use', 'tool_use', 'error', 'message', 'usage'],
  ['init', 'thinking', 'tool_use', 'tool_result', 'message', 'usage'],
  ['init', 'message', 'tool_use', 'tool_result', 'message', 'usage'],
  ['message', 'tool_use', 'tool_result', 'usage', 'usage'],
]

it.each(adapters)('constructs %s invocations with stdin, profile defaults and overrides', adapter => {
  for (const profile of ['readonly', 'edit', 'full'] as const) {
    for (const resumeSessionId of [undefined, 'session-1']) {
      for (const model of [undefined, 'example/model']) {
        const input: InvocationInput = { exe: { command: process.execPath, prefixArgs: ['cli.js'] },
          cwd, prompt, profile, adapterConfig: config.adapters[adapter.id], extraArgs: ['--local-opt'],
          ...(resumeSessionId && { resumeSessionId }), ...(model && { model }) }
        const invocation = adapter.buildInvocation(input)
        expect(invocation.stdin).toBe(prompt)
        expect(invocation.command).toBe(process.execPath)
        expect(invocation.args[0]).toBe('cli.js')
        expect(invocation.args).not.toContain(prompt)
        expect(invocation.args).toContain('--local-opt')
        expect(invocation.args.includes('example/model')).toBe(!!model)
        expect(invocation.args.includes('session-1')).toBe(!!resumeSessionId)
        if (adapter.id === 'codex') {
          const mode = { readonly: 'read-only', edit: 'workspace-write', full: 'danger-full-access' }[profile]
          const base = resumeSessionId ? ['exec', 'resume', resumeSessionId, '--json', '--skip-git-repo-check']
            : ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
          const policy = resumeSessionId ? ['-c', 'sandbox_mode=' + JSON.stringify(mode)] : ['--sandbox', mode]
          expect(invocation.args).toEqual(['cli.js', ...base, ...(model ? ['--model', model] : []), ...policy, '--local-opt', '-'])
        }
        if (adapter.id === 'claude-code') {
          expect(invocation.args).toContain({ readonly: 'plan', edit: 'acceptEdits', full: 'bypassPermissions' }[profile])
        }
        if (adapter.id === 'gemini') {
          expect(invocation.args).toContain({ readonly: 'default', edit: 'auto_edit', full: 'yolo' }[profile])
        }
        if (adapter.id === 'opencode') {
          expect(invocation.tempFiles?.[0]?.content).toContain('"permission"')
          expect(invocation.env.OPENCODE_CONFIG).toBe(invocation.tempFiles?.[0]?.path)
        }
        const overridden = adapter.buildInvocation({ ...input, adapterConfig: {
          ...input.adapterConfig, argsOverride: { [profile]: ['--local-profile'] },
        } })
        expect(overridden.args).toContain('--local-profile')
        expect(overridden.args).not.toContain('--sandbox')
        expect(overridden.args).not.toContain('--approval-mode')
        expect(overridden.args).not.toContain('--permission-mode')
      }
    }
  }
})

it('times out a real slow version process while finishing a healthy probe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase3-probe-'))
  const slowScript = 'setTimeout(() => console.log("9.9.9"), 10000)'
  const fastScript = 'console.log(process.argv[2] === "--version" ? "gemini 1.2.3" : "--help output")'
  try {
    const writeCommand = (name: string, source: string) => {
      if (process.platform === 'win32') {
        writeFileSync(join(dir, name + '.cjs'), source)
        const shim = join(dir, name + '.cmd')
        writeFileSync(shim, '@echo off\r\nnode "%~dp0\\' + name + '.cjs" %*\r\n')
        return shim
      }
      const path = join(dir, name)
      writeFileSync(path, '#!' + process.execPath + '\n' + source, { mode: 0o700 })
      return path
    }
    const cfg = { ...config, adapters: { ...config.adapters,
      codex: { ...config.adapters.codex, command: writeCommand('slow', slowScript) },
      gemini: { ...config.adapters.gemini, command: writeCommand('fast', fastScript) },
      opencode: { ...config.adapters.opencode, enabled: false },
    } }
    const registry = new AdapterRegistry(cfg)
    const started = Date.now()
    const done = registry.probe()
    await vi.waitFor(() => expect(registry.get('gemini')?.result).toMatchObject({ status: 'ready', version: 'gemini 1.2.3' }),
      { timeout: 3000 })
    expect(registry.get('codex')).toBeUndefined()
    await done
    expect(Date.now() - started).toBeLessThan(8000)
    expect(registry.get('codex')?.result).toMatchObject({ status: 'error', error: expect.stringContaining('5 s') })
    const exe = registry.get('gemini')!.result.exe!
    expect(await geminiAdapter.dumpHelp!(exe, AbortSignal.timeout(5000), cfg.adapters.gemini))
      .toEqual({ '--help': '--help output' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 12_000)

it.runIf(process.platform === 'win32')('resolves a native npm shim directly to its .exe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase3-native-shim-'))
  try {
    const path = join(dir, 'claude.cmd')
    const exe = join(dir, 'claude-native.exe')
    writeFileSync(exe, '')
    writeFileSync(path, '@ECHO off\r\n"%dp0%\\claude-native.exe"   %*\r\n')
    expect(resolveExe('claude', { command: path })).toEqual({ status: 'ready', exe: { command: exe, prefixArgs: [] } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each(adapters.map((adapter, index) => ({ adapter, index })))('replays $adapter.id and degrades malformed lines', ({ adapter, index }) => {
  const lines = readFileSync(new URL('./fixtures/' + adapter.id + '/sample-stream.jsonl', import.meta.url), 'utf8').trimEnd().split(/\r?\n/)
  const parser = adapter.createParser()
  const events = lines.flatMap(line => parser.onStdout(line))
  const result = parser.finish(exit, event => events.push(event))
  const agent = events.flatMap(item => item.kind === 'agent' ? [AgentEvent.parse(item.event)] : [])
  expect(agent.map(item => item.type)).toEqual(expectedTypes[index])
  expect(events.filter(item => item.kind === 'session')).toEqual([{ kind: 'session', cliSessionId: 'session-1' }])
  expect(events.filter(item => item.kind === 'log')).toHaveLength(3)
  expect(result).toMatchObject({ status: 'succeeded', cliSessionId: 'session-1', summary: '完成',
    usage: { inputTokens: 12, outputTokens: 5 } })
  if (index <= 1) expect(result.filesChanged).toEqual(['src/a.ts'])
  const invalid = adapter.createParser()
  for (let i = 0; i < 55; i++) expect(invalid.onStdout('invalid ' + i)).toEqual([{ kind: 'log', stream: 'stdout', text: 'invalid ' + i }])
  expect(invalid.finish(exit)).toMatchObject({ status: 'succeeded', errorMessage: expect.stringContaining('输出格式'),
    summary: Array.from({ length: 50 }, (_, i) => 'invalid ' + (i + 5)).join('\n') })
  expect(adapter.createParser().finish({ ...exit, code: 1 }).status).toBe('failed')
})

it.each([
  [codexAdapter, { type: 'turn.failed', error: { message: 'boom' } }],
  [claudeCodeAdapter, { type: 'result', is_error: true, result: 'boom' }],
  [geminiAdapter, { type: 'result', status: 'error', error: { message: 'boom' } }],
  [opencodeAdapter, { type: 'error', sessionID: 'session-1', error: { data: { message: 'boom' } } }],
] as const)('uses structured terminal failure even with exit 0', (adapter, line) => {
  const parser = adapter.createParser()
  parser.onStdout(JSON.stringify(line))
  expect(parser.finish(exit)).toMatchObject({ status: 'failed', errorCode: 'ADAPTER_ERROR', errorMessage: 'boom' })
})

it('coalesces 1000 Gemini deltas and preserves ordering, timed flush and the final tail', () => {
  vi.useFakeTimers()
  try {
    const parser = geminiAdapter.createParser()
    const delta = (content: string) => JSON.stringify({ type: 'message', role: 'assistant', delta: true, content })
    const events: ParsedItem[] = []
    for (let i = 0; i < 1000; i++) events.push(...parser.onStdout(delta('词 ')))
    expect(events).toHaveLength(0)
    vi.advanceTimersByTime(501)
    events.push(...parser.flushPending!())
    events.push(...parser.onStdout(delta('下一段\n')), ...parser.onStdout(delta('before tool')))
    events.push(...parser.onStdout('{"type":"tool_use","tool_name":"read_file","tool_id":"id","parameters":{}}'))
    parser.onStdout(delta('tail'))
    const result = parser.finish(exit, event => events.push(event))
    const messages = events.flatMap(item => item.kind === 'agent' && item.event.type === 'message' ? [item.event.text] : [])
    expect(messages.length).toBeLessThanOrEqual(20)
    expect(messages.join('')).toBe('词 '.repeat(1000) + '下一段\nbefore tooltail')
    expect(events.at(-2)).toMatchObject({ event: { type: 'tool_use' } })
    expect(result.summary).toBe(messages.join(''))
  } finally { vi.useRealTimers() }
})

it('isolates a probe that ignores abort and caps concurrent probes globally', async () => {
  vi.useFakeTimers()
  try {
    const never = vi.fn(() => new Promise<never>(() => undefined))
    const ready = vi.fn(async () => ({ status: 'ready' as const, version: '1.0.0' }))
    const registry = new AdapterRegistry(config, [
      { ...codexAdapter, probe: never }, { ...geminiAdapter, probe: never }, { ...opencodeAdapter, probe: ready },
    ])
    const first = registry.probe()
    const second = registry.probe(['opencode'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(never).toHaveBeenCalledTimes(2)
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([first, second])
    expect(ready).toHaveBeenCalledTimes(1)
    expect(registry.get('codex')?.result).toMatchObject({ status: 'error', error: expect.stringContaining('5 s') })
    expect(registry.get('opencode')?.result.status).toBe('ready')
    registry.update({ ...config, adapters: { ...config.adapters, codex: { ...config.adapters.codex, enabled: false } } })
    expect(registry.get('codex')).toBeUndefined()
  } finally { vi.useRealTimers() }
})
