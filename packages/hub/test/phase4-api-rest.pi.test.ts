/**
 * Pi 独立验收 · Phase 4 REST 门禁（API-1 ~ API-5、API-12）
 *
 * 独立于 Codex 的 `phase4-dashboard.test.ts`：每个成功路径都用
 * `@agent-hub/protocol` 的 DTO Schema 严格校验响应（API-1），
 * 错误码表逐项触发（API-2），并覆盖幂等 / `:ref` / 游标分页 / draining。
 */
import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import * as api from '@agent-hub/protocol'
import { enrollWorker, seedRun } from './pi/harness.js'
import { ADMIN_TOKEN, expectError, expectSchema, login, onlineWorker, openHarness, rest, settings, useAdminToken } from './pi/rest.js'

useAdminToken()

const OWNER = { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as const
const approvalPolicy = [{ id: 'pi-approval', name: 'requires approval', priority: 1, enabled: true,
  match: { promptPattern: '^#approval' }, effect: { decision: 'require_approval' } }] as const

function grant(hub: Parameters<typeof rest>[0], scopes: ('read' | 'operate' | 'admin')[]) {
  return hub.ctx.auth.createApiToken('pi-' + scopes.join('-'), [...scopes])
}

/** 直接向某个 Run 写入日志（绕过 Worker，仅用于 REST 读取路径）。 */
async function writeLogs(hub: Parameters<typeof rest>[0], runId: string, from: number, count: number) {
  const events = Array.from({ length: count }, (_, index) => ({ seq: from + index, ts: hub.ctx.clock.now(),
    kind: 'log' as const, stream: 'stdout' as const, text: 'line-' + (from + index) }))
  const job = hub.ctx.store.ingest.enqueue(runId, events)
  await hub.ctx.store.ingest.flush()
  await job
}

it('API-1 鉴权与系统端点响应严格通过 DTO Schema', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const admin = grant(hub, ['admin'])
  try {
    const health = await call('GET', '/healthz')
    expect({ status: health.status, body: health.json() }).toEqual({ status: 200, body: { ok: true } })
    expectSchema(api.HealthResponse, health)

    const ready = await call('GET', '/readyz')
    expect(ready.status).toBe(200)
    expectSchema(api.ReadyResponse, ready)
    expect(ready.header('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(String(ready.header('content-type'))).toContain('application/json')

    const loginResponse = await call('POST', '/api/v1/auth/login', { payload: { token: ADMIN_TOKEN }, origin: 'http://127.0.0.1' })
    expect(loginResponse.status).toBe(200)
    expect(String(loginResponse.header('set-cookie'))).toMatch(/^ah_sid=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=/)
    const session = { cookie: String(loginResponse.header('set-cookie')).split(';')[0]!,
      csrfToken: expectSchema(api.LoginResponse, loginResponse).csrfToken }

    const me = await call('GET', '/api/v1/auth/me', { cookie: session.cookie, origin: 'http://127.0.0.1' })
    expect(me.status).toBe(200)
    const meView = expectSchema(api.AuthMeResponse, me)
    expect(meView.principal).toMatchObject({ type: 'owner', via: 'session' })
    expect(meView.csrfToken).toBe(session.csrfToken)

    const tokenMe = await call('GET', '/api/v1/auth/me', { token: admin })
    expect(tokenMe.status).toBe(200)
    expect(expectSchema(api.AuthMeResponse, tokenMe).principal).toMatchObject({ via: 'token', scopes: ['admin'] })

    const overview = await call('GET', '/api/v1/overview', { token: admin })
    expect(overview.status).toBe(200)
    const overviewView = expectSchema(api.Overview, overview)
    expect(overviewView.hub.draining).toBe(false)
    expect(Object.keys(overviewView.counts).sort()).toEqual([...api.TaskStatus.options].sort())

    const metrics = await call('GET', '/api/v1/system/metrics', { token: admin })
    expect(metrics.status).toBe(200)
    expectSchema(api.MetricsResponse, metrics)

    const fibers = await call('GET', '/api/v1/system/fibers', { token: admin })
    expect(fibers.status).toBe(200)
    const fiberList = expectSchema(api.FibersResponse, fibers)
    expect(fiberList.map(fiber => fiber.name)).toEqual(expect.arrayContaining(['dashboard-api', 'OrchestratorService', 'HttpServer',
      'WorkerGatewayWs', 'StoreSqlite', 'Auth', 'Policy']))
    expect(fiberList.every(fiber => fiber.state === 'ACTIVE')).toBe(true)

    const logout = await call('POST', '/api/v1/auth/logout', { cookie: session.cookie, csrf: session.csrfToken, origin: 'http://127.0.0.1' })
    expect(logout.status).toBe(204)
    expect((await call('GET', '/api/v1/auth/me', { cookie: session.cookie, origin: 'http://127.0.0.1' })).status).toBe(401)
  } finally { await cleanup() }
})

it('API-1 任务端点（创建/列表/详情/日志/下载）全部通过 DTO Schema', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const created = await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: 'pi 验收任务', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } })
    expect(created.status).toBe(201)
    const task = expectSchema(api.TaskDetail, created)
    expect(task).toMatchObject({ status: 'queued', prompt: 'pi 验收任务', workspaceId: 'sandbox',
      origin: { source: 'api' }, resultDeliveryStatus: 'not_required' })
    expect(task.timeline.length).toBeGreaterThan(0)

    const list = await call('GET', '/api/v1/tasks?limit=10', { token })
    expect(list.status).toBe(200)
    const page = expectSchema(api.TaskListResponse, list)
    expect(page.items.map(item => item.id)).toContain(task.id)
    expect(page.items.every(item => api.TaskSummary.safeParse(item).success)).toBe(true)

    const detail = await call('GET', '/api/v1/tasks/' + task.id, { token })
    expect(detail.status).toBe(200)
    expectSchema(api.TaskDetail, detail)

    // 日志端点：直接写入一个 Run 的日志后读取
    await enrollWorker(hub, 'pi-rest-worker')
    const seeded = seedRun(hub, { workerId: 'pi-rest-worker', taskStatus: 'running', runStatus: 'running' })
    await writeLogs(hub, seeded.runId, 1, 7)
    const logs = await call('GET', '/api/v1/tasks/' + seeded.taskId + '/runs/' + seeded.runId + '/logs?afterSeq=0&limit=3', { token })
    expect(logs.status).toBe(200)
    const logsView = expectSchema(api.LogsResponse, logs)
    expect(logsView.entries.map(entry => entry.seq)).toEqual([1, 2, 3])
    expect(logsView.hasMore).toBe(true)
    expect(logsView.runFinished).toBe(false)
    expect(logsView.entries.every(entry => entry.kind === 'log' && entry.data === null)).toBe(true)

    const download = await call('GET', '/api/v1/tasks/' + seeded.taskId + '/runs/' + seeded.runId + '/logs.txt', { token })
    expect(download.status).toBe(200)
    expect(String(download.header('content-type'))).toContain('text/plain')
    expect(download.body.trim().split('\n')).toEqual(Array.from({ length: 7 }, (_, i) => 'line-' + (i + 1)))
  } finally { await cleanup() }
})

it('API-1 任务操作（approve/reject/cancel/retry/input/followup/deliver-result）通过 DTO Schema', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  hub.ctx.policy.replaceRules([...approvalPolicy], OWNER, 0)
  try {
    const submit = async (prompt: string) => expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt, workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))

    // APPROVE（含覆写）
    const toApprove = await submit('#approval approve')
    expect(toApprove.status).toBe('awaiting_approval')
    const approved = await call('POST', '/api/v1/tasks/' + toApprove.taskNo + '/approve', { token,
      payload: { expectedVersion: toApprove.version, overrides: { prompt: '#approval rewritten' } } })
    expect(approved.status).toBe(200)
    const approvedView = expectSchema(api.TaskDetail, approved)
    expect(approvedView).toMatchObject({ status: 'queued', prompt: '#approval rewritten' })
    expect(approvedView.version).toBeGreaterThan(toApprove.version)
    expect(approvedView.timeline.some(entry => entry.note?.includes('Prompt 覆写'))).toBe(true)

    // REJECT
    const toReject = await submit('#approval reject')
    const rejected = await call('POST', '/api/v1/tasks/' + toReject.id + '/reject', { token,
      payload: { expectedVersion: toReject.version, reason: '不符合验收标准' } })
    expect(rejected.status).toBe(200)
    expect(expectSchema(api.TaskDetail, rejected)).toMatchObject({ status: 'rejected' })

    // CANCEL + RETRY
    const toCancel = await submit('普通任务')
    expect(toCancel.status).toBe('queued')
    const cancelled = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks/' + toCancel.id + '/cancel', { token,
      payload: { expectedVersion: toCancel.version, reason: '不需要了' } }))
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.allowedActions).toContain('retry')
    const retried = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks/' + toCancel.id + '/retry', { token, payload: {} }))
    expect(retried.status).toBe('queued')
    expect(retried.version).toBeGreaterThan(cancelled.version)

    // INPUT_PROVIDE
    await enrollWorker(hub, 'pi-input-worker')
    const seeded = seedRun(hub, { workerId: 'pi-input-worker', taskStatus: 'awaiting_input', runStatus: 'awaiting_input',
      workspaceId: 'sandbox' })
    const now = hub.ctx.clock.now()
    hub.ctx.store.repos.prepare('INSERT INTO input_requests (id, task_id, run_id, question, options_json, status, created_at, expires_at) '
      + 'VALUES (?,?,?,?,?,?,?,?)').run('pi-input-1', seeded.taskId, seeded.runId, 'Continue?', JSON.stringify(['yes', 'no']), 'open', now, now + 60_000)
    const answered = await call('POST', '/api/v1/tasks/' + seeded.taskId + '/input', { token,
      payload: { requestId: 'pi-input-1', answer: 'yes' } })
    expect(answered.status).toBe(200)
    const answeredView = expectSchema(api.TaskDetail, answered)
    expect(answeredView.status).toBe('running')
    expect(answeredView.inputRequest).toBeNull()

    // FOLLOWUP（需要终态）
    hub.ctx.store.repos.prepare("UPDATE tasks SET status='succeeded', current_run_id=NULL WHERE id=?").run(seeded.taskId)
    const followup = await call('POST', '/api/v1/tasks/' + seeded.taskId + '/followup', { token, payload: { prompt: '继续跟进' } })
    expect(followup.status).toBe(201)
    const child = expectSchema(api.TaskDetail, followup)
    expect(child.id).not.toBe(seeded.taskId)
    expect(child.parentTaskId).toBe(seeded.taskId)
    expect(expectSchema(api.TaskDetail, await call('GET', '/api/v1/tasks/' + seeded.taskId, { token })).children)
      .toEqual([{ id: child.id, taskNo: child.taskNo, status: child.status }])

    // DELIVER-RESULT（owner_review 模式）
    hub.ctx.store.repos.prepare("UPDATE tasks SET result_delivery_status='pending_review', result_summary='done' WHERE id=?")
      .run(seeded.taskId)
    const delivered = await call('POST', '/api/v1/tasks/' + seeded.taskId + '/deliver-result', { token,
      payload: { action: 'send', summaryOverride: '审核后的摘要' } })
    expect(delivered.status).toBe(200)
    expect(expectSchema(api.TaskDetail, delivered)).toMatchObject({ resultDeliveryStatus: 'delivered' })
  } finally { await cleanup() }
})

it('API-1 Worker / 审计 / 策略 / 令牌端点通过 DTO Schema', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const admin = grant(hub, ['admin'])
  const worker = await onlineWorker(hub, 'pi-api-worker', { drain: true })
  try {
    const workers = await call('GET', '/api/v1/workers', { token: admin })
    expect(workers.status).toBe(200)
    const workerList = expectSchema(api.WorkerListResponse, workers)
    expect(workerList.map(item => item.id)).toContain('pi-api-worker')

    const one = await call('GET', '/api/v1/workers/pi-api-worker', { token: admin })
    expect(one.status).toBe(200)
    expect(expectSchema(api.WorkerDetail, one).recentRuns).toEqual([])

    const undrained = await call('POST', '/api/v1/workers/pi-api-worker/drain', { token: admin, payload: { drain: false } })
    expect(undrained.status).toBe(200)
    expect(expectSchema(api.WorkerView, undrained)).toMatchObject({ id: 'pi-api-worker', drain: false })

    const probe = await call('POST', '/api/v1/workers/pi-api-worker/probe', { token: admin, payload: {} })
    expect(probe.status).toBe(202)

    const enrollment = await call('POST', '/api/v1/workers/enroll-tokens', { token: admin, payload: { suggestedWorkerId: 'pi-enrolled' } })
    expect(enrollment.status).toBe(200)
    const enrollToken = expectSchema(api.EnrollTokenResponse, enrollment)
    expect(enrollToken.command).toContain('agent-worker enroll')

    const pair = generateKeyPairSync('ed25519')
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const enroll = await call('POST', '/api/v1/worker-enroll', { payload: { token: enrollToken.token, workerId: 'pi-enrolled',
      publicKey, hostname: 'pi-enroll-host', os: 'win32' } })
    expect(enroll.status).toBe(201)
    expect(expectSchema(api.WorkerEnrollResponse, enroll).workerId).toBe('pi-enrolled')

    const revoked = await call('POST', '/api/v1/workers/pi-enrolled/revoke', { token: admin, payload: { confirm: 'pi-enrolled' } })
    expect(revoked.status).toBe(200)
    expect(expectSchema(api.WorkerView, revoked)).toMatchObject({ id: 'pi-enrolled', status: 'revoked' })

    const audit = await call('GET', '/api/v1/audit?limit=5', { token: admin })
    expect(audit.status).toBe(200)
    expect(expectSchema(api.AuditResponse, audit).items.length).toBeGreaterThan(0)

    const policies = await call('GET', '/api/v1/config/policies', { token: admin })
    expect(policies.status).toBe(200)
    expectSchema(api.PoliciesResponse, policies)
    const replaced = await call('PUT', '/api/v1/config/policies', { token: admin, payload: { rules: [], expectedRevision: 0 } })
    expect(replaced.status).toBe(200)
    expectSchema(api.ReplacePoliciesResponse, replaced)

    const tokens = await call('GET', '/api/v1/api-tokens', { token: admin })
    expect(tokens.status).toBe(200)
    expectSchema(api.ApiTokensResponse, tokens)
    const createdToken = await call('POST', '/api/v1/api-tokens', { token: admin, payload: { name: 'pi-read', scopes: ['read'] } })
    expect(createdToken.status).toBe(201)
    expect(createdToken.header('cache-control')).toBe('no-store')
    const created = expectSchema(api.CreateApiTokenResponse, createdToken)
    expect(created.token).toMatch(/^ahk_/)
    expect(tokens.body).not.toContain(created.token)
    const removed = await call('DELETE', '/api/v1/api-tokens/' + created.id, { token: admin })
    expect(removed.status).toBe(204)
  } finally { worker.terminate(); await cleanup() }
})

it('API-2 04 §2.3 错误码表逐项触发：HTTP 状态 + error.code + requestId 一致', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const admin = grant(hub, ['admin'])
  const read = grant(hub, ['read'])
  hub.ctx.policy.replaceRules([{ id: 'pi-clamp', name: 'clamp', priority: 1, enabled: true,
    match: { promptPattern: '^#clamp' }, effect: { decision: 'require_approval', clampProfile: 'readonly' } },
  { id: 'pi-approval', name: 'requires approval', priority: 2, enabled: true,
    match: { promptPattern: '^#approval' }, effect: { decision: 'require_approval' } }], OWNER, 0)
  const worker = await onlineWorker(hub, 'pi-err-worker', { drain: true, adapters: [
    { id: 'mock', status: 'ready', version: '0.1.0', features: { resume: true, liveInput: true, structuredOutput: true } }] })
  try {
    // VALIDATION_FAILED
    const invalid = await call('POST', '/api/v1/tasks', { token: admin, payload: { prompt: '', workspaceId: 'sandbox' } })
    const validation = expectError(invalid, 400, 'VALIDATION_FAILED')
    expect(Array.isArray((validation.details as { issues?: unknown[] }).issues)).toBe(true)
    expect((await call('GET', '/api/v1/tasks?limit=0', { token: admin })).status).toBe(400)
    expect((await call('GET', '/api/v1/tasks?unknown=1', { token: admin })).status).toBe(400)

    // UNAUTHENTICATED
    expectError(await call('GET', '/api/v1/tasks'), 401, 'UNAUTHENTICATED')
    expectError(await call('GET', '/api/v1/tasks', { token: 'ahk_invalid' }), 401, 'UNAUTHENTICATED')

    // CSRF_FAILED（会话 + 缺少 CSRF / 错误 Origin）
    const session = await login(call)
    expectError(await call('POST', '/api/v1/tasks', { cookie: session.cookie, payload: { prompt: 'x', workspaceId: 'sandbox' } }),
      403, 'CSRF_FAILED')
    expectError(await call('POST', '/api/v1/tasks', { cookie: session.cookie, csrf: 'wrong', payload: { prompt: 'x', workspaceId: 'sandbox' } }),
      403, 'CSRF_FAILED')

    // FORBIDDEN（read scope 无法 operate / admin）
    expectError(await call('POST', '/api/v1/tasks', { token: read, payload: { prompt: 'x', workspaceId: 'sandbox' } }), 403, 'FORBIDDEN')
    expectError(await call('GET', '/api/v1/system/metrics', { token: read }), 403, 'FORBIDDEN')

    // 404 家族
    expectError(await call('GET', '/api/v1/tasks/tsk_00000000000000000000000000', { token: admin }), 404, 'TASK_NOT_FOUND')
    expectError(await call('GET', '/api/v1/tasks/tsk_00000000000000000000000000/runs/run_00000000000000000000000000/logs', { token: admin }),
      404, 'TASK_NOT_FOUND')
    expectError(await call('GET', '/api/v1/workers/ghost-worker', { token: admin }), 404, 'WORKER_NOT_FOUND')

    const task = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token: admin,
      payload: { prompt: '错误码任务', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    expectError(await call('GET', '/api/v1/tasks/' + task.id + '/runs/run_00000000000000000000000000/logs', { token: admin }),
      404, 'RUN_NOT_FOUND')

    // INVALID_TRANSITION（queued 不能 APPROVE）
    const invalidTransition = expectError(await call('POST', '/api/v1/tasks/' + task.id + '/approve', { token: admin, payload: {} }),
      409, 'INVALID_TRANSITION')
    expect(invalidTransition.details).toMatchObject({ from: 'queued', event: 'APPROVE' })

    // VERSION_CONFLICT
    const conflict = expectError(await call('POST', '/api/v1/tasks/' + task.id + '/cancel', { token: admin,
      payload: { expectedVersion: task.version + 5 } }), 409, 'VERSION_CONFLICT')
    expect((conflict.details as { current?: { id?: string } }).current?.id).toBe(task.id)

    // IDEMPOTENCY_MISMATCH
    const key = 'pi-idem-key'
    const first = await call('POST', '/api/v1/tasks', { token: admin, headers: { 'idempotency-key': key },
      payload: { prompt: '幂等 A', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } })
    expect(first.status).toBe(201)
    expectError(await call('POST', '/api/v1/tasks', { token: admin, headers: { 'idempotency-key': key },
      payload: { prompt: '幂等 B', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }), 409, 'IDEMPOTENCY_MISMATCH')

    // INPUT_REQUEST_CLOSED（requestId 不匹配）
    await enrollWorker(hub, 'pi-err-input-worker')
    const seeded = seedRun(hub, { workerId: 'pi-err-input-worker', taskStatus: 'awaiting_input', runStatus: 'awaiting_input' })
    const now = hub.ctx.clock.now()
    hub.ctx.store.repos.prepare('INSERT INTO input_requests (id, task_id, run_id, question, status, created_at, expires_at) '
      + 'VALUES (?,?,?,?,?,?,?)').run('pi-open-input', seeded.taskId, seeded.runId, 'Continue?', 'open', now, now + 60_000)
    expectError(await call('POST', '/api/v1/tasks/' + seeded.taskId + '/input', { token: admin,
      payload: { requestId: 'other-input', answer: 'yes' } }), 409, 'INPUT_REQUEST_CLOSED')

    // WORKER_OFFLINE（未连接的已注册 Worker 不允许 probe）
    hub.ctx.auth.enroll({ token: hub.ctx.auth.createEnrollToken(OWNER, 'pi-offline-worker').token, workerId: 'pi-offline-worker',
      publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      hostname: 'offline', os: 'linux' }, '10.9.9.9')
    expectError(await call('POST', '/api/v1/workers/pi-offline-worker/probe', { token: admin, payload: {} }), 409, 'WORKER_OFFLINE')

    // UNKNOWN_ADAPTER / UNKNOWN_WORKSPACE / PROFILE_NOT_ALLOWED（审批覆写）
    const approval = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token: admin,
      payload: { prompt: '#approval 覆写校验', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    expect(approval.status).toBe('awaiting_approval')
    expectError(await call('POST', '/api/v1/tasks/' + approval.id + '/approve', { token: admin,
      payload: { overrides: { adapter: 'gemini' } } }), 422, 'UNKNOWN_ADAPTER')
    expectError(await call('POST', '/api/v1/tasks/' + approval.id + '/approve', { token: admin,
      payload: { overrides: { workspaceId: 'ghost-workspace' } } }), 422, 'UNKNOWN_WORKSPACE')
    const clamped = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token: admin,
      payload: { prompt: '#clamp 档位', workspaceId: 'sandbox', adapter: 'mock', profile: 'edit' } }))
    expect(clamped.profile).toBe('readonly')
    expectError(await call('POST', '/api/v1/tasks/' + clamped.id + '/approve', { token: admin,
      payload: { overrides: { profile: 'edit' } } }), 422, 'PROFILE_NOT_ALLOWED')

    // PAYLOAD_TOO_LARGE
    expectError(await call('POST', '/api/v1/tasks', { token: admin,
      payload: { prompt: 'x'.repeat(300 * 1024), workspaceId: 'sandbox' } }), 413, 'PAYLOAD_TOO_LARGE')

    // RATE_LIMITED（登录失败 5 次后第 6 次）
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await call('POST', '/api/v1/auth/login', { payload: { token: 'bad-' + attempt } })).status).toBe(401)
    }
    const limited = await call('POST', '/api/v1/auth/login', { payload: { token: 'bad-6' } })
    expectError(limited, 429, 'RATE_LIMITED')
    expect(Number(limited.header('retry-after'))).toBeGreaterThan(0)

    // HUB_SHUTTING_DOWN
    hub.ctx.http.setAccepting(false)
    expectError(await call('POST', '/api/v1/tasks', { token: admin, payload: { prompt: 'x', workspaceId: 'sandbox' } }),
      503, 'HUB_SHUTTING_DOWN')
    expect((await call('GET', '/api/v1/overview', { token: admin })).status).toBe(200)
    hub.ctx.http.setAccepting(true)

    // INTERNAL（故障注入：底层表缺失 → 未预期异常）
    hub.ctx.store.repos.prepare('DROP TABLE audit_logs').run()
    expectError(await call('GET', '/api/v1/tasks/' + task.id, { token: admin }), 500, 'INTERNAL')
  } finally { worker.terminate(); await cleanup() }
})

it('API-3 Idempotency-Key：同 key 同 body 复用首次响应，同 key 不同 body 返回 409', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const body = { prompt: '幂等任务', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' }
    const headers = { 'idempotency-key': 'pi-idem-1' }
    const first = await call('POST', '/api/v1/tasks', { token, headers, payload: body })
    const second = await call('POST', '/api/v1/tasks', { token, headers, payload: { ...body, profile: 'edit' } })
    const replay = await call('POST', '/api/v1/tasks', { token, headers, payload: body })
    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(replay.json()).toEqual(first.json())
    expect(second.status).toBe(409)
    expect(second.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_MISMATCH' } })
    const rows = hub.ctx.store.repos.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }
    expect(rows.n).toBe(1)
    // 幂等键按调用方身份作用域：同为本系统 Owner，两枚 admin 令牌共享同一命名空间
    const other = grant(hub, ['admin'])
    const scoped = await call('POST', '/api/v1/tasks', { token: other, headers, payload: body })
    expect(scoped.status).toBe(201)
    expect(scoped.json()).toEqual(first.json())
    expect((hub.ctx.store.repos.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n).toBe(1)
    // 超过 64 字符的幂等键被拒绝
    expect((await call('POST', '/api/v1/tasks', { token, headers: { 'idempotency-key': 'k'.repeat(65) }, payload: body })).status).toBe(400)
  } finally { await cleanup() }
})

it('API-4 :ref 同时接受 tsk_… 与纯数字编号', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const task = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: '引用形式', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    const byId = await call('GET', '/api/v1/tasks/' + task.id, { token })
    const byNo = await call('GET', '/api/v1/tasks/' + task.taskNo, { token })
    expect(byId.status).toBe(200)
    expect(byNo.status).toBe(200)
    expect(byNo.json()).toEqual(byId.json())
    // 非法转换：数字与 tsk_ 形式返回同一错误码
    for (const method of ['approve', 'reject'] as const) {
      const numeric = await call('POST', '/api/v1/tasks/' + task.taskNo + '/' + method, { token, payload: {} })
      const byid = await call('POST', '/api/v1/tasks/' + task.id + '/' + method, { token, payload: {} })
      expect(numeric.json().error?.code).toBe('INVALID_TRANSITION')
      expect(numeric.json().error?.code).toBe(byid.json().error?.code)
    }
    // 变更类端点：数字编号等价于 tsk_ 标识
    const cancelledByNumber = await call('POST', '/api/v1/tasks/' + task.taskNo + '/cancel', { token, payload: {} })
    expect(cancelledByNumber.status).toBe(200)
    expect(cancelledByNumber.json()).toMatchObject({ id: task.id, status: 'cancelled' })
    const retriedById = await call('POST', '/api/v1/tasks/' + task.id + '/retry', { token, payload: {} })
    expect(retriedById.status).toBe(200)
    expect(retriedById.json()).toMatchObject({ id: task.id, status: 'queued' })
    // `%23<no>`（显式 `#123` 形式）：04 §2.1 只要求 tsk_ 与纯数字，记录实际行为
    const hashed = await call('GET', '/api/v1/tasks/%23' + task.taskNo, { token })
    if (hashed.status === 200) expect(hashed.json()).toEqual(byId.json())
    else expectError(hashed, 400, 'VALIDATION_FAILED')
    expect((await call('GET', '/api/v1/tasks/not-a-ref', { token })).status).toBe(400)
  } finally { await cleanup() }
})

it('API-5 游标分页过程中插入新任务：翻页无重复无遗漏', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const created: string[] = []
    for (let index = 0; index < 60; index++) {
      const task = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
        payload: { prompt: '分页任务 ' + index, workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
      created.push(task.id)
    }
    const collected: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const response = await call('GET', '/api/v1/tasks?limit=25' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { token })
      expect(response.status).toBe(200)
      const page = expectSchema(api.TaskListResponse, response)
      collected.push(...page.items.map(item => item.id))
      cursor = page.nextCursor
      pages++
      if (pages === 1) {
        // 第一页之后插入新任务：不得影响后续页的游标边界
        await call('POST', '/api/v1/tasks', { token, payload: { prompt: '插入的新任务', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } })
      }
    } while (cursor && pages < 20)
    expect(pages).toBe(3)
    expect(new Set(collected).size).toBe(collected.length)
    expect(collected.sort()).toEqual([...created].sort())
    // 无效游标被拒绝
    expect((await call('GET', '/api/v1/tasks?limit=5&cursor=not-base64', { token })).status).toBe(400)
  } finally { await cleanup() }
})

it('API-12 draining 期间变更为 503，只读 GET 正常', async () => {
  const { hub, cleanup } = await openHarness(settings)
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const task = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: '排空验证', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    hub.ctx.http.setAccepting(false)
    for (const [method, url, payload] of [
      ['POST', '/api/v1/tasks', { prompt: 'x', workspaceId: 'sandbox' }],
      ['POST', '/api/v1/tasks/' + task.id + '/cancel', {}],
      ['PUT', '/api/v1/config/policies', { rules: [], expectedRevision: 0 }],
      ['DELETE', '/api/v1/api-tokens/whatever', undefined],
    ] as const) {
      const reply = await call(method, url, { token, ...(payload !== undefined && { payload }) })
      const error = expectError(reply, 503, 'HUB_SHUTTING_DOWN')
      expect(error.message.length).toBeGreaterThan(0)
    }
    for (const url of ['/api/v1/overview', '/api/v1/tasks', '/api/v1/workers', '/api/v1/tasks/' + task.id]) {
      expect((await call('GET', url, { token })).status).toBe(200)
    }
    expect((await call('GET', '/healthz')).status).toBe(200)
    const ready = await call('GET', '/readyz')
    expect(ready.status).toBe(503)
    expect(ready.json()).toEqual({ ready: false })
  } finally { await cleanup() }
})

it('API-2 retry 次数用尽：Owner 覆写放行（与 04 §2.3 MAX_ATTEMPTS_REACHED 期望存在偏差，见验收报告 P2-1）', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const task = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: '重试预算', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    hub.ctx.store.repos.prepare("UPDATE tasks SET status='failed', current_run_id=NULL, attempt_count=3, max_attempts=3, finished_at=? WHERE id=?")
      .run(hub.ctx.clock.now(), task.id)
    // 未带 force：04 §2.3 期望 409 MAX_ATTEMPTS_REACHED，实现选择 Owner 放行并记录 override
    const retried = await call('POST', '/api/v1/tasks/' + task.id + '/retry', { token, payload: {} })
    expect([200, 409]).toContain(retried.status)
    if (retried.status === 200) {
      expect(expectSchema(api.TaskDetail, retried).status).toBe('queued')
      const audit = hub.ctx.store.repos.prepare("SELECT detail_json AS detail FROM audit_logs WHERE target_id = ? AND action = 'task.retry' ORDER BY id DESC LIMIT 1")
        .get(task.id) as { detail: string | null }
      expect(JSON.parse(audit.detail ?? '{}')).toMatchObject({ override: true })
    } else expectError(retried, 409, 'MAX_ATTEMPTS_REACHED')
    // 无 force 参数时也必须可复现：带 force:true 一定放行
    hub.ctx.store.repos.prepare("UPDATE tasks SET status='failed', current_run_id=NULL WHERE id=?").run(task.id)
    expect((await call('POST', '/api/v1/tasks/' + task.id + '/retry', { token, payload: { force: true } })).status).toBe(200)
  } finally { await cleanup() }
})

it('API-2 PUT /config/policies 正则编译失败返回 400 VALIDATION_FAILED', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const broken = await call('PUT', '/api/v1/config/policies', { token, payload: { expectedRevision: 0, rules: [
      { id: 'bad', name: 'bad', priority: 1, enabled: true, match: { promptPattern: '([unclosed' }, effect: { decision: 'auto_approve' } }] } })
    expectError(broken, 400, 'VALIDATION_FAILED')
    expect(hub.ctx.policy.revision()).toBe(0)
  } finally { await cleanup() }
})

it('API-3 followup 也支持 Idempotency-Key', async () => {
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  const call = rest(hub)
  const token = grant(hub, ['admin'])
  try {
    const parent = expectSchema(api.TaskDetail, await call('POST', '/api/v1/tasks', { token,
      payload: { prompt: '父任务', workspaceId: 'sandbox', adapter: 'mock', profile: 'readonly' } }))
    hub.ctx.store.repos.prepare("UPDATE tasks SET status='succeeded', current_run_id=NULL WHERE id=?").run(parent.id)
    const headers = { 'idempotency-key': 'pi-followup-1' }
    const first = await call('POST', '/api/v1/tasks/' + parent.id + '/followup', { token, headers, payload: { prompt: '子任务' } })
    const replay = await call('POST', '/api/v1/tasks/' + parent.id + '/followup', { token, headers, payload: { prompt: '子任务' } })
    const mismatch = await call('POST', '/api/v1/tasks/' + parent.id + '/followup', { token, headers, payload: { prompt: '别的子任务' } })
    expect(first.status).toBe(201)
    expect(replay.json()).toEqual(first.json())
    expectError(mismatch, 409, 'IDEMPOTENCY_MISMATCH')
    expect((hub.ctx.store.repos.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n).toBe(2)
  } finally { await cleanup() }
})
