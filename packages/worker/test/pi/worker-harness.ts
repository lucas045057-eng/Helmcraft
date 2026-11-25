/**
 * Pi 独立验收 · Worker 侧测试基础设施
 */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runId, taskId, ulid } from '@agent-hub/common'
import type { AdapterCapability, CmdAckPayload, WorkspaceDecl } from '@agent-hub/protocol'
import { createTestHub } from '../../../hub/src/app.js'
import type { TestHub } from '../../../hub/src/app.js'
import { startWorker } from '../../src/app.js'
import { WorkerConfigSchema } from '../../src/config/schema.js'
import type { WorkerIdentity } from '../../src/identity.js'

export interface EnrolledIdentity extends WorkerIdentity { workerId: string }

export async function startHub(config: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-wk-hub-'))
  const hub = await createTestHub({
    server: { port: 0, allowInsecureWorker: true, ...(config.server as object | undefined) },
    storage: { path: join(dir, 'hub.sqlite'), ...(config.storage as object | undefined) },
    workers: { ackIntervalMs: 20, ...(config.workers as object | undefined) },
    ...config,
  } as never, options as never)
  return { dir, hub, cleanup: async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }) } }
}

export async function enroll(hub: TestHub, workerId: string, identity = newWorkerIdentity(workerId)) {
  const { token } = hub.ctx.auth.createEnrollToken({ type: 'owner', id: 'owner', channel: 'dashboard' }, workerId)
  hub.ctx.auth.enroll({ token, workerId, publicKey: identity.publicKey, hostname: 'pi', os: process.platform as 'win32' },
    '127.0.0.1')
  return identity
}

export function newWorkerIdentity(workerId: string): EnrolledIdentity {
  const { privateKey } = generateKeyPairSync('ed25519')
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return { workerId, privateKey, publicKey: der.toString('base64'),
    fingerprint: createHash('sha256').update(der).digest('base64url').slice(0, 16) }
}

export function wsUrl(address: string) {
  const url = new URL('/ws/worker', address)
  url.protocol = 'ws:'
  return url.href
}

export function workerConfig(workerId: string, url: string, workspacePath: string, overrides: Record<string, unknown> = {}) {
  return WorkerConfigSchema.parse({
    workerId,
    hub: { url },
    maxConcurrency: 2,
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspacePath, allowedAdapters: ['mock'], maxProfile: 'full',
      maxConcurrent: 2 }],
    ...overrides,
  })
}

export async function startWorkerAt(hub: TestHub, identity: EnrolledIdentity, options: {
  dir: string
  config?: Record<string, unknown>
  clock?: unknown
  configPath?: string
  onStop?: (code: number) => void
  onWarning?: (message: string) => void
  random?: () => number
}) {
  mkdirSync(join(options.dir, 'repo'), { recursive: true })
  const config = workerConfig(identity.workerId, wsUrl(hub.address!), join(options.dir, 'repo'), options.config)
  return startWorker(config, {
    stateDir: join(options.dir, 'state'),
    ...(options.clock && { clock: options.clock as never }),
    ...(options.configPath && { configPath: options.configPath }),
    ...(options.onStop && { onStop: options.onStop }),
    ...(options.onWarning && { onWarning: options.onWarning }),
    ...(options.random && { random: options.random }),
    identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint },
  })
}

export function tempDir(prefix = 'pi-wk-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface SeededRun { taskId: string; runId: string }

export function seedRun(hub: TestHub, workerId: string, options: {
  taskStatus?: string
  runStatus?: string
  profile?: string
  workspaceId?: string
  timeoutMs?: number
} = {}): SeededRun {
  const now = hub.ctx.clock.now()
  const task = taskId(now), run = runId(now)
  hub.ctx.store.tx(db => {
    db.tasks.insert({ id: task, status: (options.taskStatus ?? 'dispatching') as never, version: 1, source: 'dashboard',
      originJson: { source: 'dashboard' }, requesterType: 'owner', requesterId: 'dashboard:owner', title: 'seed',
      prompt: 'seed', workspaceId: options.workspaceId ?? 'sandbox', profile: (options.profile ?? 'edit') as never,
      timeoutMs: options.timeoutMs ?? 600_000, maxAttempts: 3, attemptCount: 1, runSeq: 1,
      policyDecisionJson: { ruleId: null, decision: 'auto_approve' }, currentRunId: run, createdAt: now, updatedAt: now })
    db.prepare('INSERT INTO task_runs (id, task_id, run_seq, attempt, worker_id, adapter, workspace_id, profile, status, '
      + 'not_after, dispatched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(run, task, 1, 1, workerId, 'mock',
      options.workspaceId ?? 'sandbox', options.profile ?? 'edit', options.runStatus ?? 'dispatching', now + 120_000, now)
  })
  return { taskId: task, runId: run }
}

export function dispatchPayload(seed: SeededRun, overrides: Record<string, unknown> = {}) {
  return {
    taskId: seed.taskId,
    runId: seed.runId,
    taskNo: 1,
    attempt: 1,
    adapter: 'mock',
    workspaceId: 'sandbox',
    profile: 'edit',
    prompt: '#scenario: success',
    timeoutMs: 60_000,
    idleTimeoutMs: 60_000,
    notAfter: Date.now() + 120_000,
    origin: { source: 'dashboard' as const, actorType: 'owner' as const },
    ...overrides,
  }
}

export function command(type: string, payload: unknown, ts = Date.now()) {
  return { v: 1 as const, id: ulid(ts), ts, type, payload } as never
}

export async function send(hub: TestHub, workerId: string, frame: ReturnType<typeof command>): Promise<CmdAckPayload> {
  return hub.ctx.workers.send(workerId, frame)
}

export const readyMock: AdapterCapability[] = [{ id: 'mock', status: 'ready', version: '0.1.0',
  features: { resume: true, liveInput: true, structuredOutput: true } }]
export const sandboxDecl: WorkspaceDecl = { id: 'sandbox', label: 'Sandbox', allowedAdapters: ['mock'], maxProfile: 'full',
  maxConcurrent: 2, isGitRepo: false }

export async function waitFor<T>(fn: () => T | undefined, timeoutMs = 8000, label = ''): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out' + (label ? ': ' + label : ''))
}
