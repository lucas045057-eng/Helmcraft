import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AgentOverviewResponse, ModelName, SetAgentModelResponse } from '@agent-hub/protocol'
import type { AgentOverview, QuotaWindow, UsageTotals } from '@agent-hub/protocol'
import { errorText, json, request } from './api.js'

const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini', opencode: 'OpenCode' }
const windowNames: Record<string, string> = { five_hour: '5 小时窗口', seven_day: '7 天窗口', seven_day_opus: '7 天（Opus）', seven_day_sonnet: '7 天（Sonnet）' }

/** 1234 → 1.2K，1234567 → 1.2M */
export function compact(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}
const money = (usd: number) => usd > 0 ? '$' + (usd >= 10 ? usd.toFixed(1) : usd.toFixed(2)) : '—'
const clock = (at: number, now: number) => {
  const d = new Date(at)
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return at - now < 86_400_000 ? hm : d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + hm
}

function Quota({ windows, now }: { windows: QuotaWindow[]; now: number }) {
  return <div className="quota-list">{windows.map(w => {
    const pct = Math.min(100, Math.round(w.utilization * 100))
    return <div key={w.name} className="quota-row" data-testid={'quota-' + w.name}>
      <span>{windowNames[w.name] ?? w.name}</span>
      <span className={'quota-bar' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '')}><i style={{ width: pct + '%' }} /></span>
      <strong>{pct}%</strong>
      <span className="muted small">{w.resetsAt ? clock(w.resetsAt, now) + ' 重置' : ''}</span>
    </div>
  })}</div>
}

function Totals({ label, t }: { label: string; t: UsageTotals }) {
  return <div className="usage-cell"><span className="muted small">{label}</span>
    <strong>{t.runs} 次</strong>
    <span className="small" title={'输入 ' + t.inputTokens + ' · 输出 ' + t.outputTokens + ' · 缓存读 ' + t.cacheReadTokens}>
      {compact(t.inputTokens + t.outputTokens)} token</span>
    <span className="small muted">{money(t.costUsd)}</span></div>
}

function ModelPicker({ agent }: { agent: AgentOverview }) {
  const cache = useQueryClient()
  const [value, setValue] = useState(agent.defaultModel ?? '')
  const [hint, setHint] = useState('')
  const save = useMutation({
    mutationFn: (model: string | null) => request('/agents/' + agent.adapter + '/model', SetAgentModelResponse, json('PUT', { model })),
    onSuccess: result => { setValue(result.defaultModel ?? ''); setHint('已保存'); void cache.invalidateQueries({ queryKey: ['agents'] }) },
  })
  const trimmed = value.trim()
  const invalid = trimmed !== '' && !ModelName.safeParse(trimmed).success
  return <form className="model-picker" onSubmit={e => { e.preventDefault(); setHint(''); save.mutate(trimmed || null) }}>
    <label>默认模型
      <input list={'models-' + agent.adapter} value={value} placeholder="不设置 = 用 CLI 自己的默认" data-testid={'agent-model-' + agent.adapter}
        onChange={e => { setValue(e.target.value); setHint('') }} />
      <datalist id={'models-' + agent.adapter}>{agent.suggestedModels.map(m => <option key={m} value={m} />)}</datalist>
    </label>
    <button type="submit" className="primary" disabled={invalid || save.isPending || trimmed === (agent.defaultModel ?? '')}
      data-testid={'agent-model-save-' + agent.adapter}>保存</button>
    {agent.defaultModel && <button type="button" onClick={() => { setHint(''); save.mutate(null) }}>恢复 CLI 默认</button>}
    {invalid && <span className="error small">模型名只能包含字母、数字和 . _ : / - [ ]</span>}
    {save.error && <span className="error small" role="alert">{errorText(save.error)}</span>}
    {hint && <span className="muted small">{hint}</span>}
  </form>
}

function AgentCard({ agent, now }: { agent: AgentOverview; now: number }) {
  const windows = agent.quota[0]?.windows ?? []
  return <article className="agent-card" data-testid={'agent-card-' + agent.adapter}>
    <header><h3>{names[agent.adapter] ?? agent.adapter} <span className={'pill ' + (agent.ready ? 'online' : 'offline')}><i className="dot" />{agent.ready ? '可用' : '不可用'}</span></h3>
      <code className="muted">{agent.adapter}</code></header>
    <ModelPicker key={agent.defaultModel ?? ''} agent={agent} />
    <section><h4>订阅额度 {agent.quota[0] && <span className="muted small">· {clock(agent.quota[0].updatedAt, now)} 更新</span>}</h4>
      {windows.length ? <Quota windows={windows} now={now} />
        : <p className="muted small">{agent.adapter === 'claude-code' ? '跑一次任务后显示（由 CLI 在运行时上报）' : '这个 CLI 不上报额度'}</p>}</section>
    <section><h4>用量</h4>
      <div className="usage-grid"><Totals label="今天" t={agent.usage.today} /><Totals label="近 7 天" t={agent.usage.week} /><Totals label="近 30 天" t={agent.usage.month} /></div></section>
    {agent.byModel.length > 0 && <details className="by-model"><summary>按模型（近 30 天）</summary>
      <table><thead><tr><th>模型</th><th>次数</th><th>输入</th><th>输出</th><th>缓存读</th><th>费用</th></tr></thead>
        <tbody>{agent.byModel.map(m => <tr key={m.model}><td className="mono">{m.model || '未上报'}</td><td>{m.runs}</td>
          <td>{compact(m.inputTokens)}</td><td>{compact(m.outputTokens)}</td><td>{compact(m.cacheReadTokens)}</td><td>{money(m.costUsd)}</td></tr>)}</tbody></table>
    </details>}
  </article>
}

export function AgentsPage({ now }: { now: number }) {
  const query = useQuery({ queryKey: ['agents'], refetchInterval: 30_000,
    queryFn: ({ signal }) => request('/agents', AgentOverviewResponse, { signal }) })
  return <section className="agents-page" data-testid="agents-page">
    <div className="section-heading"><h2>模型与用量</h2>
      <span className="muted small">任务没指定模型时用这里的默认模型；费用为 CLI 自报的按量估算，订阅用户以额度为准</span></div>
    {query.error && <p className="error" role="alert">{errorText(query.error)}</p>}
    {query.isPending && <p role="status">正在读取…</p>}
    <div className="agent-grid">{(query.data ?? []).map(agent => <AgentCard key={agent.adapter} agent={agent} now={now} />)}</div>
  </section>
}
