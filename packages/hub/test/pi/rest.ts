/**
 * Pi 独立验收 · 面板 REST/WS 测试辅助（Phase 4）
 *
 * 提供：固定的 allowedOrigins 配置、管理员令牌摘要、Fastify inject 轻客户端、
 * 会话登录辅助，以及 DTO 严格校验辅助。
 */
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import type { z } from 'zod'
import type { TestHub } from '../../src/app.js'
import { FakeWorker, eventually, openHarness } from './harness.js'

/** 真实浏览器测试里也使用这个 Origin（面板 Origin 白名单为精确匹配）。 */
export const ORIGIN = 'http://127.0.0.1'
export const ADMIN_TOKEN = 'pi-phase4-admin-token-' + 'k'.repeat(32)
export const adminDigest = () => createHash('sha256').update(ADMIN_TOKEN).digest('hex')

export const settings = {
  server: { port: 0, allowInsecureWorker: true },
  dashboard: { allowedOrigins: [ORIGIN] },
}

/** 让 `auth.login` 可校验的管理员令牌摘要对当前进程可见。 */
export function useAdminToken() {
  process.env.HUB_ADMIN_TOKEN_SHA256 = adminDigest()
}

export interface Reply {
  status: number
  headers: Record<string, string | string[] | number | undefined>
  body: string
  json: <T = Record<string, unknown>>() => T
  header: (name: string) => string | undefined
}

export interface CallOptions {
  token?: string
  cookie?: string
  csrf?: string
  origin?: string | null
  payload?: unknown
  body?: string
  contentType?: string
  headers?: Record<string, string>
}

export type Call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, options?: CallOptions) => Promise<Reply>

/** 基于 Fastify inject 的 REST 客户端（不经过 socket，仍走完整中间件栈）。 */
export function rest(hub: TestHub): Call {
  return async (method, url, options = {}) => {
    const headers: Record<string, string> = { ...options.headers }
    if (options.token) headers.authorization = 'Bearer ' + options.token
    if (options.cookie) headers.cookie = options.cookie
    if (options.csrf) headers['x-csrf-token'] = options.csrf
    if (options.origin !== null && options.origin !== undefined) headers.origin = options.origin
    if (options.contentType) headers['content-type'] = options.contentType
    const response = await hub.ctx.http.app.inject({
      method, url, headers,
      ...(options.body !== undefined && { body: options.body }),
      ...(options.payload !== undefined && { payload: options.payload as object }),
    })
    return {
      status: response.statusCode,
      headers: response.headers as Reply['headers'],
      body: response.body,
      json: <T>() => JSON.parse(response.body) as T,
      header: name => {
        const value = response.headers[name.toLowerCase()]
        return value === undefined ? undefined : String(value)
      },
    }
  }
}

export interface Session { cookie: string; csrfToken: string }

export async function login(call: Call): Promise<Session> {
  const response = await call('POST', '/api/v1/auth/login', { payload: { token: ADMIN_TOKEN }, origin: ORIGIN })
  expect(response.status).toBe(200)
  const setCookie = response.header('set-cookie')
  expect(setCookie).toBeTruthy()
  return { cookie: String(setCookie).split(';')[0]!, csrfToken: response.json<{ csrfToken: string }>().csrfToken }
}

/** 断言响应体严格通过某个 `@agent-hub/protocol` DTO Schema 校验，并返回解析值。 */
export function expectSchema<T>(schema: z.ZodType<T>, reply: Reply): T {
  const parsed = schema.safeParse(reply.json())
  if (!parsed.success) {
    throw new Error('DTO schema validation failed: ' + JSON.stringify(parsed.error.issues) + '\nbody=' + reply.body)
  }
  return parsed.data
}

/** 断言标准错误响应（HTTP 状态 + error.code + requestId 与 X-Request-Id 一致）。 */
export function expectError(reply: Reply, status: number, code: string) {
  expect({ status: reply.status, code: reply.json<{ error: { code: string } }>().error?.code })
    .toEqual({ status, code })
  const error = reply.json<{ error: { code: string; message: string; requestId: string } }>().error
  expect(typeof error.message).toBe('string')
  expect(error.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  expect(reply.header('x-request-id')).toBe(error.requestId)
  return error
}

/** 连接一个真实握手流程的 FakeWorker（裸协议），等待 Hub 判定 online。 */
export async function onlineWorker(hub: TestHub, workerId: string, options: Record<string, unknown> = {}) {
  const worker = await FakeWorker.connect(hub, { workerId, ...options })
  await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 5000, label: workerId + ' online' })
  return worker
}

export { openHarness, FakeWorker, eventually }
