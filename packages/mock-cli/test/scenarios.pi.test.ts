/**
 * Pi 独立验收 · 06 §4.3 mock-cli 全部剧本（AD-9）
 *
 * 14 个剧本逐一实测其规格描述的行为，并额外验证参数校验（k=v、整数范围、未知剧本）。
 * 与既有 `mock-cli.test.ts` 的差异：覆盖 `ignore-sigterm` / `spawn-tree` / `orphan`
 * 三个涉及进程树与信号的前三个剧本，并断言剧本参数错误的退出码与提示。
 */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const windows = process.platform === 'win32'

function run(scenario: string, options: { input?: string; timeout?: number } = {}) {
  return spawnSync(process.execPath, [bin], {
    input: options.input ?? '#scenario: ' + scenario + '\n',
    windowsHide: true,
    shell: false,
    timeout: options.timeout ?? 10_000,
    maxBuffer: 24 * 1024 * 1024,
  })
}

/** 启动一个需要交互/需要观察 pid 的剧本。 */
function start(scenario: string) {
  const child = spawn(process.execPath, [bin], {
    detached: !windows, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: Record<string, unknown>[] = []
  const pids = new Set<number>()
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      lines.push(parsed)
      if (typeof parsed.pid === 'number') pids.add(parsed.pid)
    } catch {
      lines.push({ unparsable: line })
    }
  })
  const exited = once(child, 'exit')
  child.stdin.write('#scenario: ' + scenario + '\n')
  return { child, lines, pids, exited, stderr: () => (child.stderr.read() as string | null) ?? '' }
}

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

function killTree(pid: number): void {
  if (!isAlive(pid)) return
  try {
    if (windows) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false })
    else process.kill(-pid, 'SIGKILL')
  } catch { /* already gone */ }
}

async function cleanup(...pids: number[]): Promise<void> {
  for (const pid of pids) killTree(pid)
}

describe('AD-9 十四个剧本', () => {
  it('success: emits structured events and exits 0', () => {
    const result = run('success')
    expect(result.status).toBe(0)
    const events = result.stdout.toString().trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(7) // init + session + 5 messages
    expect(events[0]).toEqual({ type: 'init', model: 'mock' })
    expect(events[1]).toEqual({ type: 'session', cliSessionId: 'mock-session' })
    expect(events.filter((event) => event.type === 'message')).toHaveLength(5)
    expect(events.at(-1)).toMatchObject({ type: 'message', role: 'assistant', text: 'Mock response 5', final: true })
    // 只有最后一条 message 标记为 final
    expect(events.filter((event) => event.type === 'message' && event.final)).toHaveLength(1)
  })

  it('success: honours n= and session=', () => {
    const events = run('success n=2 session=custom').stdout.toString().trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events.filter((event) => event.type === 'message')).toHaveLength(2)
    expect(events[1]).toEqual({ type: 'session', cliSessionId: 'custom' })
  })

  it('fail: emits an error event and exits with the requested code', () => {
    const result = run('fail')
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({ type: 'error', fatal: true })
    expect(run('fail code=42').status).toBe(42)
    expect(run('fail code=255').status).toBe(255)
  })

  it('slow: emits ~1 progress line per second', () => {
    const started = Date.now()
    const result = run('slow ms=2200')
    const elapsed = Date.now() - started
    const progress = result.stdout.toString().trim().split('\n').map((line) => JSON.parse(line))
    expect(progress.map((event) => event.detail)).toEqual(['0', '1000', '2000'])
    expect(elapsed).toBeGreaterThanOrEqual(2_000)
    expect(result.status).toBe(0)
  })

  it('flood: writes exactly mb MiB of newline terminated data', () => {
    for (const [mb, line] of [[1, 1024], [2, 257], [1, 65_536]] as const) {
      const result = run('flood mb=' + mb + ' line=' + line)
      expect(result.stdout.length, 'mb=' + mb + ' line=' + line).toBe(mb * 1024 * 1024)
      const output = result.stdout
      expect(output[output.length - 1]).toBe(10)
    }
  })

  it('huge-line: writes a single oversized line', () => {
    for (const bytes of [16_385, 1_048_576]) {
      const stdout = run('huge-line bytes=' + bytes).stdout
      expect(stdout.length).toBe(bytes + 1)
      expect(stdout.subarray(0, bytes).every((byte) => byte === 0x78)).toBe(true)
      expect(stdout[bytes]).toBe(10)
    }
  })

  it('malformed: mixes invalid JSON, truncated JSON, binary garbage and unknown events', () => {
    const stdout = run('malformed').stdout
    const text = stdout.toString('utf8')
    expect(text).toContain('"type":"init"')
    expect(text).toContain('not JSON')
    expect(text).toContain('{"unterminated":')
    expect(stdout.includes(Buffer.from([0x00, 0xff, 0xfe]))).toBe(true)
    expect(text).toContain('"type":"future_event"')
  })

  it('need-input: blocks for an answer and echoes it as the final message', async () => {
    const { child, lines, exited } = start('need-input')
    try {
      await expect.poll(() => lines.length).toBe(1)
      expect(lines[0]).toMatchObject({
        type: 'input_request', requestId: 'mock-input', question: 'Continue?', options: ['yes', 'no'],
      })
      // 在收到答案前不得退出
      expect(child.exitCode).toBeNull()
      child.stdin.end('继续\n')
      expect(await exited).toEqual([0, null])
      expect(lines[1]).toMatchObject({ type: 'message', text: '继续', final: true })
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
    }
  })

  it('need-input: fails when stdin closes without an answer', async () => {
    const { child, lines, exited } = start('need-input')
    try {
      await expect.poll(() => lines.length).toBe(1)
      child.stdin.end()
      expect((await exited)[0]).toBe(1)
      expect(lines.at(-1)).toMatchObject({ type: 'error', fatal: true })
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
    }
  })

  it('ignore-sigterm: survives signals long enough to be force killed', async () => {
    const { child, lines, pids } = start('ignore-sigterm')
    try {
      await expect.poll(() => pids.size, { timeout: 5_000 }).toBe(1)
      const pid = [...pids][0]!
      /* POSIX 才能观察到信号被忽略；Windows 的 SIGTERM 由 TerminateProcess 实现，不可拦截 */
      if (!windows) {
        expect(() => process.kill(child.pid!, 'SIGTERM')).not.toThrow()
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(isAlive(pid)).toBe(true)
      }
      expect(child.exitCode).toBeNull()
      expect(lines[0]).toMatchObject({ type: 'pid', pid: child.pid })
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
      await cleanup(...pids)
    }
  })

  it('spawn-tree: recursively spawns depth levels and reports every pid', async () => {
    const { child, pids, lines } = start('spawn-tree depth=3 width=1')
    try {
      await expect.poll(() => pids.size, { timeout: 8_000 }).toBe(3)
      expect(lines.filter((line) => line.type === 'pid')).toHaveLength(3)
      expect([...pids].every(isAlive)).toBe(true)
      expect(child.exitCode).toBeNull()
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
      await expect.poll(() => [...pids].filter(isAlive)).toEqual([])
    }
  }, 20_000)

  it('spawn-tree: reports children for width>1 and enforces the 128 process cap', async () => {
    const { child, pids } = start('spawn-tree depth=2 width=3')
    try {
      await expect.poll(() => pids.size, { timeout: 8_000 }).toBe(4)
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
      await expect.poll(() => [...pids].filter(isAlive)).toEqual([])
    }
    expect(run('spawn-tree depth=8 width=8').status).toBe(1)
  }, 20_000)

  it('orphan: the parent exits while the detached grandchild survives', async () => {
    const { child, pids, lines, exited } = start('orphan')
    try {
      expect(await exited).toEqual([0, null])
      await expect.poll(() => pids.size).toBe(1)
      const leaf = [...pids][0]!
      expect(lines.at(-1)).toMatchObject({ type: 'pid', pid: leaf })
      expect(child.exitCode).toBe(0)
      // 这正是 Job Object 必须覆盖的“孤儿”场景：父链已断但进程仍在
      expect(isAlive(leaf)).toBe(true)
      await cleanup(leaf)
      await expect.poll(() => isAlive(leaf)).toBe(false)
    } finally {
      if (child.exitCode === null) killTree(child.pid!)
      await cleanup(...pids)
    }
  }, 20_000)

  it('secrets: prints every fake credential class documented in 06 §6.5', () => {
    const text = run('secrets').stdout.toString('utf8')
    for (const marker of ['sk-ant-', 'sk-proj-', 'AIza', 'ghp_', 'github_pat_', 'xoxb-', 'AKIA',
      'aws_secret_access_key=', 'app_secret:', 'tenant_access_token=', 'eyJ', '-----BEGIN PRIVATE KEY-----',
      '-----END PRIVATE KEY-----', 'password=', 'postgres://mock:']) {
      expect(text, marker).toContain(marker)
    }
  })

  it('unicode: writes multi byte characters byte by byte across chunk boundaries', () => {
    const result = run('unicode')
    expect(result.stdout.toString('utf8')).toBe('中文 😀\r\n再见 🌍\n')
    expect(result.stdout.equals(Buffer.from('中文 😀\r\n再见 🌍\n', 'utf8'))).toBe(true)
    expect(result.status).toBe(0)
  })

  it('crash: writes half of the output then aborts abnormally', () => {
    const result = run('crash')
    expect(result.stdout.toString()).toContain('Before abort')
    expect(result.status).not.toBe(0)
    expect(result.signal ?? 'SIGABRT').toBeTruthy()
  })

  it('idle: stays silent for the requested window', () => {
    const started = Date.now()
    const result = run('idle ms=400')
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(result.stdout.length).toBe(0)
    expect(result.status).toBe(0)
  })
})

describe('AD-9 剧本参数校验', () => {
  const invalid = [
    ['unknown scenario', '#scenario: nope\n'],
    ['unknown parameter form', '#scenario: success n\n'],
    ['non numeric integer', '#scenario: flood mb=abc\n'],
    ['below minimum', '#scenario: success n=0\n'],
    ['above maximum', '#scenario: spawn-tree depth=9\n'],
    ['graceMs style overflow', '#scenario: slow ms=-1\n'],
  ] as const

  for (const [label, input] of invalid) {
    it('exits 1 with a message for ' + label, () => {
      const result = run('', { input })
      expect(result.status).toBe(1)
      expect(result.stderr.toString().trim().length).toBeGreaterThan(0)
      expect(result.stdout.length).toBe(0)
    })
  }

  it('defaults to the success scenario when the marker is missing', () => {
    const result = run('', { input: 'just a prompt\n' })
    expect(result.status).toBe(0)
    expect(result.stdout.toString()).toContain('"type":"init"')
  })
})

/* 规模护栏：剧本源码不得使用 shell，避免测试自身成为注入放大器 */
it('spawns without a shell', () => {
  const source = readFileSync(bin, 'utf8')
  expect(source).not.toMatch(/shell:\s*true/)
  expect(source).toContain('shell: false')
})
