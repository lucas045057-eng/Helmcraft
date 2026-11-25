/**
 * Pi 独立验收 · Phase 2 门禁：E2E-7（Hub 重启期间任务不中断）
 *
 * 以独立 Hub 子进程 + 独立 Worker 子进程验证：
 *  Hub 优雅关闭（等价 SIGTERM 处理路径）→ Worker 保留本机 CLI 进程并重连 → 任务继续并成功。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { expect, it } from 'vitest'
import { createTestHub } from '../src/app.js'
import { assertInvariants, assertRunLogContinuity, delay, eventually, newIdentity } from './pi/harness.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const hubMain = pathToFileURL(resolve(repoRoot, 'packages/hub/dist/app.js')).href
const workerCli = resolve(repoRoot, 'packages/worker/bin/agent-worker.mjs')

interface HubProcess { child: ChildProcess; address: string; request(command: string): void; exited: Promise<number | null> }

const launcher = `
import { createHub } from ${JSON.stringify(hubMain)}
const config = JSON.parse(process.argv[2])
const hub = await createHub(config, { log: line => process.stdout.write(line + '\\n') })
process.stdout.write(JSON.stringify({ address: hub.address }) + '\\n')
let stopping = false
const stop = async () => { if (stopping) return; stopping = true; try { await hub.close(); process.exit(0) } catch { process.exit(1) } }
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
process.stdin.on('data', data => { if (data.toString().includes('shutdown')) void stop() })
process.stdin.resume()
`

async function startHubProcess(config: Record<string, unknown>): Promise<HubProcess> {
  const dir = mkdtempSync(join(tmpdir(), 'pi-e2e7-launch-'))
  const script = join(dir, 'hub-launcher.mjs')
  writeFileSync(script, launcher)
  const child = spawn(process.execPath, [script, JSON.stringify(config)], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const address = await new Promise<string>((resolveAddress, rejectAddress) => {
    let buffered = ''
    const timer = setTimeout(() => rejectAddress(new Error('hub did not start: ' + buffered + '\n' + stderr)), 20_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      for (const line of buffered.split('\n')) {
        if (!line.startsWith('{"address"')) continue
        clearTimeout(timer)
        resolveAddress((JSON.parse(line) as { address: string }).address)
      }
    })
    child.once('exit', code => { clearTimeout(timer); rejectAddress(new Error('hub exited ' + code + '\n' + stderr)) })
  })
  const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))
  return { child, address, request: command => child.stdin!.write(command + '\n'), exited }
}

it('E2E-7 Hub 优雅重启（SIGTERM 语义）期间任务不中断，新 Hub 恢复后任务 succeeded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-e2e7-'))
  const dbPath = join(dir, 'hub.sqlite')
  const workspace = join(dir, 'repo')
  mkdirSync(workspace)
  const identity = newIdentity('e2e7')
  const identityPath = join(dir, 'identity.key')
  writeFileSync(identityPath, identity.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
  let hubProcess: HubProcess | undefined
  let worker: ChildProcess | undefined
  let token = ''
  try {
    // 预置：创建库、注册 Worker 身份、签发 API token（随后由独立 Hub 进程接管同一 DB 文件）
    const seed = await createTestHub({ storage: { path: dbPath }, server: { port: 0, allowInsecureWorker: true } },
      { listen: false })
    try {
      seed.ctx.auth.enroll({ token: seed.ctx.auth.createEnrollToken({ type: 'owner', id: 'owner', channel: 'dashboard' }, 'e2e7').token,
        workerId: 'e2e7', publicKey: identity.publicKey, hostname: 'pi', os: process.platform as 'win32' }, '127.0.0.1')
      token = seed.ctx.auth.createApiToken('e2e7', ['admin'])
    } finally { await seed.close() }

    const config = { server: { host: '127.0.0.1', port: 0, allowInsecureWorker: true }, storage: { path: dbPath },
      workers: { gracePeriodMs: 60_000 } }
    hubProcess = await startHubProcess(config)
    const port = new URL(hubProcess.address).port
    const wsAddress = 'ws://127.0.0.1:' + port + '/ws/worker'
    writeFileSync(join(dir, 'worker.yaml'), stringify({ workerId: 'e2e7', hub: { url: wsAddress, identityPath: 'identity.key' },
      maxConcurrency: 1, adapters: { mock: { enabled: true } }, localLogs: { dir: join(dir, 'runs') },
      workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'full' }] }))
    worker = spawn(process.execPath, [workerCli, 'run', '--config', join(dir, 'worker.yaml')],
      { cwd: repoRoot, env: { ...process.env, LOCALAPPDATA: join(dir, 'home'), APPDATA: join(dir, 'home') }, stdio: 'ignore' })

    const api = async (method: 'GET' | 'POST', path: string, payload?: object) => {
      const response = await fetch(new URL('/api/v1' + path, hubProcess!.address), { method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(payload && { body: JSON.stringify(payload) }) })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    await eventually(async () => {
      const workers = await api('GET', '/workers')
      return (workers.body as unknown as Array<{ connection: string }>).some(worker => worker.connection === 'online')
    }, { timeoutMs: 20_000, label: 'worker online (external hub)' })

    const created = await api('POST', '/tasks', { prompt: '#scenario: slow ms=12000', workspaceId: 'sandbox', adapter: 'mock' })
    expect(created.status).toBe(201)
    const taskId = created.body.id as string
    await eventually(async () => (await api('GET', '/tasks/' + taskId)).body.status === 'running', { timeoutMs: 20_000, label: 'running' })
    const running = (await api('GET', '/tasks/' + taskId)).body as { runs: Array<{ id: string; pid: number | null }> }
    const runId = running.runs[0]!.id
    const pid = await eventually(async () => {
      const detail = (await api('GET', '/tasks/' + taskId)).body as { runs: Array<{ pid: number | null }> }
      return detail.runs[0]?.pid ?? undefined
    }, { timeoutMs: 20_000, label: 'cli pid' })

    // 关闭 Hub 进程（优雅路径）→ Worker 保留 CLI 进程
    hubProcess.request('shutdown')
    expect(await hubProcess.exited).toBe(0)
    await delay(500)
    expect(worker.exitCode).toBeNull()
    expect(() => process.kill(pid, 0)).not.toThrow()

    // 用同一 DB/端口重启 Hub
    hubProcess = await startHubProcess({ ...config, server: { ...config.server, port: Number(port) } })
    await eventually(async () => (await api('GET', '/tasks/' + taskId)).body.status === 'succeeded', { timeoutMs: 60_000, label: 'succeeded after restart' })
    const detail = (await api('GET', '/tasks/' + taskId)).body as { runs: Array<{ id: string; pid: number; status: string }> }
    expect(detail.runs).toHaveLength(1)
    expect(detail.runs[0]!.pid).toBe(pid)
    expect(detail.runs[0]!.status).toBe('succeeded')
    const logs = await api('GET', '/tasks/' + taskId + '/runs/' + runId + '/logs?limit=1000')
    const entries = (logs.body as { entries: Array<{ seq: number; kind: string }> }).entries
    const seqs = entries.map(entry => entry.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1))
    expect(entries.filter(entry => entry.kind === 'started')).toHaveLength(1)
    expect(entries.at(-1)!.kind).toBe('finished')
  } finally {
    hubProcess?.child.kill('SIGKILL')
    worker?.kill('SIGKILL')
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* identity.key ACL 受限，交由系统临时目录清理 */ }
  }
}, 180_000)

void assertInvariants
void assertRunLogContinuity
