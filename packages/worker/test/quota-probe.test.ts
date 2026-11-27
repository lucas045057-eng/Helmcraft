import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { antigravityQuota, claudeQuota, codexQuota } from '../src/quota/probe.js'
import type { QuotaEnv } from '../src/quota/probe.js'

const now = Date.parse('2026-11-27T02:00:00Z')
let home = ''
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }) })
function setup(files: Record<string, string>) {
  home = mkdtempSync(join(tmpdir(), 'quota-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(home, path, '..'), { recursive: true })
    writeFileSync(join(home, path), body)
  }
}
function env(routes: Record<string, unknown>, extra: Partial<QuotaEnv> = {}) {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    const body = routes[url]
    return body === undefined ? new Response('no', { status: 404 }) : Response.json(body)
  }) as typeof globalThis.fetch
  return { env: { home, now: () => now, fetch, ...extra }, calls }
}

it('reads Claude 5-hour and weekly usage with the CLI login', async () => {
  setup({ '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 3_600_000, subscriptionType: 'pro' } }) })
  const { env: e, calls } = env({ 'https://api.anthropic.com/api/oauth/usage': {
    five_hour: { utilization: 15.0, resets_at: '2026-11-27T06:59:59.56+00:00' }, seven_day: { utilization: 42.0, resets_at: '2026-12-01T06:59:59Z' }, seven_day_opus: null } })
  expect(await claudeQuota(e)).toEqual({ plan: 'pro', windows: [
    { label: '5 小时', usedPercent: 15, resetsAt: Date.parse('2026-11-27T06:59:59.56Z') },
    { label: '每周', usedPercent: 42, resetsAt: Date.parse('2026-12-01T06:59:59Z') }] })
  expect(calls[0]!.auth).toBe('Bearer tok')
})

it('does not call Claude with an expired login and is silent without one', async () => {
  setup({ '.claude/.credentials.json': JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: now - 1 } }) })
  const { env: e, calls } = env({})
  expect((await claudeQuota(e))?.error).toContain('过期')
  expect(calls).toEqual([])
  rmSync(join(home, '.claude'), { recursive: true })
  expect(await claudeQuota(e)).toBeNull()
})

it('takes Codex limits from the newest session log that has them', async () => {
  const line = (ts: string, limits: unknown) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: limits } })
  setup({
    '.codex/sessions/2026/11/25/rollout-a.jsonl': line('2026-11-25T10:00:00Z', { primary: { used_percent: 10, window_minutes: 10080, resets_at: 1 } }),
    '.codex/sessions/2026/11/26/rollout-b.jsonl': [
      line('2026-11-26T10:00:00Z', { primary: { used_percent: 40, window_minutes: 300, resets_in_seconds: 60 }, secondary: { used_percent: 50, window_minutes: 10080, resets_at: 1795934960 }, plan_type: 'plus' }),
      JSON.stringify({ type: 'response_item' }), ''].join('\n'),
    '.codex/sessions/2026/11/27/rollout-c.jsonl': JSON.stringify({ type: 'session_meta' }),
  })
  const at = Date.parse('2026-11-26T10:00:00Z')
  expect(await codexQuota(env({}).env)).toEqual({ plan: 'plus', checkedAt: at, windows: [
    { label: '5 小时', usedPercent: 40, resetsAt: at + 60_000 }, { label: '每周', usedPercent: 50, resetsAt: 1795934960_000 }] })
})

it('reads Antigravity group buckets and the tightest Gemini model, refreshing an expired token through agy', async () => {
  const token = (expiry: string) => JSON.stringify({ token: { access_token: 'g', expiry } })
  setup({ '.gemini/antigravity-cli/antigravity-oauth-token': token('2026-11-27T01:00:00Z') })
  const base = 'https://cloudcode-pa.googleapis.com/v1internal:'
  let refreshed = 0
  const { env: e } = env({
    [base + 'retrieveUserQuotaSummary']: { groups: [{ displayName: 'Claude and GPT models', buckets: [
      { window: 'weekly', remainingFraction: 1, resetTime: '2026-12-04T02:09:27Z' }, { window: '5h', remainingFraction: 0.75, resetTime: '2026-11-27T07:09:27Z' }] }] },
    [base + 'fetchAvailableModels']: { models: {
      a: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-27T07:00:00Z' } },
      b: { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.6, resetTime: '2026-11-27T08:00:00Z' } },
      c: { modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 0.1 } } } },
  }, { refreshAntigravity: async () => {
    refreshed++
    writeFileSync(join(home, '.gemini/antigravity-cli/antigravity-oauth-token'), token('2026-11-27T03:00:00Z'))
  } })
  expect(await antigravityQuota(e)).toEqual({ windows: [
    { label: 'Gemini 模型', usedPercent: 40, resetsAt: Date.parse('2026-11-27T08:00:00Z') },
    { label: 'Claude/GPT 每周', usedPercent: 0, resetsAt: Date.parse('2026-12-04T02:09:27Z') },
    { label: 'Claude/GPT 5 小时', usedPercent: 25, resetsAt: Date.parse('2026-11-27T07:09:27Z') }] })
  expect(refreshed).toBe(1)
})
