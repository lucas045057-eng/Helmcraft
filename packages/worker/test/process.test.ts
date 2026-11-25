import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExe, trackProcessTree } from '../src/index.js'

const windows = process.platform === 'win32'
const mock = fileURLToPath(new URL('../../mock-cli/src/index.ts', import.meta.url))
const ownerFixture = fileURLToPath(new URL('./fixtures/job-owner.mjs', import.meta.url))

function isAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

function start(args: string[], detached = !windows) {
  const child = spawn(process.execPath, args, { detached, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pids = new Set<number>()
  const lines: string[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line) as { pid?: number }
    lines.push(line)
    if (value.pid) pids.add(value.pid)
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (line: string) => { stderr += line })
  return { child, pids, lines, stderr: () => stderr, exited: once(child, 'exit') }
}

function cleanPids(pids: Set<number>): void {
  for (const pid of pids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
    }
  }
}

it('resolves an explicit native executable and refuses relative commands', () => {
  expect(resolveExe('node', { command: process.execPath })).toEqual({
    status: 'ready', exe: { command: process.execPath, prefixArgs: [] },
  })
  expect(resolveExe('node', { command: 'node.exe' }).status).toBe('error')
})

it.runIf(windows)('WIN-6: resolves npm cmd shim without a shell and prefers a PATH exe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hub-shim-'))
  try {
    const script = join(dir, 'cli.js')
    writeFileSync(script, 'console.log("shim works")')
    writeFileSync(join(dir, 'mock-cmd.cmd'), 'SET dp0=%~dp0\r\n"%_prog%" "%dp0%\\cli.js" %*\r\n')
    const result = resolveExe('mock-cmd', { path: dir })
    expect(result).toEqual({ status: 'ready', exe: { command: process.execPath, prefixArgs: [script] } })
    if (result.status !== 'ready') throw new Error('missing shim')
    const resolved = spawnSync(result.exe.command, result.exe.prefixArgs, { shell: false, windowsHide: true, encoding: 'utf8' })
    expect(resolved.status).toBe(0)
    expect(resolved.stdout.trim()).toBe('shim works')
    writeFileSync(join(dir, 'mock-cmd.exe'), '')
    expect(resolveExe('mock-cmd', { path: dir })).toMatchObject({ exe: { command: join(dir, 'mock-cmd.exe'), prefixArgs: [] } })
    writeFileSync(join(dir, 'bad.cmd'), '"%_prog%" "%dp0%\\..\\outside.js" %*')
    expect(resolveExe('bad', { path: dir }).status).toBe('error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.runIf(windows)('Windows Job Object', () => {
  it('WIN-1: terminates all 13 descendants and root after tracking a tree', async () => {
    const { child, pids, exited, stderr } = start([mock])
    const tree = trackProcessTree(child.pid!, { onWarning: console.error })
    try {
      expect(tree.mode).toBe('job')
      child.stdin.end('#scenario: spawn-tree depth=3 width=3\n')
      await expect.poll(() => pids.size, { timeout: 5_000, message: stderr() }).toBe(13)
      await tree.kill({ force: true })
      await exited
      await expect.poll(() => [...pids].filter(isAlive)).toEqual([])
    } finally {
      tree.close()
      if (isAlive(child.pid!)) child.kill()
      cleanPids(pids)
    }
  }, 12_000)

  it('WIN-2: terminates an orphan after its original parent has exited', async () => {
    const { child, pids, exited } = start([mock])
    const tree = trackProcessTree(child.pid!, { onWarning: console.error })
    try {
      expect(tree.mode).toBe('job')
      child.stdin.end('#scenario: orphan\n')
      await exited
      await expect.poll(() => pids.size).toBe(1)
      expect([...pids].every(isAlive)).toBe(true)
      await tree.kill({ force: true })
      await expect.poll(() => [...pids].filter(isAlive)).toEqual([])
    } finally {
      tree.close()
      cleanPids(pids)
    }
  })

  it('WIN-4: kernel closes job and reaps every process after the worker is force-killed', async () => {
    const { child, pids, lines, exited, stderr } = start([ownerFixture])
    try {
      await expect.poll(() => pids.size, { timeout: 5_000 }).toBe(7)
      expect(JSON.parse(lines[0]!), stderr()).toEqual({ mode: 'job' })
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/F'], { windowsHide: true, shell: false })
      await exited
      await expect.poll(() => [...pids].filter(isAlive)).toEqual([])
    } finally {
      if (isAlive(child.pid!)) child.kill()
      cleanPids(pids)
    }
  }, 12_000)

  it('falls back to taskkill when configured to disable the Job Object', async () => {
    const { child, pids, exited } = start([mock])
    const tree = trackProcessTree(child.pid!, { useJobObject: false })
    try {
      expect(tree.mode).toBe('taskkill')
      child.stdin.end('#scenario: ignore-sigterm\n')
      await expect.poll(() => pids.size).toBe(1)
      await tree.kill({ graceMs: 10 })
      await exited
      await tree.kill({ force: true })
    } finally {
      tree.close()
      if (isAlive(child.pid!)) child.kill()
    }
  })

  it('automatically falls back when Windows cannot open the process', async () => {
    const absentPid = 0x7fff_ffff
    const warnings: unknown[] = []
    expect(isAlive(absentPid)).toBe(false)
    const tree = trackProcessTree(absentPid, { onWarning: (error) => { warnings.push(error) } })
    try {
      expect(tree.mode).toBe('taskkill')
      expect(warnings).toEqual([expect.objectContaining({ message: expect.stringContaining('OpenProcess') })])
      await expect(tree.kill({ force: true })).resolves.toBeUndefined()
    } finally {
      tree.close()
    }
  })
})

it.runIf(!windows)('terminates an independent POSIX process group', async () => {
  const { child, pids, exited } = start([mock])
  const tree = trackProcessTree(child.pid!)
  try {
    child.stdin.end('#scenario: ignore-sigterm\n')
    await expect.poll(() => pids.size).toBe(1)
    await tree.kill({ graceMs: 10 })
    expect(await exited).toEqual([null, 'SIGKILL'])
  } finally {
    if (isAlive(child.pid!)) await tree.kill({ force: true })
    tree.close()
  }
})
