import { useState } from 'react'
import type { FormEvent } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiTokensResponse, AuditResponse, CreateApiTokenResponse, EnrollTokenResponse, FibersResponse,
  PoliciesResponse, ReplacePoliciesResponse, Scope, WorkerView } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, request, requestWithHeaders, searchParams } from './api.js'
import { duration, formatTime } from './format.js'
import { useDashboard } from './store.js'
import { WorkerFleet } from './WorkerFleet.js'
import { PersonalProject } from './PersonalProject.js'

function Feedback({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">{errorText(error)}</p> : null
}

function Policies() {
  const cache = useQueryClient()
  const [draft, setDraft] = useState<{ text: string; revision: number }>()
  const query = useQuery({ queryKey: ['policies'], queryFn: async () => {
    const response = await requestWithHeaders('/config/policies', PoliciesResponse)
    const revision = Number(response.headers.get('X-Policy-Revision'))
    return { text: JSON.stringify(response.data, null, 2), revision }
  } })
  const current = draft ?? query.data
  const save = useMutation({
    mutationFn: ({ text, revision }: NonNullable<typeof current>) =>
      request('/config/policies', ReplacePoliciesResponse, json('PUT', { rules: PoliciesResponse.parse(JSON.parse(text)), expectedRevision: revision })),
    onSuccess: result => {
      if (current) cache.setQueryData(['policies'], { ...current, revision: result.revision })
      setDraft(undefined)
      void cache.invalidateQueries({ queryKey: ['policies'] })
    },
  })
  return <section className="surface" data-testid="system-policies">
    <div className="section-heading"><h3>策略规则</h3><span className="mono muted">修订 {current?.revision ?? '—'}</span></div>
    <label>规则 JSON<textarea aria-label="规则 JSON" className="json-editor" rows={10} spellCheck={false} data-testid="policy-editor"
      value={current?.text ?? ''} onChange={e => { if (current) setDraft({ ...current, text: e.target.value }) }} /></label>
    <div className="action-list"><button className="primary" data-testid="policies-save" disabled={!draft || save.isPending}
      onClick={() => { if (draft) save.mutate(draft) }}>保存策略</button>
      <button disabled={save.isPending} onClick={() => { setDraft(undefined); save.reset(); void query.refetch() }}>重新读取</button>
      {save.isSuccess && <span role="status">已保存修订 {save.data.revision}</span>}
    </div>
    <Feedback error={save.error || query.error} />
  </section>
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState('')
  return <div className="copy-field">
    <label>{label}<textarea readOnly value={value} rows={2} onFocus={e => e.target.select()} /></label>
    <button type="button" onClick={() => void (navigator.clipboard?.writeText(value) ?? Promise.reject())
      .then(() => setFeedback('已复制'), () => setFeedback('请选择文本复制'))}>复制</button>
    {feedback && <span role="status">{feedback}</span>}
  </div>
}

function Workers({ workers }: { workers: WorkerView[] }) {
  const [confirm, setConfirm] = useState('')
  const [selection, setSelection] = useState('')
  const enrollment = useMutation({ mutationFn: (id: string) => request('/workers/enroll-tokens', EnrollTokenResponse,
    json('POST', id ? { suggestedWorkerId: id } : {})) })
  const revoke = useMutation({ mutationFn: (id: string) => request('/workers/' + encodeURIComponent(id) + '/revoke', WorkerView,
    json('POST', { confirm })), onSuccess: () => { setSelection(''); setConfirm('') } })
  return <section className="surface" data-testid="system-workers">
    <h3>Worker 注册与吊销</h3>
    <form className="inline-form" onSubmit={e => {
      e.preventDefault()
      enrollment.mutate(String(new FormData(e.currentTarget).get('worker') ?? '').trim())
    }}>
      <label>建议 Worker ID<input name="worker" placeholder="可选" /></label>
      <button type="submit" data-testid="worker-enroll-generate" disabled={enrollment.isPending}>生成注册命令</button>
    </form>
    {enrollment.data && <CopyField value={enrollment.data.command} label={'注册命令 · ' + formatTime(enrollment.data.expiresAt) + ' 到期'} />}
    <form className="inline-form" onSubmit={e => { e.preventDefault(); if (selection && confirm === selection) revoke.mutate(selection) }}>
      <label>待吊销 Worker<select value={selection} data-testid="revoke-worker-select" onChange={e => { setSelection(e.target.value); setConfirm('') }}>
        <option value="">选择节点</option>{workers.filter(worker => worker.status === 'active').map(worker => <option key={worker.id} value={worker.id}>{worker.id}</option>)}
      </select></label>
      <label>输入 Worker ID 确认<input data-testid="revoke-worker-confirm" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <button type="submit" className="danger" data-testid="revoke-worker-submit" disabled={!selection || selection !== confirm || revoke.isPending}>吊销</button>
    </form>
    <Feedback error={enrollment.error || revoke.error} />
  </section>
}

function Tokens() {
  const cache = useQueryClient()
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => request('/api-tokens', ApiTokensResponse) })
  const refresh = () => { void cache.invalidateQueries({ queryKey: ['api-tokens'] }) }
  const create = useMutation({ mutationFn: (body: object) => request('/api-tokens', CreateApiTokenResponse, json('POST', body)), onSuccess: refresh })
  const revoke = useMutation({ mutationFn: (id: string) => request('/api-tokens/' + encodeURIComponent(id), emptyResponse, json('DELETE')), onSuccess: refresh })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const expiresAt = String(data.get('expiresAt') ?? '')
    create.mutate({ name: data.get('name'), scopes: [data.get('scope')], ...(expiresAt && { expiresAt: new Date(expiresAt).getTime() }) })
  }
  return <section className="surface" data-testid="system-tokens">
    <h3>API Token</h3>
    <form className="inline-form" onSubmit={submit}>
      <label>名称<input name="name" required /></label>
      <label>权限<select name="scope">{Scope.options.map(scope => <option key={scope}>{scope}</option>)}</select></label>
      <label>到期时间<input type="datetime-local" name="expiresAt" /></label>
      <button type="submit" className="primary" data-testid="api-token-create" disabled={create.isPending}>创建 Token</button>
    </form>
    {create.data && <CopyField value={create.data.token} label="明文 Token（仅此处展示）" />}
    <div className="table-wrap"><table><thead><tr><th>名称</th><th>权限</th><th>到期</th><th>操作</th></tr></thead>
      <tbody>{tokens.data?.map(token => <tr key={token.id}><td>{token.name}</td><td>{token.scopes.join(', ')}</td>
        <td>{token.expiresAt === null ? '长期' : formatTime(token.expiresAt)}</td><td>{token.revokedAt !== null ? '已吊销'
          : <button type="button" className="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>吊销</button>}</td></tr>)}</tbody>
    </table></div>
    <Feedback error={tokens.error || create.error || revoke.error} />
  </section>
}

function Audit() {
  const [filter, setFilter] = useState<Record<string, string>>({})
  const query = useInfiniteQuery({ queryKey: ['audit', filter], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => request('/audit' + searchParams({ ...filter, cursor: pageParam }), AuditResponse, { signal }),
    getNextPageParam: last => last.nextCursor,
  })
  return <section className="surface full" data-testid="system-audit">
    <h3>审计日志</h3>
    <form className="inline-form" onSubmit={e => {
      e.preventDefault()
      setFilter(Object.fromEntries([...new FormData(e.currentTarget)].map(([key, value]) => [key, String(value)])))
    }}>
      <label>目标类型<input name="targetType" /></label><label>目标 ID<input name="targetId" /></label>
      <label>操作人 ID<input name="actorId" /></label><label>操作<input name="action" /></label>
      <button type="submit" data-testid="audit-search">查询</button>
    </form>
    <div className="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>详情</th></tr></thead><tbody>
      {query.data?.pages.flatMap(page => page.items).map((item, index) => <tr key={index}><td>{formatTime(item.ts)}</td>
        <td>{item.actor.name ?? item.actor.id}</td><td>{item.action}</td><td>{item.targetType} · {item.targetId}</td>
        <td>{item.details !== undefined && <details><summary>查看</summary><pre>{JSON.stringify(item.details, null, 2)}</pre></details>}</td></tr>)}
    </tbody></table></div>
    {query.hasNextPage && <button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多</button>}
    <Feedback error={query.error} />
  </section>
}

function Fibers() {
  const query = useQuery({ queryKey: ['fibers'], queryFn: () => request('/system/fibers', FibersResponse), refetchInterval: 5000 })
  return <section className="surface" data-testid="system-fibers">
    <h3>Cordis 插件健康</h3>
    {query.data?.map((fiber, index) => <div className="fiber" key={fiber.name + index}>
      <span>{fiber.name}</span><span className={'pill ' + (fiber.state.toUpperCase() === 'ACTIVE' ? 'online' : '')}>{fiber.state}</span>
      {fiber.error && <p className="error">{fiber.error}</p>}
    </div>)}
    <Feedback error={query.error} />
  </section>
}

function Stats() {
  const overview = useDashboard(state => state.overview)
  if (!overview) return null
  const item = (label: string, value: string, hint: string) => <div className="metric" title={hint}><span>{label}</span><strong>{value}</strong></div>
  return <section data-testid="system-stats"><div className="section-heading"><h2>运行统计（今日）</h2></div><div className="metrics">
    {item('成功率', overview.today.successRate != null ? (overview.today.successRate * 100).toFixed(1) + '%' : '—', '今日结束的任务里成功的比例')}
    {item('P50 耗时', duration(overview.today.p50DurationMs ?? null), '今日任务耗时的中位数')}
    {item('并发槽位', overview.slotsUsed + ' / ' + overview.slotsTotal, '所有 Worker 同时能跑的任务数，已占用 / 总数')}
    {item('在线 Worker', overview.workersOnline + ' / ' + overview.workersTotal, '连上中台、可以接任务的本机节点')}
  </div></section>
}

export function SystemPage({ workers, now, open }: { workers: WorkerView[]; now: number; open(id: string): void }) {
  return <div data-testid="system-page" className="system-page">
    <Stats />
    <WorkerFleet workers={workers} now={now} /><PersonalProject open={open} />
    <div className="system-grid"><Policies /><Workers workers={workers} /><Tokens /><Fibers /><Audit /></div>
  </div>
}

