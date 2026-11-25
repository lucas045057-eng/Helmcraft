import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { TaskDetail, LogsResponse } from '@agent-hub/protocol'
import { createTestHub } from '../src/app.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

it('runs the Mock approval, log, reconnect, input, cancellation and path refusal flow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-worker-'))
  const workspace = join(dir, 'repo')
  mkdirSync(workspace)
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite') }, server: { port: 0, allowInsecureWorker: true }, workers: { ackIntervalMs: 50 } })
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined
  try {
    const token = hub.ctx.auth.createApiToken('integration', ['admin'])
    const request = async (method: 'GET' | 'POST', path: string, payload?: object, headers: Record<string, string> = {}) => {
      const response = await hub.ctx.http.app.inject({ method, url: '/api/v1' + path, headers: { authorization: 'Bearer ' + token, ...headers },
        ...(payload && { payload }) })
      expect(response.statusCode, response.body).toBeLessThan(300)
      return response.json() as unknown
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    const fingerprint = createHash('sha256').update(der).digest('base64url').slice(0, 16)
    const now = Date.now()
    const actor = { type: 'owner', id: 'integration', channel: 'dashboard' } as const
    const enroll = hub.ctx.auth.createEnrollToken(actor, 'test-worker')
    expect(enroll.expiresAt).toBeGreaterThan(now)
    hub.ctx.auth.enroll({ token: enroll.token, workerId: 'test-worker', publicKey: der.toString('base64'),
      hostname: 'test', os: process.platform as 'win32' | 'linux' | 'darwin' }, '127.0.0.1')
    const url = new URL('/ws/worker', hub.address)
    url.protocol = 'ws:'
    worker = await startWorker(WorkerConfigSchema.parse({ workerId: 'test-worker', hub: { url: url.href }, adapters: { mock: { enabled: true } },
      workspaces: [{ id: 'sandbox', label: 'Sandbox', path: workspace, allowedAdapters: ['mock'], maxProfile: 'edit' }] }),
    { stateDir: join(dir, 'worker'), random: () => 0, onWarning: () => undefined, identity: { privateKey, publicKey: der.toString('base64'), fingerprint } })
    await expect.poll(() => hub.ctx.workers.get('test-worker')?.connection).toBe('online')
    hub.ctx.policy.replaceRules([{ id: 'review', name: 'Review', priority: 1, enabled: true, match: {},
      effect: { decision: 'require_approval' } }], actor)
    const create = async (prompt: string, subdir?: string) => TaskDetail.parse(await request('POST', '/tasks',
      { prompt, workspaceId: 'sandbox', adapter: 'mock', ...(subdir && { subdir }) }, { 'idempotency-key': prompt + (subdir ?? '') }))
    const approve = async (task: TaskDetail) => {
      expect(task.status).toBe('awaiting_approval')
      await request('POST', '/tasks/' + task.taskNo + '/approve', { expectedVersion: task.version })
    }
    const get = (id: string) => hub.ctx.orchestrator.getTask(id)!
    const success = await create('#scenario: slow ms=4500')
    expect((await create('#scenario: slow ms=4500')).id).toBe(success.id)
    await approve(success)
    await expect.poll(() => get(success.id).runs[0]?.lastSeq, { timeout: 8000 }).toBeGreaterThan(1)
    const before = hub.ctx.store.repos.workers.get('test-worker')!.connectionEpoch
    worker.tunnel.reconnect()
    await expect.poll(() => hub.ctx.store.repos.workers.get('test-worker')?.connectionEpoch).toBeGreaterThan(before)
    const priorBoot = hub.ctx.workers.bootId
    await hub.fibers.get('workers')!.restart()
    expect(hub.ctx.workers.bootId).not.toBe(priorBoot)
    await expect.poll(() => hub.ctx.store.repos.workers.get('test-worker')?.connectionEpoch, { timeout: 8000 }).toBeGreaterThan(before + 1)
    await expect.poll(() => get(success.id).status, { timeout: 10_000 }).toBe('succeeded')
    const runId = get(success.id).runs[0]!.id
    const { entries, lastSeq } = LogsResponse.parse(await request('GET', '/tasks/' + success.id + '/runs/' + runId + '/logs'))
    expect(entries.map(row => row.seq)).toEqual(Array.from({ length: lastSeq }, (_, i) => i + 1))
    expect(entries.at(-1)?.kind).toBe('finished')
    expect(entries.filter(row => row.kind === 'started')).toHaveLength(1)

    const huge = await create('#scenario: huge-line bytes=1048576')
    await approve(huge)
    await expect.poll(() => get(huge.id).status, { timeout: 8000 }).toBe('succeeded')
    const hugeRun = get(huge.id).runs[0]!.id
    const hugeLogs = LogsResponse.parse(await request('GET', '/tasks/' + huge.id + '/runs/' + hugeRun + '/logs'))
    const line = hugeLogs.entries.find(entry => entry.kind === 'log' && entry.stream === 'stdout')!
    expect(Buffer.byteLength(line.text!)).toBeLessThanOrEqual(16 * 1024)
    expect(line.text).toContain('[truncated ')
    expect(readFileSync(join(dir, 'worker', 'runs', hugeRun, 'output.log')).length).toBe(1048577)

    const input = await create('#scenario: need-input')
    await approve(input)
    await expect.poll(() => get(input.id).status, { timeout: 8000 }).toBe('awaiting_input')
    await request('POST', '/tasks/' + input.id + '/input', { requestId: get(input.id).inputRequest!.requestId, answer: 'yes' })
    await expect.poll(() => get(input.id).resultSummary, { timeout: 8000 }).toBe('yes')

    const cancel = await create('#scenario: slow ms=30000')
    await approve(cancel)
    await expect.poll(() => get(cancel.id).status, { timeout: 8000 }).toBe('running')
    await request('POST', '/tasks/' + cancel.id + '/cancel', {})
    await expect.poll(() => get(cancel.id).status, { timeout: 12_000 }).toBe('cancelled')

    const unsafe = await create('#scenario: success', '../')
    await approve(unsafe)
    await expect.poll(() => get(unsafe.id).runs[0]?.status).toBe('refused')
    expect(get(unsafe.id).attempt).toBe(0)
  } finally {
    await worker?.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
