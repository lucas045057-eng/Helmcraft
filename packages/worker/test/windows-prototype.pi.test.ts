/**
 * Pi 独立验收 · Windows 原型门禁 WIN-1 / WIN-2 / WIN-4 / WIN-6 / WIN-7 / WIN-9
 *
 * 与既有 `process.test.ts` 的差异：
 *  - WIN-1 断言「graceMs + 3 s 内全部消失」的时限本身，而不只是最终消失。
 *  - WIN-2 额外证明：关闭 Job Object 时孤儿会存活，而当前的 `trackProcessTree` 还没有
 *    06 §5.2 阶段 3 的 ORPHAN_SURVIVED 复核（记录为 Phase 2 缺口）。
 *  - WIN-6 使用**真实 npm shim 全文**（取自 codex 0.166.0 夹具）解析并实际执行。
 *  - WIN-7 用沙箱哨兵文件 + argv 断言证明 prompt 只走 stdin，且无命令注入。
 *  - WIN-9 逐字节覆盖 CRLF 行切分与跨 chunk 多字节解码。
 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { NdjsonLineSplitter } from '@agent-hub/common/ndjson-line-splitter'
import { describe, expect, it } from 'vitest'
import { resolveExe, trackProcessTree } from '../src/index.js'

const windows = process.platform === 'win32'
const mock = fileURLToPath(new URL('../../mock-cli/src/index.ts', import.meta.url))
const jobOwner = fileURLToPath(new URL('./fixtures/job-owner.mjs', import.meta.url))
const echoStdin = fileURLToPath(new URL('./fixtures/echo-stdin.mjs', import.meta.url))
const recordedShim = fileURLToPath(new URL('./fixtures/codex/0.166.0/codex.cmd.txt', import.meta.url))

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

function startMock(args: string[] = [mock], detached = !windows) {
  const child = spawn(process.execPath, args, {
    detached, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pids = new Set<number>()
  const lines: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line)
    const value = JSON.parse(line) as { pid?: number }
    if (value.pid) pids.add(value.pid)
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
  return { child, pids, lines, exited: once(child, 'exit'), stderr: () => stderr }
}

function reap(pids: Iterable<number>): void {
  for (const pid of pids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

describe.runIf(windows)('WIN-1 取消进程树', () => {
  it('kills all 13 processes within graceMs + 3 s', async () => {
    const { child, pids, exited, stderr } = startMock()
    const tree = trackProcessTree(child.pid!, { onWarning: (error) => { throw error } })
    try {
      expect(tree.mode).toBe('job')
      child.stdin.end('#scenario: spawn-tree depth=3 width=3\n')
      await expect.poll(() => pids.size, { timeout: 8_000, message: stderr() }).toBe(13)
      expect([...pids].every(isAlive)).toBe(true)

      const graceMs = 500
      const started = Date.now()
      await tree.kill({ graceMs })
      await exited
      await expect.poll(() => [...pids].filter(isAlive), { timeout: graceMs + 3_000 }).toEqual([])
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(graceMs + 3_000)
      expect(isAlive(child.pid!)).toBe(false)
    } finally {
      tree.close()
      if (isAlive(child.pid!)) child.kill()
      reap(pids)
    }
  }, 25_000)
})

describe.runIf(windows)('WIN-2 孤儿进程', () => {
  it('kills the detached grandchild through the Job Object', async () => {
    const { child, pids, exited } = startMock()
    const warnings: unknown[] = []
    const tree = trackProcessTree(child.pid!, { onWarning: (error) => warnings.push(error) })
    try {
      expect(tree.mode).toBe('job')
      child.stdin.end('#scenario: orphan\n')
      await exited
      await expect.poll(() => pids.size).toBe(1)
      const leaf = [...pids][0]!
      expect(isAlive(leaf)).toBe(true)
      await tree.kill({ force: true })
      await expect.poll(() => isAlive(leaf)).toBe(false)
      expect(warnings).toEqual([])
    } finally {
      tree.close()
      reap(pids)
    }
  }, 20_000)

  it('leaves the orphan alive without a Job Object (missing ORPHAN_SURVIVED check)', async () => {
    const { child, pids, exited } = startMock()
    const tree = trackProcessTree(child.pid!, { useJobObject: false })
    try {
      expect(tree.mode).toBe('taskkill')
      child.stdin.end('#scenario: orphan\n')
      await exited
      await expect.poll(() => pids.size).toBe(1)
      const leaf = [...pids][0]!
      await tree.kill({ force: true })
      /* taskkill /T 无法覆盖已脱离父子链的孙进程 —— 这正是 06 §5.2 阶段 3 复核要兜底的场景。
         当前实现没有该复核，因此这里不会产生 ORPHAN_SURVIVED 告警（Phase 2 缺口）。 */
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(isAlive(leaf)).toBe(true)
    } finally {
      tree.close()
      reap(pids)
    }
  }, 20_000)
})

describe.runIf(windows)('WIN-4 Worker 被强杀', () => {
  it('reaps every CLI descendant when the worker process is taskkill /F', async () => {
    const { child, pids, lines, exited } = startMock([jobOwner])
    try {
      await expect.poll(() => pids.size, { timeout: 8_000 }).toBe(7)
      expect(JSON.parse(lines[0]!)).toEqual({ mode: 'job' })
      execTaskkill(child.pid!)
      await exited
      await expect.poll(() => [...pids].filter(isAlive), { timeout: 5_000 }).toEqual([])
    } finally {
      if (isAlive(child.pid!)) child.kill()
      reap(pids)
    }
  }, 25_000)
})

function execTaskkill(pid: number): void {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, shell: false })
  expect(result.status).toBe(0)
}

describe.runIf(windows)('WIN-6 .cmd shim 解析', () => {
  function withShim(source: string, target = 'node_modules/tools/bin/cli.js'): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shim-'))
    mkdirSync(join(dir, target, '..'), { recursive: true })
    writeFileSync(join(dir, target), 'console.log("shim run ok")\n')
    writeFileSync(join(dir, 'cli.cmd'), source)
    return dir
  }

  it('resolves the recorded real npm shim and executes it without a shell', () => {
    const source = readFileSync(recordedShim, 'utf8')
    const target = 'node_modules/@openai/codex/bin/codex.js'
    const dir = withShim(source, target)
    try {
      const result = resolveExe('cli', { path: dir })
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') return
      expect(result.exe.command).toBe(process.execPath)
      expect(result.exe.prefixArgs).toEqual([join(dir, target)])
      const executed = spawnSync(result.exe.command, result.exe.prefixArgs, {
        shell: false, windowsHide: true, encoding: 'utf8', cwd: dir,
      })
      expect(executed.status).toBe(0)
      expect(executed.stdout.trim()).toBe('shim run ok')
      /* 显式命令路径同样走 shim 解析 */
      expect(resolveExe('cli', { command: join(dir, 'cli.cmd') })).toEqual(result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects shims it cannot resolve unambiguously or that escape the package', () => {
    const cases: [string, string, string][] = [
      ['outside target', '"%_prog%" "%dp0%\\..\\..\\outside.js" %*\r\n', 'node_modules/tools/bin/cli.js'],
      ['two targets', '"%_prog%" "%dp0%\\node_modules\\tools\\bin\\cli.js" %*\r\n"%_prog%" "%dp0%\\node_modules\\tools\\bin\\other.js" %*\r\n', 'node_modules/tools/bin/cli.js'],
      ['relative target', '"%_prog%" ".\\node_modules\\tools\\bin\\cli.js" %*\r\n', 'node_modules/tools/bin/cli.js'],
      ['no target', '@ECHO off\r\necho nothing here\r\n', 'node_modules/tools/bin/cli.js'],
      ['missing target file', '"%_prog%" "%dp0%\\node_modules\\tools\\bin\\absent.js" %*\r\n', 'node_modules/tools/bin/cli.js'],
    ]
    for (const [label, source, target] of cases) {
      const dir = withShim(source, target)
      try {
        const result = resolveExe('cli', { path: dir })
        expect(result.status, label).toBe('error')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('rejects oversized shims and prefers .exe over .cmd', () => {
    const dir = withShim('x'.repeat(70 * 1024))
    try {
      expect(resolveExe('cli', { path: dir }).status).toBe('error')
      writeFileSync(join(dir, 'cli.exe'), '')
      expect(resolveExe('cli', { path: dir })).toEqual({
        status: 'ready', exe: { command: join(dir, 'cli.exe'), prefixArgs: [] },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(resolveExe('cli', { command: 'cli.cmd' }).status).toBe('error')
    expect(resolveExe('cli', { command: 'C:\\nope\\cli.exe' }).status).toBe('error')
  })
})

describe('WIN-7 命令注入', () => {
  it('passes cmd metacharacters through stdin verbatim without spawning anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hub-inject-'))
    const sentinel = join(dir, 'pwned.txt')
    const childReport = join(dir, 'child.txt')
    const prompt = [
      '& calc.exe',
      '" | del /f /q C:\\Windows\\System32\\drivers\\etc\\hosts',
      '%PATH%',
      '^&^|',
      '& echo INJECTED> ' + sentinel,
      '& echo CHILD> ' + childReport,
      '$(touch ' + sentinel + ')',
      '`id`',
      '; rm -rf /',
      '正常的中文需求 & 第二行',
    ].join('\r\n')
    try {
      const executed = spawnSync(process.execPath, [echoStdin], {
        input: prompt,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, ECHO_STDIN_SENTINEL: '' },
      })
      expect(executed.status).toBe(0)
      const report = JSON.parse(executed.stdout.trim()) as { argv: string[]; stdin: string; stdinBytes: number }
      /* prompt 只经 stdin 传递，字节级无损 */
      expect(report.stdin).toBe(prompt)
      expect(report.stdinBytes).toBe(Buffer.byteLength(prompt, 'utf8'))
      /* 命令行里不得出现 prompt 的任何片段 */
      expect(report.argv).toEqual([echoStdin])
      for (const marker of ['calc.exe', '%PATH%', 'cmd.exe', '/c']) {
        expect(report.argv.join(' ')).not.toContain(marker)
      }
      /* 没有任何 shell 元字符被执行 */
      expect(existsSync(sentinel)).toBe(false)
      expect(existsSync(childReport)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never asks for a shell when spawning the mock CLI with an injected prompt', async () => {
    const child = spawn(process.execPath, [mock], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
      child.stdin.write('#scenario: need-input\r\n')
      const first = JSON.parse((await lines.next()).value as string) as { type: string }
      expect(first.type).toBe('input_request')
      const answer = 'answer & calc.exe %PATH% ^ | del'
      child.stdin.end(answer + '\r\n')
      const second = JSON.parse((await lines.next()).value as string) as { text: string, final: boolean }
      expect(second).toMatchObject({ text: answer, final: true })
      expect(await once(child, 'exit')).toEqual([0, null])
    } finally {
      if (child.exitCode === null) child.kill()
    }
  }, 15_000)
})

describe('WIN-9 CRLF 行切分', () => {
  function feed(chunks: Buffer[], maxLineBytes = 16 * 1024): string[] {
    const splitter = new NdjsonLineSplitter(maxLineBytes)
    return [...chunks.flatMap((chunk) => splitter.push(chunk)), ...splitter.finish()].map((line) => line.text)
  }

  it('strips CR from CRLF terminated lines', () => {
    expect(feed([Buffer.from('first\r\nsecond\r\nthird\n')])).toEqual(['first', 'second', 'third'])
    for (const line of feed([Buffer.from('a\r\nb\r\n')])) expect(line).not.toContain('\r')
  })

  it('handles a CRLF split across chunk boundaries', () => {
    expect(feed([Buffer.from('a\r'), Buffer.from('\n'), Buffer.from('b\r'), Buffer.from('\n')])).toEqual(['a', 'b'])
    expect(feed([Buffer.from('abc'), Buffer.from('\r\n'), Buffer.from('def\r\n')])).toEqual(['abc', 'def'])
  })

  it('keeps a bare CR that is part of the line content', () => {
    expect(feed([Buffer.from('progress 50%\rprogress 100%\n')])).toEqual(['progress 50%\rprogress 100%'])
  })

  it('decodes multi byte characters split across chunks', () => {
    const text = '中文 😀 结束\r\n第二行 🌍\r\n'
    const bytes = Buffer.from(text, 'utf8')
    const oneByte = [...bytes].map((byte) => Uint8Array.of(byte))
    expect(feed(oneByte.map((chunk) => Buffer.from(chunk)))).toEqual(['中文 😀 结束', '第二行 🌍'])
    // 两字节切分
    const halves = [bytes.subarray(0, 7), bytes.subarray(7, 13), bytes.subarray(13)]
    expect(feed(halves)).toEqual(['中文 😀 结束', '第二行 🌍'])
  })

  it('truncates oversized CRLF lines without leaving a stray CR', () => {
    const splitter = new NdjsonLineSplitter(6)
    const lines = splitter.push(Buffer.from('abcdefgh\r\n中😀中文\r\n'))
    expect(lines[0]).toEqual({ text: 'abcdef…[truncated 2 bytes]', truncatedBytes: 2 })
    expect(lines[1]!.text).toContain('…[truncated')
    for (const line of lines) expect(line.text).not.toContain('\r')
    expect(splitter.finish()).toEqual([])
  })
})
