/**
 * Pi 独立验收 · Phase 2 门禁：WK-9 / WK-11 ~ WK-15（真实 Worker 进程）
 */
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { loadIdentity } from '../src/identity.js'
import type { WorkerIdentity } from '../src/identity.js'
import { assertInvariants, assertRunLogContinuity, ChaosProxy } from '../../hub/test/pi/harness.js'
import { enroll, startHub, waitFor, wsUrl } from './pi/worker-harness.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const cli = resolve(repoRoot, 'packages/worker/bin/agent-worker.mjs')

function rssBytes(pid: number): number {
  let bytes: number
  if (process.platform === 'linux') {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    bytes = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1]) * 1024
  } else if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const out = execFileSync(powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false })
    bytes = Number(out.trim())
  } else {
    bytes = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 }).trim()) * 1024
  }
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error(`Invalid RSS sample for PID ${pid} on ${process.platform}`)
  return bytes
}

function processAlive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

interface SpawnedWorker { child: ChildProcess; pid: number; exited: Promise<number | null>; stderr: () => string }

function writeWorkerConfig(dir: string, workerId: string, url: string, workspace: string, extra: Record<string, unknown> = {}) {
  const identity = loadIdentity(join(dir, 'identity.key'), true)
  mkdirSync(workspace, { recursive: true })
  const config = {
    workerId,
    hub: { url },
    maxConcurrency: 2,
    adapters: { mock: { enabled: true } },
    localLogs: { dir: join(dir, 'runs') },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full',
      maxConcurrent: 2 }],
    ...extra,
  }
  const configPath = join(dir, 'worker.yaml')
  writeFileSync(configPath, stringify(config), 'utf8')
  return { identity: identity as WorkerIdentity, configPath }
}

function spawnWorker(dir: string, configPath: string): SpawnedWorker {
  const child = spawn(process.execPath, [cli, 'run', '--config', configPath], {
    cwd: repoRoot,
    env: { ...process.env, LOCALAPPDATA: join(dir, 'state-home'), APPDATA: join(dir, 'state-home') },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))
  return { child, pid: child.pid!, exited, stderr: () => stderr }
}

async function stopWorker(worker: SpawnedWorker) {
  if (worker.child.exitCode !== null) return
  worker.child.kill('SIGKILL')
  await worker.exited.catch(() => undefined)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('WK-9 背压 / 防 OOM', () => {
  it('flood + 限速代理：RSS 受控、产生 dropped、seq 连续、started/finished 必达', async () => {
    const { hub, cleanup } = await startHub({ workers: { gracePeriodMs: 30_000 } })
    const dir = tempDirFor('pi-wk9-')
    let proxy: ChaosProxy | undefined
    let worker: SpawnedWorker | undefined
    try {
      proxy = await ChaosProxy.start(hub.address!)
      const { identity, configPath } = writeWorkerConfig(dir, 'wk9', proxy.url, join(dir, 'repo'))
      await enroll(hub, 'wk9', { ...identity, workerId: 'wk9' } as never)
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk9')?.connection === 'online', 20_000, 'worker online')
      const base = rssBytes(worker.pid)
      expect(base).toBeGreaterThan(0)
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: flood mb=256 line=4096',
        workspaceId: 'sandbox', adapter: 'mock' }, { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' })
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'running', 20_000, 'running')
      const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
      proxy.throttle(1 << 20)
      let peak = base
      const sampleUntil = Date.now() + 15_000
      while (Date.now() < sampleUntil) {
        peak = Math.max(peak, rssBytes(worker.pid))
        await sleep(400)
      }
      // dropped 事件在 Run 结束时（recordDrop）才发出，先恢复带宽再等待完成
      proxy.restore()
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'succeeded', 180_000, 'flood succeeded')
      const dropped = (hub.ctx.store.repos.prepare("SELECT count(*) AS n FROM task_logs WHERE run_id = ? AND kind = 'dropped'")
        .get(runId) as { n: number }).n
      const kinds = hub.ctx.store.repos.prepare('SELECT kind, count(*) AS n FROM task_logs WHERE run_id = ? GROUP BY kind').all(runId) as
        Array<{ kind: string; n: number }>
      const problems: string[] = []
      if (dropped <= 0) problems.push('未产生 dropped 背压事件')
      if (kinds.find(row => row.kind === 'started')?.n !== 1) problems.push('started 事件不为 1')
      if (kinds.find(row => row.kind === 'finished')?.n !== 1) problems.push('finished 事件不为 1')
      try { assertRunLogContinuity(hub.ctx.store.repos, runId) } catch (error) { problems.push((error as Error).message) }
      const rssDeltaMiB = Math.round((peak - base) / 1048576)
      console.log('WK-9 rss', { baseMiB: Math.round(base / 1048576),
        peakMiB: Math.round(peak / 1048576), afterMiB: Math.round(rssBytes(worker.pid) / 1048576), dropped, rssDeltaMiB })
      // 门禁：flood + 限速代理下 Worker RSS 增量 < 150 MiB，且 dropped / seq / started / finished 全部成立（WK-9）
      expect({ problems, rssDeltaMiB, within150MiB: rssDeltaMiB < 150 })
        .toEqual({ problems: [], rssDeltaMiB, within150MiB: true })
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (worker) await stopWorker(worker)
      await proxy?.close()
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 240_000)
})

describe('WK-11 / WK-12 journal 恢复', () => {
  it('WK-11 强杀 Worker：孤儿进程被清理，重启后上报 finished(WORKER_RESTARTED) 且 Hub 收到 gap + finished', async () => {
    const { hub, cleanup } = await startHub({ workers: { gracePeriodMs: 30_000 } })
    const dir = tempDirFor('pi-wk11-')
    let worker: SpawnedWorker | undefined
    try {
      const { identity, configPath } = writeWorkerConfig(dir, 'wk11', wsUrl(hub.address!), join(dir, 'repo'))
      await enroll(hub, 'wk11', { ...identity, workerId: 'wk11' } as never)
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk11')?.connection === 'online', 20_000)
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: slow ms=120000',
        workspaceId: 'sandbox', adapter: 'mock' }, { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' })
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'running', 20_000)
      const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
      const pid = await waitFor(() => hub.ctx.store.repos.runs.get(runId)!.pid, 10_000, 'child pid')
      expect(processAlive(pid)).toBe(true)
      worker.child.kill('SIGKILL')
      await worker.exited
      await waitFor(() => !processAlive(pid), 20_000, 'orphan cleanup')
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'failed', 40_000, 'failed after restart')
      expect(hub.ctx.orchestrator.getTask(task.id)!.errorCode).toBe('WORKER_RESTARTED')
      assertRunLogContinuity(hub.ctx.store.repos, runId)
      const finished = hub.ctx.store.repos.prepare("SELECT data_json AS dataJson FROM task_logs WHERE run_id = ? AND kind = 'finished'").all(runId) as
        Array<{ dataJson: string }>
      expect(finished).toHaveLength(1)
      expect(JSON.parse(finished[0]!.dataJson)).toMatchObject({ errorCode: 'WORKER_RESTARTED' })
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (worker) await stopWorker(worker)
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 150_000)

  it('WK-12 finished 已生成但未 ack 时重启：补发 finished，Hub 只记录一次', async () => {
    const { hub, cleanup } = await startHub({ workers: { gracePeriodMs: 60_000, heartbeatTimeoutMs: 60_000 } })
    const dir = tempDirFor('pi-wk12-')
    let proxy: ChaosProxy | undefined
    let worker: SpawnedWorker | undefined
    try {
      proxy = await ChaosProxy.start(hub.address!)
      const { identity, configPath } = writeWorkerConfig(dir, 'wk12', proxy.url, join(dir, 'repo'))
      await enroll(hub, 'wk12', { ...identity, workerId: 'wk12' } as never)
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk12')?.connection === 'online', 20_000)
      const task = await hub.ctx.orchestrator.createTask({ prompt: '#scenario: success n=3',
        workspaceId: 'sandbox', adapter: 'mock' }, { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' })
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'running', 20_000)
      proxy.blackhole()
      const journalPath = join(dir, 'state-home', 'agent-worker', 'state', 'journal.jsonl')
      await waitFor(() => existsSync(journalPath) && readFileSync(journalPath, 'utf8').includes('run.finished'), 25_000, 'journal finished')
      worker.child.kill('SIGKILL')
      await worker.exited
      proxy.restore()
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk12')?.connection === 'online', 25_000)
      await waitFor(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'succeeded', 40_000, 'succeeded after resend')
      const runId = hub.ctx.orchestrator.getTask(task.id)!.runs[0]!.id
      const finished = hub.ctx.store.repos.prepare("SELECT seq FROM task_logs WHERE run_id = ? AND kind = 'finished'").all(runId)
      expect(finished).toHaveLength(1)
      assertRunLogContinuity(hub.ctx.store.repos, runId)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (worker) await stopWorker(worker)
      await proxy?.close()
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 150_000)
})

describe('WK-13 / WK-15 进程生命周期', () => {
  it('WK-13 单实例锁：第二个实例退出码 3', async () => {
    const { hub, cleanup } = await startHub()
    const dir = tempDirFor('pi-wk13-')
    let first: SpawnedWorker | undefined
    try {
      const { identity, configPath } = writeWorkerConfig(dir, 'wk13', wsUrl(hub.address!), join(dir, 'repo'))
      await enroll(hub, 'wk13', { ...identity, workerId: 'wk13' } as never)
      first = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk13')?.connection === 'online', 20_000)
      const second = spawnWorker(dir, configPath)
      expect(await second.exited, second.stderr()).toBe(3)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (first) await stopWorker(first)
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 90_000)

  it('WK-15 4403 已吊销：Worker 告警并以非 0 退出（停止重连）', async () => {
    const { hub, cleanup } = await startHub()
    const dir = tempDirFor('pi-wk15-')
    let worker: SpawnedWorker | undefined
    try {
      const { identity, configPath } = writeWorkerConfig(dir, 'wk15', wsUrl(hub.address!), join(dir, 'repo'))
      await enroll(hub, 'wk15', { ...identity, workerId: 'wk15' } as never)
      worker = spawnWorker(dir, configPath)
      await waitFor(() => hub.ctx.store.repos.workers.get('wk15')?.connection === 'online', 20_000)
      await hub.ctx.workers.revoke('wk15', { type: 'owner', id: 'owner', channel: 'dashboard' })
      const code = await Promise.race([worker.exited, sleep(20_000).then(() => null)])
      expect(code, worker.stderr()).toBe(1)
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (worker) await stopWorker(worker)
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 90_000)

  it('WK-15 4426 协议版本不支持：Worker 停止重连并以非 0 退出', async () => {
    const dir = tempDirFor('pi-wk15b-')
    let worker: SpawnedWorker | undefined
    const sockets = new Set<WebSocket>()
    const wss = new WebSocketServer({ port: 0 })
    try {
      await new Promise<void>(resolveListen => wss.once('listening', () => resolveListen()))
      const port = (wss.address() as { port: number }).port
      wss.on('connection', socket => {
        sockets.add(socket)
        socket.send(JSON.stringify({ v: 1, id: 'A'.repeat(26), ts: Date.now(), type: 'hub.challenge',
          payload: { nonce: 'a'.repeat(43), hubBootId: 'boot-12345678', serverTime: Date.now(), protocolVersions: [2] } }))
      })
      const { configPath } = writeWorkerConfig(dir, 'wk15b', 'ws://localhost:' + port + '/ws/worker', join(dir, 'repo'))
      worker = spawnWorker(dir, configPath)
      const code = await Promise.race([worker.exited, sleep(25_000).then(() => null)])
      expect(code, worker.stderr()).toBe(1)
    } finally {
      if (worker) await stopWorker(worker)
      for (const socket of sockets) socket.terminate()
      await new Promise<void>(resolveClose => wss.close(() => resolveClose()))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('WK-15 4401 签名失败：Worker 长退避（不立即重连）', async () => {
    const { hub, cleanup } = await startHub()
    const dir = tempDirFor('pi-wk15c-')
    let worker: SpawnedWorker | undefined
    try {
      // Hub 注册的是另一把公钥，Worker 用自己 identity.key 的私钥签名 → 4401
      const wrong = loadIdentity(join(dir, 'wrong.key'), true)
      await enroll(hub, 'wk15c', { ...wrong, workerId: 'wk15c' } as never)
      const { configPath } = writeWorkerConfig(dir, 'wk15c', wsUrl(hub.address!), join(dir, 'repo'))
      worker = spawnWorker(dir, configPath)
      await sleep(5_000)
      expect(hub.ctx.store.repos.workers.get('wk15c')!.connectionEpoch).toBe(0)
      expect(worker.child.exitCode).toBeNull()
      expect(worker.stderr()).toContain('Worker authentication failed')
      assertInvariants(hub.ctx.store.repos)
    } finally {
      if (worker) await stopWorker(worker)
      rmSync(dir, { recursive: true, force: true })
      await cleanup()
    }
  }, 90_000)
})

function tempDirFor(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
