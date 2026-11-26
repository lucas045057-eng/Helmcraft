import { AdapterId, SetAgentModelRequest } from '@agent-hub/protocol'
import type { Actor, AgentOverview, AgentQuota, QuotaWindow, UsageTotals, WorkerView } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import type { Repos, StoredEvent } from '../../services/store.js'

// 面板「模型与用量」：每个 Agent 的默认模型、订阅额度与 token / 费用统计
const ALIASES: Partial<Record<AdapterId, string[]>> = { 'claude-code': ['opus', 'sonnet', 'haiku'] }
const LISTED: AdapterId[] = ['claude-code', 'codex', 'antigravity', 'gemini', 'opencode']
const DAY = 86_400_000

/** 记录 CLI 自报的实际模型与额度；只写元数据，不影响任务状态。 */
export function recordAgentMeta(db: Repos, run: { id: string; workerId: string; adapter: string }, events: readonly StoredEvent[], now: number) {
  for (const event of events) {
    if (event.kind !== 'agent') continue
    if (event.event.type === 'init' && event.event.model) {
      db.prepare('UPDATE task_runs SET model_used = ? WHERE id = ? AND model_used IS NULL').run(event.event.model.slice(0, 128), run.id)
    } else if (event.event.type === 'quota') {
      db.prepare(`INSERT INTO adapter_quota (worker_id, adapter, quota_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (worker_id, adapter) DO UPDATE SET quota_json = excluded.quota_json, updated_at = excluded.updated_at`)
        .run(run.workerId, run.adapter, JSON.stringify(event.event.windows), now)
    }
  }
}

export function defaultModelFor(db: Repos, adapter: string): string | null {
  return (db.prepare('SELECT default_model FROM adapter_settings WHERE adapter = ?').pluck().get(adapter) as string | null | undefined) ?? null
}

export function setDefaultModel(db: Repos, adapter: string, body: unknown, actor: Actor, now: number) {
  const id = AdapterId.safeParse(adapter)
  if (!id.success) throw new HubError('VALIDATION_FAILED', 404, { reason: 'ADAPTER_NOT_FOUND' })
  const parsed = SetAgentModelRequest.safeParse(body)
  if (!parsed.success) throw new HubError('VALIDATION_FAILED', 400, { issues: parsed.error.issues.map(i => ({ path: i.path.map(String).join('.'), message: i.message })) })
  const previous = defaultModelFor(db, id.data)
  db.prepare(`INSERT INTO adapter_settings (adapter, default_model, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (adapter) DO UPDATE SET default_model = excluded.default_model, updated_at = excluded.updated_at`).run(id.data, parsed.data.model, now)
  db.prepare(`INSERT INTO audit_logs (ts, actor_type, actor_id, channel, action, target_type, target_id, detail_json)
    VALUES (?, ?, ?, ?, 'agent.model_set', 'config', ?, ?)`)
    .run(now, actor.type, actor.id, actor.channel, id.data, JSON.stringify({ from: previous, to: parsed.data.model }))
  return { adapter: id.data, defaultModel: parsed.data.model }
}

const empty = (): UsageTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 })
interface UsageRow { adapter: string; model: string; runs: number; input: number | null; output: number | null; cache: number | null; cost: number | null }
const totals = (row: UsageRow): UsageTotals => ({ runs: row.runs, inputTokens: row.input ?? 0, outputTokens: row.output ?? 0,
  cacheReadTokens: row.cache ?? 0, costUsd: Math.round((row.cost ?? 0) * 10_000) / 10_000 })
const add = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ runs: a.runs + b.runs, inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  costUsd: Math.round((a.costUsd + b.costUsd) * 10_000) / 10_000 })

/** 本地时区当天 0 点（与概览的「今日」口径一致）。 */
function dayStart(now: number, localDate: Intl.DateTimeFormat) {
  const today = localDate.format(now)
  let start = now - 36 * 3_600_000, end = now
  while (start < end) {
    const mid = start + Math.floor((end - start) / 2)
    if (localDate.format(mid) < today) start = mid + 1
    else end = mid
  }
  return start
}

export function agentOverview(db: Repos, workers: WorkerView[], now: number, localDate: Intl.DateTimeFormat): AgentOverview[] {
  const usage = (since: number) => db.prepare(`SELECT adapter, coalesce(model_used, '') AS model, count(*) AS runs,
      sum(json_extract(usage_json, '$.inputTokens')) AS input, sum(json_extract(usage_json, '$.outputTokens')) AS output,
      sum(json_extract(usage_json, '$.cacheReadTokens')) AS cache, sum(json_extract(usage_json, '$.costUsd')) AS cost
    FROM task_runs WHERE coalesce(finished_at, started_at, dispatched_at) >= ? AND started_at IS NOT NULL
    GROUP BY adapter, coalesce(model_used, '')`).all(since) as UsageRow[]
  const today = usage(dayStart(now, localDate)), week = usage(now - 7 * DAY), month = usage(now - 30 * DAY)
  const sum = (rows: UsageRow[], adapter: string) => rows.filter(r => r.adapter === adapter).map(totals).reduce(add, empty())
  const settings = new Map((db.prepare('SELECT adapter, default_model FROM adapter_settings').all() as { adapter: string; default_model: string | null }[])
    .map(row => [row.adapter, row.default_model]))
  const quotas = db.prepare('SELECT worker_id, adapter, quota_json, updated_at FROM adapter_quota ORDER BY updated_at DESC').all() as
    { worker_id: string; adapter: string; quota_json: string; updated_at: number }[]
  const seen = db.prepare(`SELECT adapter, model_used AS model, max(dispatched_at) AS last FROM task_runs
    WHERE model_used IS NOT NULL GROUP BY adapter, model_used ORDER BY last DESC`).all() as { adapter: string; model: string }[]
  const declared = new Set(workers.flatMap(w => w.adapters.map(a => a.id)))
  const ready = new Set(workers.filter(w => w.connection === 'online').flatMap(w => w.adapters.filter(a => a.status === 'ready').map(a => a.id)))
  const used = new Set(month.map(r => r.adapter))
  return LISTED.filter(id => declared.has(id) || used.has(id) || settings.has(id)).map(adapter => {
    const defaultModel = settings.get(adapter) ?? null
    const suggestedModels = [...new Set([...(defaultModel ? [defaultModel] : []), ...(ALIASES[adapter] ?? []),
      ...seen.filter(s => s.adapter === adapter).map(s => s.model)])].slice(0, 32)
    const quota: AgentQuota[] = quotas.filter(q => q.adapter === adapter).slice(0, 16).map(q => ({ workerId: q.worker_id,
      windows: (JSON.parse(q.quota_json) as QuotaWindow[]).slice(0, 8), updatedAt: q.updated_at }))
    const byModel = month.filter(r => r.adapter === adapter).map(r => ({ model: r.model, ...totals(r) }))
      .sort((a, b) => b.runs - a.runs).slice(0, 32)
    return { adapter, ready: ready.has(adapter), defaultModel, suggestedModels, quota,
      usage: { today: sum(today, adapter), week: sum(week, adapter), month: sum(month, adapter) }, byModel }
  })
}
