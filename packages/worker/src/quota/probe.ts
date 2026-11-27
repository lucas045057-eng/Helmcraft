import { execFile } from 'node:child_process'
import { open, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AdapterQuota, QuotaWindow } from '@agent-hub/protocol'

// 三家 CLI 的订阅额度。只读本机 CLI 已登录的凭据 / 会话记录，不刷新也不改写它们。
export interface QuotaEnv {
  home: string
  now: () => number
  fetch: typeof fetch
  /** 让 agy 自己刷新过期的 token（agy models 不消耗额度） */
  refreshAntigravity?: () => Promise<void>
}
export type QuotaResult = Omit<AdapterQuota, 'adapter' | 'checkedAt'> & { checkedAt?: number }

const pct = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
const time = (value: unknown) => {
  if (typeof value === 'number') return Math.round(value < 1e12 ? value * 1000 : value)
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}
const obj = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined
async function json(env: QuotaEnv, url: string, init: RequestInit) {
  const response = await env.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return await response.json() as unknown
}

const claudeWindows: Array<[string, string]> = [['five_hour', '5 小时'], ['seven_day', '每周'], ['seven_day_opus', '每周 Opus'], ['seven_day_sonnet', '每周 Sonnet']]
export async function claudeQuota(env: QuotaEnv): Promise<QuotaResult | null> {
  let oauth: Record<string, unknown> | undefined
  try { oauth = obj(obj(JSON.parse(await readFile(join(env.home, '.claude', '.credentials.json'), 'utf8')))?.claudeAiOauth) } catch { return null }
  if (!oauth || typeof oauth.accessToken !== 'string') return null
  const plan = typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < env.now()) return { ...(plan && { plan }), windows: [], error: '登录已过期，下次跑 Claude 任务后自动恢复' }
  const body = obj(await json(env, 'https://api.anthropic.com/api/oauth/usage',
    { headers: { authorization: 'Bearer ' + oauth.accessToken, 'anthropic-beta': 'oauth-2025-04-20' } })) ?? {}
  const windows = claudeWindows.flatMap(([key, label]) => {
    const w = obj(body[key])
    return w && typeof w.utilization === 'number' ? [{ label, usedPercent: pct(w.utilization), resetsAt: time(w.resets_at) }] : []
  })
  return { ...(plan && { plan }), windows }
}

/** Codex：最近一次会话记录里的 rate_limits（Codex 每次调用后都会写入，含交互式使用）。 */
export async function codexQuota(env: QuotaEnv): Promise<QuotaResult | null> {
  const root = join(env.home, '.codex', 'sessions')
  const newest = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse()
  let checked = 0
  for (const year of await newest(root)) for (const month of await newest(join(root, year))) for (const day of await newest(join(root, year, month))) {
    for (const file of (await newest(join(root, year, month, day))).filter(name => name.endsWith('.jsonl'))) {
      if (++checked > 20) return null
      const found = await lastRateLimits(join(root, year, month, day, file))
      if (found) return found
    }
  }
  return null
}
async function lastRateLimits(path: string): Promise<QuotaResult | null> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 512 * 1024), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"rate_limits"')) continue
      let row: Record<string, unknown> | undefined
      try { row = obj(JSON.parse(line)) } catch { continue }
      const limits = obj(obj(row?.payload)?.rate_limits)
      if (!limits) continue
      const at = time(row?.timestamp) ?? Date.now()
      const windows: QuotaWindow[] = ['primary', 'secondary'].flatMap(key => {
        const w = obj(limits[key])
        if (!w || typeof w.used_percent !== 'number') return []
        const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : 0
        const label = minutes === 10080 ? '每周' : minutes === 300 ? '5 小时' : minutes >= 1440 ? Math.round(minutes / 1440) + ' 天' : Math.round(minutes / 60) + ' 小时'
        const resetsAt = time(w.resets_at) ?? (typeof w.resets_in_seconds === 'number' ? at + w.resets_in_seconds * 1000 : null)
        return [{ label, usedPercent: pct(w.used_percent), resetsAt }]
      })
      if (!windows.length) continue
      return { ...(typeof limits.plan_type === 'string' && { plan: limits.plan_type }), windows, checkedAt: at }
    }
    return null
  } finally { await handle.close() }
}

/** Antigravity：用 agy 登录的 Google token 查分组额度（Claude/GPT 组）和 Gemini 模型额度。 */
export async function antigravityQuota(env: QuotaEnv): Promise<QuotaResult | null> {
  const path = join(env.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  const read = async () => {
    try { return obj(obj(JSON.parse(await readFile(path, 'utf8')))?.token) } catch { return undefined }
  }
  let token = await read()
  if (!token || typeof token.access_token !== 'string') return null
  const expired = () => (time(token?.expiry) ?? 0) < env.now() + 60_000
  if (expired() && env.refreshAntigravity) { await env.refreshAntigravity().catch(() => undefined); token = await read() }
  if (!token || typeof token.access_token !== 'string' || expired()) return { windows: [], error: '登录已过期，下次跑 Antigravity 任务后自动恢复' }
  const init = { method: 'POST', headers: { authorization: 'Bearer ' + token.access_token, 'content-type': 'application/json' }, body: '{}' }
  const base = 'https://cloudcode-pa.googleapis.com/v1internal:'
  const [summary, models] = await Promise.all([json(env, base + 'retrieveUserQuotaSummary', init), json(env, base + 'fetchAvailableModels', init).catch(() => undefined)])
  const windows: QuotaWindow[] = []
  // Gemini 各模型额度独立，取剩余最少的那个
  let gemini: { remaining: number; resetsAt: number | null } | undefined
  for (const model of Object.values(obj(obj(models)?.models) ?? {})) {
    const m = obj(model), info = obj(m?.quotaInfo)
    if (m?.modelProvider !== 'MODEL_PROVIDER_GOOGLE' || typeof info?.remainingFraction !== 'number') continue
    if (!gemini || info.remainingFraction < gemini.remaining) gemini = { remaining: info.remainingFraction, resetsAt: time(info.resetTime) }
  }
  if (gemini) windows.push({ label: 'Gemini 模型', usedPercent: pct((1 - gemini.remaining) * 100), resetsAt: gemini.resetsAt })
  for (const group of Array.isArray(obj(summary)?.groups) ? obj(summary)!.groups as unknown[] : []) {
    const g = obj(group)
    const name = String(g?.displayName ?? '').replace(/\s+models?$/iu, '').replace(/\s+and\s+/giu, '/')
    for (const bucket of Array.isArray(g?.buckets) ? g.buckets as unknown[] : []) {
      const b = obj(bucket)
      if (typeof b?.remainingFraction !== 'number') continue
      const span = b.window === '5h' ? '5 小时' : b.window === 'weekly' ? '每周' : String(b.window ?? '')
      windows.push({ label: (name + ' ' + span).trim().slice(0, 64), usedPercent: pct((1 - b.remainingFraction) * 100), resetsAt: time(b.resetTime) })
    }
  }
  return { windows: windows.slice(0, 8) }
}

export function defaultQuotaEnv(agy?: { command: string; prefixArgs: string[] }): QuotaEnv {
  return {
    home: homedir(), now: Date.now, fetch: globalThis.fetch,
    ...(agy && { refreshAntigravity: () => new Promise<void>(resolve => {
      execFile(agy.command, [...agy.prefixArgs, 'models'], { timeout: 60_000, windowsHide: true }, () => resolve())
    }) }),
  }
}
