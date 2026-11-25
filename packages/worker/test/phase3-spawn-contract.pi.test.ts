/**
 * Pi 独立验收 · Phase 3 · WIN-12（窗口隐藏 / 不使用 shell）
 *
 * 通过拦截 `node:child_process` 实测 worker 自己的调用参数：
 *   - `spawnRun`  → `spawn(command, args, { windowsHide: true, shell: false, ... })`
 *   - `probe`     → `execFile(..., { windowsHide: true, shell: false, timeout: 5000 })`
 *   - 计划任务     → `execFile(powershell, ..., { windowsHide: true, shell: false })`
 * 另外做一次静态扫描，确认源码里不存在 `shell: true`。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; command: unknown; args: unknown
  options: Record<string, unknown> }> }))

function fakeChild() {
  return {
    stdin: { on: () => undefined, end: () => undefined, write: () => true, writable: true },
    stdout: { on: () => undefined }, stderr: { on: () => undefined },
    once: () => undefined, on: () => undefined, kill: () => undefined, pid: 4321,
  }
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: unknown, args: unknown, options: Record<string, unknown>) => {
      state.calls.push({ fn: 'spawn', command, args, options })
      return fakeChild()
    },
    execFile: (command: unknown, args: unknown, options: unknown, callback?: unknown) => {
      const opts = (typeof options === 'function' ? {} : options) as Record<string, unknown>
      const done = (typeof options === 'function' ? options : callback) as
        ((error: unknown, stdout: string, stderr: string) => void) | undefined
      state.calls.push({ fn: 'execFile', command, args, options: opts })
      setTimeout(() => done?.(null, 'codex-cli 0.166.0\n', ''), 0)
      return fakeChild()
    },
  }
})

const { spawnRun, writePrompt } = await import('../src/runner/spawn.js')
const { codexAdapter } = await import('../src/adapters/codex.js')
const { installTask, uninstallTask } = await import('../src/scheduled-task.js')
const { mockAdapter } = await import('../src/adapters/mock.js')

const win = process.platform === 'win32'

it('WIN-12 spawnRun：windowsHide=true、shell=false、stdio 三管道、POSIX 独立进程组', () => {
  state.calls.length = 0
  const child = spawnRun({ command: 'C:\\工具 目录\\cli.exe', args: ['-p', 'x'], stdin: 'prompt', env: {} },
    'C:\\中文 工作区', { PATH: 'C:\\Windows' })
  expect(child).toBeDefined()
  expect(state.calls).toHaveLength(1)
  const call = state.calls[0]!
  expect(call.fn).toBe('spawn')
  expect(call.command).toBe('C:\\工具 目录\\cli.exe')
  expect(call.args).toEqual(['-p', 'x'])
  expect(call.options).toMatchObject({ cwd: 'C:\\中文 工作区', stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, shell: false })
  expect(call.options.detached).toBe(!win)
  // 绝不使用 shell 执行（CVE-2024-27980 / cmd 元字符注入）
  expect(call.options.shell).not.toBe(true)
})

it('WIN-12 writePrompt：非 live-input 结束 stdin；live-input 只写不关闭', () => {
  const writes: string[] = []
  let ended = 0
  const child = { stdin: { write: (text: string) => { writes.push(text); return true },
    end: () => { ended++ } } } as never
  writePrompt(child, 'hello', false)
  expect(writes).toEqual([])
  expect(ended).toBe(1)
  writePrompt(child, 'hello', true)
  expect(writes).toEqual(['hello\n'])
  writePrompt(child, 'hello\n', true)
  expect(writes).toEqual(['hello\n', 'hello\n'])
  expect(ended).toBe(1)
})

it('WIN-12 probe：execFile 也设置 windowsHide=true / shell=false / 5 s 超时', async () => {
  state.calls.length = 0
  const result = await codexAdapter.probe(AbortSignal.timeout(10_000), {
    enabled: true, command: process.execPath, env: {}, passEnv: [], allowedExtraArgs: [], argsOverride: {},
    stderrEncoding: 'utf8',
  })
  expect(result.status).toBe('ready')
  expect(state.calls.length).toBeGreaterThanOrEqual(1)
  for (const call of state.calls) {
    expect(call.fn).toBe('execFile')
    expect(call.options).toMatchObject({ windowsHide: true, shell: false, timeout: 5000 })
  }
  expect(state.calls[0]!.args).toEqual(['--version'])
})

it('WIN-12 mock adapter 的 probe 同样隐藏窗口且不使用 shell', async () => {
  state.calls.length = 0
  const result = await mockAdapter.probe(AbortSignal.timeout(10_000))
  expect(result.status).toBe('ready')
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0]!.options).toMatchObject({ windowsHide: true, shell: false, timeout: 5000 })
})

it.runIf(win)('WIN-12 计划任务：powershell 子进程 windowsHide=true / shell=false / 有限超时', async () => {
  state.calls.length = 0
  await installTask('C:\\配置 目录\\worker.yaml', 'PiProbeTask')
  await uninstallTask('PiProbeTask')
  expect(state.calls).toHaveLength(2)
  for (const call of state.calls) {
    expect(call.fn).toBe('execFile')
    expect(String(call.command).toLowerCase()).toContain('powershell.exe')
    expect(call.options).toMatchObject({ windowsHide: true, shell: false, timeout: 20_000 })
    expect((call.args as string[]).join(' ')).toContain('-EncodedCommand')
  }
})

it('WIN-12 静态扫描：worker / mock-cli 源码中不存在 shell: true', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !path.includes('test')) files.push(path)
    }
  }
  walk(join(root, 'src'))
  walk(join(root, '..', 'mock-cli', 'src'))
  expect(files.length).toBeGreaterThan(20)
  const offenders = files.filter(file => /shell\s*:\s*true/u.test(readFileSync(file, 'utf8')))
  expect(offenders, 'shell: true 会引入 cmd 元字符注入').toEqual([])
  // 反向确认：确实存在显式的 shell: false 声明
  const explicit = files.filter(file => /shell\s*:\s*false/u.test(readFileSync(file, 'utf8')))
  expect(explicit.length).toBeGreaterThanOrEqual(3)
})
