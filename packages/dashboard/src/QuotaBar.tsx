import { useQuery } from '@tanstack/react-query'
import { QuotaOverviewResponse } from '@agent-hub/protocol'
import type { QuotaWindow } from '@agent-hub/protocol'
import { request } from './api.js'

const names: Record<string, string> = { 'claude-code': 'Claude', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini', opencode: 'OpenCode' }
const order = ['claude-code', 'codex', 'antigravity']

function when(at: number, now: number) {
  const d = new Date(at)
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return at - now < 86_400_000 ? hm : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + hm
}

function Meter({ w, now }: { w: QuotaWindow; now: number }) {
  const reset = w.resetsAt !== null && w.resetsAt <= now
  const used = reset ? 0 : Math.round(w.usedPercent)
  const tone = used >= 90 ? ' danger' : used >= 70 ? ' warn' : ''
  const title = w.label + ' 已用 ' + (reset ? '0%（已重置）' : used + '%') + (w.resetsAt && !reset ? '，' + when(w.resetsAt, now) + ' 重置' : '')
  return <span className="quota-meter" title={title}>
    <span className="muted">{w.label}</span>
    <span className={'quota-track' + tone}><i style={{ width: used + '%' }} /></span>
    <strong>{used}%</strong>
  </span>
}

/** 面板顶部：三家 CLI 的订阅额度（Worker 每 5 分钟查一次）。 */
export function QuotaBar({ now }: { now: number }) {
  const query = useQuery({ queryKey: ['quotas'], refetchInterval: 60_000,
    queryFn: ({ signal }) => request('/quotas', QuotaOverviewResponse, { signal }) })
  const rows = [...(query.data ?? [])].sort((a, b) => (order.indexOf(a.adapter) + 1 || 9) - (order.indexOf(b.adapter) + 1 || 9))
  if (!rows.length) return null
  return <div className="quota-bar-strip" data-testid="quota-bar" aria-label="订阅额度">
    {rows.map(q => <span key={q.workerId + q.adapter} className="quota-agent" data-testid={'quota-' + q.adapter}
      title={(q.plan ? names[q.adapter] + ' ' + q.plan + ' · ' : '') + '数据时间 ' + when(q.checkedAt, now) + (q.error ? ' · ' + q.error : '')}>
      <b>{names[q.adapter] ?? q.adapter}{q.error && <span className="quota-stale" aria-label={q.error}> ⚠</span>}</b>
      {q.windows.length ? q.windows.map(w => <Meter key={w.label} w={w} now={now} />) : <span className="muted">{q.error ?? '暂无数据'}</span>}
    </span>)}
  </div>
}
