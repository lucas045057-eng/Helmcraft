/**
 * Pi 独立验收 · Phase 4 安全门禁（SEC-15 / SEC-16 / SEC-17）
 *
 * SEC-15 CSRF 与 dashboard-static 路径穿越
 * SEC-16 `/ws/dashboard` 升级鉴权（Cookie/Origin/子协议/连接数）
 * SEC-17 登录暴力限速与 API Token scope 隔离
 */
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { DashClient } from './pi/dash.js'
import { expectError, login, openHarness, rest, settings, useAdminToken } from './pi/rest.js'

useAdminToken()

const ORIGIN = 'http://127.0.0.1'

function upgradeStatus(address: string, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(address)
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'GET',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('pi-acceptance-01').toString('base64'), ...headers } })
    request.on('response', response => { response.resume(); resolve(response.statusCode ?? 0) })
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 101) })
    request.on('error', reject)
    request.end()
  })
}

it('SEC-15 会话变更请求缺少或错误 CSRF / Origin 均返回 403 CSRF_FAILED', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  try {
    const session = await login(call)
    const payload = { prompt: 'csrf', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' }
    // POST / PUT / DELETE 三类变更全部受保护
    for (const [method, url, body] of [
      ['POST', '/api/v1/tasks', payload],
      ['PUT', '/api/v1/config/policies', { rules: [], expectedRevision: 0 }],
      ['DELETE', '/api/v1/api-tokens/whatever', undefined],
      ['POST', '/api/v1/auth/logout', undefined],
    ] as const) {
      const missing = await call(method, url, { cookie: session.cookie, origin: ORIGIN, ...(body !== undefined && { payload: body }) })
      expectError(missing, 403, 'CSRF_FAILED')
      const wrong = await call(method, url, { cookie: session.cookie, origin: ORIGIN, csrf: 'x'.repeat(43),
        ...(body !== undefined && { payload: body }) })
      expectError(wrong, 403, 'CSRF_FAILED')
    }
    // Origin 不在白名单（即便 CSRF 正确）
    expectError(await call('POST', '/api/v1/tasks', { cookie: session.cookie, csrf: session.csrfToken, origin: 'https://evil.test', payload }),
      403, 'CSRF_FAILED')
    // Origin 缺失
    expectError(await call('POST', '/api/v1/tasks', { cookie: session.cookie, csrf: session.csrfToken, payload }), 403, 'CSRF_FAILED')
    // 正确 CSRF + 白名单 Origin 通过
    expect((await call('POST', '/api/v1/tasks', { cookie: session.cookie, csrf: session.csrfToken, origin: ORIGIN, payload })).status).toBe(201)
  } finally { await cleanup() }
})

it('SEC-15 dashboard-static 不得读出 dist 之外的文件（含编码绕过与符号链接）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-static-'))
  const site = join(root, 'site')
  mkdirSync(join(site, 'assets'), { recursive: true })
  writeFileSync(join(site, 'index.html'), '<main>spa-index</main>')
  writeFileSync(join(site, 'assets', 'app.js'), 'export const ok = 1\n')
  const secret = 'TOP-SECRET-DO-NOT-SERVE'
  writeFileSync(join(root, 'secret.txt'), secret)
  writeFileSync(join(root, 'outside.txt'), secret)
  try { symlinkSync(join(root, 'secret.txt'), join(site, 'link.txt')) } catch { /* Windows 需要特权，忽略 */ }
  const { hub, cleanup } = await openHarness({ ...settings, dashboard: { ...settings.dashboard, distDir: site } }, { listen: false })
  const call = rest(hub)
  try {
    expect((await call('GET', '/')).body).toBe('<main>spa-index</main>')
    expect((await call('GET', '/assets/app.js')).body).toBe('export const ok = 1\n')
    expect((await call('GET', '/tasks/overview')).body).toBe('<main>spa-index</main>')
    expect(String((await call('GET', '/assets/app.js')).header('x-content-type-options'))).toBe('nosniff')

    const attacks = [
      '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt',
      '/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/....//secret.txt',
      '/..%5csecret.txt', '/%5c..%5csecret.txt', '/C:%5cWindows%5cwin.ini', '/%5c%5cserver%5cshare%5csecret.txt',
      '/link.txt', '/assets/link.txt', '/secret.txt',
    ]
    for (const attack of attacks) {
      const response = await call('GET', attack)
      expect({ attack, leaked: response.body.includes(secret) }).toEqual({ attack, leaked: false })
      expect([200, 400, 404]).toContain(response.status)
    }
    // 非 GET 方法不得穿透到文件系统
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await call(method, '/index.html', { payload: {} })
      expect(response.body).not.toContain(secret)
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
  } finally { await cleanup(); rmSync(root, { recursive: true, force: true }) }
})

it('SEC-16 /ws/dashboard 升级：未登录/错误 Origin/缺失子协议一律拒绝', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  const read = hub.ctx.auth.createApiToken('pi-sec16', ['read'])
  const wsPath = '/ws/dashboard'
  try {
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, 'sec-websocket-protocol': 'agent-hub.dashboard.v1' })).toBe(401)
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, 'sec-websocket-protocol': 'agent-hub.dashboard.v1',
      authorization: 'Bearer ahk_not-a-real-token' })).toBe(401)
    expect(await upgradeStatus(url, wsPath, { origin: 'https://evil.test', 'sec-websocket-protocol': 'agent-hub.dashboard.v1',
      authorization: 'Bearer ' + read })).toBe(403)
    expect(await upgradeStatus(url, wsPath, { 'sec-websocket-protocol': 'agent-hub.dashboard.v1',
      authorization: 'Bearer ' + read })).toBe(403)
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, authorization: 'Bearer ' + read })).toBe(403)
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, 'sec-websocket-protocol': 'agent-hub.worker.v1',
      authorization: 'Bearer ' + read })).toBe(403)
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, 'sec-websocket-protocol': 'agent-hub.dashboard.v1',
      authorization: 'Bearer ' + read })).toBe(101)

    // 吊销后续传的连接与升级都必须失败
    const created = await rest(hub)('POST', '/api/v1/api-tokens', { token: read, payload: { name: 'stale', scopes: ['read'] } })
    expect(created.status).toBe(403) // read scope 不能创建令牌
    const admin = hub.ctx.auth.createApiToken('pi-sec16-admin', ['admin'])
    const issued = await rest(hub)('POST', '/api/v1/api-tokens', { token: admin, payload: { name: 'to-revoke', scopes: ['read'] } })
    const issuedToken = issued.json<{ id: string; token: string }>()
    const live = await DashClient.open(url, { token: issuedToken.token })
    live.send({ t: 'hello' })
    await live.waitWelcome()
    await rest(hub)('DELETE', '/api/v1/api-tokens/' + issuedToken.id, { token: admin })
    expect(await live.waitClose()).toBe(4001)
    expect(await upgradeStatus(url, wsPath, { origin: ORIGIN, 'sec-websocket-protocol': 'agent-hub.dashboard.v1',
      authorization: 'Bearer ' + issuedToken.token })).toBe(401)
  } finally { await cleanup() }
})

it('SEC-16 每一会话凭证第 6 条 WS 连接被 4029 拒绝，前 5 条保持可用', async () => {
  const { hub, cleanup, url } = await openHarness(settings)
  const read = hub.ctx.auth.createApiToken('pi-sec16-limit', ['read'])
  const peers: DashClient[] = []
  try {
    for (let index = 0; index < 5; index++) {
      const client = await DashClient.open(url, { token: read })
      peers.push(client)
      client.send({ t: 'hello' })
      await client.waitWelcome()
    }
    const sixth = await DashClient.open(url, { token: read })
    peers.push(sixth)
    expect(await sixth.waitClose()).toBe(4029)
    expect(peers.slice(0, 5).every(client => client.closeCode === undefined)).toBe(true)
    // 关闭一条后可以再次建立
    await peers[0]!.close()
    const replacement = await DashClient.open(url, { token: read })
    peers.push(replacement)
    replacement.send({ t: 'hello' })
    expect((await replacement.waitWelcome()).resumed).toBe(false)
  } finally { for (const client of peers) client.terminate(); await cleanup() }
})

it('SEC-17 登录失败 5 次后第 6 次返回 429 RATE_LIMITED 且带 Retry-After', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  try {
    // 成功登录会清空失败计数
    await login(call)
    for (let attempt = 1; attempt <= 5; attempt++) {
      const failure = await call('POST', '/api/v1/auth/login', { payload: { token: 'wrong-' + attempt }, origin: ORIGIN })
      expectError(failure, 401, 'UNAUTHENTICATED')
    }
    const limited = await call('POST', '/api/v1/auth/login', { payload: { token: 'wrong-6' }, origin: ORIGIN })
    expectError(limited, 429, 'RATE_LIMITED')
    const retryAfter = Number(limited.header('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(900)
    // 即便提供正确令牌，限速窗口内仍然 429
    expectError(await call('POST', '/api/v1/auth/login', { payload: { token: 'pi-phase4-admin-token-' + 'k'.repeat(32) }, origin: ORIGIN }),
      429, 'RATE_LIMITED')
  } finally { await cleanup() }
})

it('SEC-17 API Token scope 隔离：read ⊄ operate ⊄ admin', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  const admin = hub.ctx.auth.createApiToken('pi-scope-admin', ['admin'])
  const operate = hub.ctx.auth.createApiToken('pi-scope-operate', ['operate'])
  const read = hub.ctx.auth.createApiToken('pi-scope-read', ['read'])
  try {
    const task = await call('POST', '/api/v1/tasks', { token: operate, payload: { prompt: 'scope', workspaceId: 'sandbox',
      adapter: 'mock', profile: 'readonly' } })
    expect(task.status).toBe(201)
    const taskId = task.json<{ id: string; version: number }>()
    const taskPath = '/api/v1/tasks/' + taskId.id

    const operateOnly = [
      ['GET', '/api/v1/system/metrics'],
      ['GET', '/api/v1/system/fibers'],
      ['GET', '/api/v1/audit'],
      ['GET', '/api/v1/config/policies'],
      ['PUT', '/api/v1/config/policies'],
      ['GET', '/api/v1/api-tokens'],
      ['POST', '/api/v1/api-tokens'],
      ['DELETE', '/api/v1/api-tokens/anything'],
      ['POST', '/api/v1/workers/pi-scope-worker/revoke'],
      ['POST', '/api/v1/workers/enroll-tokens'],
    ] as const
    for (const [method, url] of operateOnly) {
      expectError(await call(method, url, { token: operate, payload: method === 'GET' || method === 'DELETE' ? undefined : {} }),
        403, 'FORBIDDEN')
    }
    const readForbidden = [
      ['POST', '/api/v1/tasks'],
      ['POST', taskPath + '/cancel'],
      ['POST', taskPath + '/approve'],
      ['POST', taskPath + '/retry'],
      ['POST', '/api/v1/workers/pi-scope-worker/drain'],
      ['POST', '/api/v1/workers/pi-scope-worker/probe'],
      ['GET', '/api/v1/system/metrics'],
      ['GET', '/api/v1/api-tokens'],
    ] as const
    for (const [method, url] of readForbidden) {
      expectError(await call(method, url, { token: read, payload: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN')
    }
    // read 允许只读
    for (const url of ['/api/v1/overview', '/api/v1/tasks', taskPath, '/api/v1/workers']) {
      expect((await call('GET', url, { token: read })).status).toBe(200)
    }
    // operate 允许任务操作
    expect((await call('POST', taskPath + '/cancel', { token: operate, payload: {} })).status).toBe(200)
    // admin 全部允许
    expect((await call('GET', '/api/v1/system/metrics', { token: admin })).status).toBe(200)
    expect((await call('POST', '/api/v1/api-tokens', { token: admin, payload: { name: 'x', scopes: ['read'] } })).status).toBe(201)
    // 无 scope 的伪造令牌无法通过鉴权
    expect((await call('GET', '/api/v1/overview', { token: 'ahk_' + 'A'.repeat(43) })).status).toBe(401)
  } finally { await cleanup() }
})
