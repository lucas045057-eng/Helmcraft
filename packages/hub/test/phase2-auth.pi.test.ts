/**
 * Pi 独立验收 · Phase 2 门禁：SEC-9 / SEC-21 / SEC-22（Hub 侧安全）
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { openHarness, ownerActor } from './pi/harness.js'

it('SEC-9 Requester 请求 full → 策略 H1 clamp 为 edit 且需审批', async () => {
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true } }, { listen: false })
  try {
    const requester = { type: 'requester', id: 'req-sec9', channel: 'api' } as const
    const outcome = hub.ctx.policy.evaluate({ actor: requester, source: 'api', workspaceId: 'sandbox', profile: 'full', prompt: 'x' })
    expect(outcome.decision).toBe('require_approval')
    expect(outcome.clampedProfile).toBe('edit')
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'needs full', workspaceId: 'sandbox', profile: 'full' }, requester)
    expect(task.profile).toBe('edit')
    expect(task.status).toBe('awaiting_approval')
    expect(task.policyDecision).toMatchObject({ decision: 'require_approval', clampedProfile: 'edit' })
    // Owner 请求 full 且无规则 → auto_approve，但 H2 强制 require_approval（仅 requester 的 H1 钳制 profile）
    const owner = hub.ctx.policy.evaluate({ actor: ownerActor, source: 'dashboard', workspaceId: 'sandbox', profile: 'full', prompt: 'x' })
    expect(owner.decision).toBe('auto_approve')
  } finally { await cleanup() }
})

it('SEC-21 enroll token：过期 / 错误 / 重复使用 / suggestedWorkerId 不符 全部拒绝', async () => {
  const clock = new FakeClock(1_000)
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true } }, { clock, listen: false })
  try {
    const identity = (await import('./pi/harness.js')).newIdentity('sec21')
    const enroll = (token: string, workerId = 'sec21') => hub.ctx.auth.enroll({ token, workerId,
      publicKey: identity.publicKey, hostname: 'h', os: 'win32' }, '10.0.0.' + Math.floor(Math.random() * 200))
    // 错误 token
    expect(() => enroll('not-a-token')).toThrow()
    // 过期 token
    const expired = hub.ctx.auth.createEnrollToken(ownerActor, 'sec21-expired')
    clock.advance(600_001)
    expect(() => enroll(expired.token, 'sec21-expired')).toThrow()
    // suggestedWorkerId 不符
    const suggested = hub.ctx.auth.createEnrollToken(ownerActor, 'sec21-expected')
    expect(() => enroll(suggested.token, 'sec21-other')).toThrow()
    // 成功一次后再次使用 → 拒绝
    const fresh = hub.ctx.auth.createEnrollToken(ownerActor, 'sec21-expected')
    expect(enroll(fresh.token, 'sec21-expected')).toMatchObject({ workerId: 'sec21-expected' })
    expect(() => enroll(fresh.token, 'sec21-expected')).toThrow()
    // token 明文不落库，仅哈希
    const row = hub.ctx.store.repos.enroll.find(createHash('sha256').update(fresh.token).digest('hex'))
    expect(row?.usedAt).not.toBeNull()
    expect(JSON.stringify(row)).not.toContain(fresh.token)
  } finally { await cleanup() }
})

it('SEC-22 DB 中不存在任何明文密钥（admin token / API token / enroll token / 会话 cookie）', async () => {
  const adminToken = 'admin-' + 'A'.repeat(30)
  const digest = createHash('sha256').update(adminToken).digest('hex')
  vi.stubEnv('HUB_ADMIN_TOKEN_SHA256', digest)
  const { dir, hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true },
    dashboard: { allowedOrigins: ['https://hub.test'] } })
  try {
    const apiToken = hub.ctx.auth.createApiToken('sec22', ['admin'])
    const enroll = hub.ctx.auth.createEnrollToken(ownerActor, 'sec22-worker')
    const session = hub.ctx.auth.login(adminToken, { ip: '127.0.0.1' })
    const secrets = [adminToken, digest, apiToken, apiToken.slice(4), enroll.token, session.sessionId]
    await hub.close()
    const bytes = readFileSync(join(dir, 'hub.sqlite'))
    const text = bytes.toString('latin1')
    for (const secret of secrets) {
      expect(text, 'plaintext secret found in DB: ' + secret.slice(0, 8) + '…').not.toContain(secret)
    }
    // 哈希确实写入（可反查）
    expect(text).toContain(createHash('sha256').update(apiToken).digest('hex'))
    expect(text).toContain(createHash('sha256').update(session.sessionId).digest('hex'))
  } finally {
    vi.unstubAllEnvs()
    await cleanup()
  }
})
