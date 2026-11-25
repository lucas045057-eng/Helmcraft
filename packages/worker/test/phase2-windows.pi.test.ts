/**
 * Pi 独立验收 · WIN-2 / WIN-5（Windows 进程树降级告警与 PID 复用防护）
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { Journal } from '../src/runner/journal.js'
import { trackProcessTree } from '../src/runner/kill-tree.js'
import { processAlive, processStartTime } from '../src/runner/process-identity.js'

function sleeper(ms = 30_000): ChildProcess {
  return spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], {
    stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32',
  })
}

async function waitExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null) return
  await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs))])
}

it('WIN-5 PID 复用防护：journal 中 pidStartTime 不匹配时不杀无关进程；匹配时才清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-win5-'))
  const journalPath = join(dir, 'journal.jsonl')
  const clock = new FakeClock(1_000)
  const unrelated = sleeper()
  try {
    const pid = unrelated.pid!
    const start = processStartTime(pid)
    expect(start, '需要可用的进程创建时间以验证身份').toBeTruthy()
    const staleRun = runId(1_000), staleTask = taskId(1_000)
    appendFileSync(journalPath, JSON.stringify({ type: 'run.accepted', runId: staleRun, taskId: staleTask,
      workspaceId: 'sandbox', pid, pidStartTime: '1' }) + '\n')

    const first = new Journal(journalPath, clock)
    await first.recover()
    // 创建时间不匹配 → 不杀该无关进程
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(processAlive(pid), '不得杀死被复用的无关 PID').toBe(true)

    // 记录正确创建时间后才允许清理
    const liveRun = runId(2_000)
    appendFileSync(journalPath, JSON.stringify({ type: 'run.accepted', runId: liveRun, taskId: taskId(2_000),
      workspaceId: 'sandbox', pid, pidStartTime: start }) + '\n')
    const second = new Journal(journalPath, clock)
    await second.recover()
    await waitExit(unrelated, 8000)
    expect(processAlive(pid), '创建时间匹配的孤儿进程应被清理').toBe(false)
  } finally {
    unrelated.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}, 40_000)

it.runIf(process.platform === 'win32')('WIN-2 降级模式（关闭 Job Object）：脱离父子链的进程存活时记录 ORPHAN_SURVIVED 告警', async () => {
  const root = sleeper(20_000)
  const escaped = sleeper(20_000)
  const warnings: unknown[] = []
  try {
    const tree = trackProcessTree(root.pid!, { useJobObject: false, onWarning: warning => warnings.push(warning) })
    expect(tree.mode).toBe('taskkill')
    tree.observe(escaped.pid!)
    await tree.kill({ force: true })
    tree.close()
    expect(warnings.some(warning => typeof warning === 'object' && warning !== null && 'code' in warning
      && (warning as { code: string }).code === 'ORPHAN_SURVIVED')).toBe(true)
    expect(processAlive(root.pid!)).toBe(false)
    expect(processAlive(escaped.pid!)).toBe(true)
  } finally {
    root.kill('SIGKILL')
    escaped.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}, 40_000)
