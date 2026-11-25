import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { createTestHub } from '../src/app.js'
import { waitForActive } from '../src/kernel/lifecycle.js'

it('reattaches dashboard routes after the Worker provider and its consumers restart', async () => {
  const hub = await createTestHub({ storage: { path: ':memory:' }, server: { port: 0 } })
  try {
    const token = hub.ctx.auth.createApiToken('test', ['read'])
    const path = '/api/v1/overview'
    const from = hub.ctx.workers.bootId
    const request = () => fetch(new URL(path, hub.address), { headers: { Authorization: 'Bearer ' + token } })
    expect((await request()).status).toBe(200)
    await hub.fibers.get('workers')!.restart()
    expect(await waitForActive(hub.ctx, hub.fibers.values())).toEqual({ success: true })
    expect(hub.ctx.workers.bootId).not.toBe(from)
    expect((await request()).status).toBe(200)
  } finally { await hub.close() }
})

it('applies session origin/CSRF checks, sliding expiry and scope boundaries', async () => {
  const clock = new FakeClock(1000)
  const hub = await createTestHub({ storage: { path: ':memory:' },
    dashboard: { allowedOrigins: ['https://hub.test'], sessionTtlMs: 10_000 } }, { clock, listen: false })
  const token = 's'.repeat(32)
  vi.stubEnv('HUB_ADMIN_TOKEN_SHA256', createHash('sha256').update(token).digest('hex'))
  try {
    const app = hub.ctx.http.app
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { token } })
    expect(login.statusCode).toBe(200)
    const cookieHeader = login.headers['set-cookie'] as string
    expect(cookieHeader).toContain('HttpOnly; Secure; SameSite=Strict')
    const cookie = cookieHeader.split(';')[0]!
    const csrf = login.json<{ csrfToken: string }>().csrfToken
    const reject = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin: 'https://other.test', 'x-csrf-token': csrf } })
    expect(reject.statusCode).toBe(403)
    clock.advance(6000)
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })
    expect(me.headers['set-cookie']).toContain('Max-Age=10')
    const read = hub.ctx.auth.createApiToken('read-only', ['read'])
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/system/fibers', headers: { authorization: 'Bearer ' + read } })
    expect(forbidden.statusCode).toBe(403)
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin: 'https://hub.test', 'x-csrf-token': csrf } })
    expect(logout.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401)
  } finally { vi.unstubAllEnvs(); await hub.close() }
})

it('rebuilds approval deadlines when a Hub opens the same SQLite file', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hub-timer-')), clock = new FakeClock(1000)
  const config = { storage: { path: join(dir, 'hub.sqlite') }, orchestrator: { tasks: { approvalTimeoutMs: 2000 } } }
  let hub = await createTestHub(config, { clock, listen: false })
  try {
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'Review pending', workspaceId: 'sandbox' },
      { type: 'requester', id: 'r', channel: 'api' })
    expect(task.status).toBe('awaiting_approval')
    await hub.close()
    clock.advance(1000)
    hub = await createTestHub(config, { clock, listen: false })
    clock.advance(1000)
    await expect.poll(() => hub.ctx.orchestrator.getTask(task.id)?.status).toBe('cancelled')
    expect(hub.ctx.orchestrator.metrics().mutexKeys).toBe(0)
  } finally { await hub.close(); rmSync(dir, { force: true, recursive: true }) }
})


it('commits result approval before delivery and reuses the same delivery key on retry', async () => {
  const hub = await createTestHub({ storage: { path: ':memory:' } }, { listen: false })
  try {
    const task = hub.ctx.store.tx(db => db.tasks.insert({
      id: 'review', status: 'succeeded', version: 3, source: 'feishu', originJson: { source: 'feishu' },
      requesterType: 'requester', requesterId: 'requester', title: 'review', prompt: 'prompt', workspaceId: 'sandbox',
      profile: 'readonly', timeoutMs: 60_000, resultSummary: 'original', resultDeliveryStatus: 'pending_review',
      policyDecisionJson: { ruleId: null, decision: 'require_approval' }, createdAt: 1, updatedAt: 1,
    }))
    const sent: string[] = []
    const orchestrator = hub.ctx.orchestrator
    orchestrator.setResultSender(async (row, summary, key) => {
      expect(row).toMatchObject({ resultDeliveryStatus: 'delivered', resultDeliveredAt: null })
      expect(summary).toBe('approved')
      sent.push(key)
      if (sent.length === 1) throw new Error('Transient test failure')
    })
    const owner = { type: 'owner', id: 'owner', channel: 'dashboard' } as const
    const request = { action: 'send', summaryOverride: 'approved', expectedVersion: 3 } as const
    await expect(orchestrator.deliverResult(task.id, owner, request)).rejects.toThrow('Transient test failure')
    await expect(orchestrator.deliverResult(task.id, owner, request)).resolves.toMatchObject({ resultDeliveryStatus: 'delivered', version: 4 })
    await orchestrator.deliverResult(task.id, owner, request)
    expect(sent).toEqual(['task.result:review', 'task.result:review'])
    expect(hub.ctx.store.repos.tasks.get(task.id)?.resultDeliveredAt).not.toBeNull()
  } finally { await hub.close() }
})

