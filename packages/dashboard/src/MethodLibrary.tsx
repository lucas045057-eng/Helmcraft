import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MethodCard, MethodKind, MethodListResponse, MethodSuggestResponse } from '@agent-hub/protocol'
import type { MethodCard as Card } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, request } from './api.js'

// 个人方法库（docs/specs/10-method-library.md）：收藏亲自用过、愿意再用的 Skill 与 SOP。
type Draft = { name: string; kind: 'skill' | 'sop'; scenario: string; avoid: string; keywords: string; steps: string; done: string }
const blank: Draft = { name: '', kind: 'skill', scenario: '', avoid: '', keywords: '', steps: '', done: '' }
const toDraft = (card: Card): Draft => ({ ...card, keywords: card.keywords.join('，') })
const toBody = (draft: Draft) => ({ ...draft, keywords: draft.keywords.split(/[,，、\s]+/u).map(word => word.trim()).filter(Boolean) })
const date = (ms: number) => new Date(ms).toLocaleDateString()

function Editor({ card, close }: { card?: Card | undefined; close: () => void }) {
  const cache = useQueryClient()
  const [draft, setDraft] = useState<Draft>(card ? toDraft(card) : blank)
  const set = (key: keyof Draft) => (event: { target: { value: string } }) => setDraft({ ...draft, [key]: event.target.value })
  const save = useMutation({
    mutationFn: () => card ? request('/methods/' + card.id, MethodCard, json('PUT', { ...toBody(draft), expectedRevision: card.revision }))
      : request('/methods', MethodCard, json('POST', toBody(draft))),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['methods'] }); close() },
  })
  return <form className="method-editor" data-testid="method-editor" onSubmit={event => { event.preventDefault(); save.mutate() }}>
    <div className="task-fields">
      <label>名字<input data-testid="method-name" value={draft.name} onChange={set('name')} maxLength={60} required placeholder="给外行画流程图" /></label>
      <label>类型<select value={draft.kind} onChange={set('kind')}>
        {MethodKind.options.map(kind => <option key={kind} value={kind}>{kind === 'skill' ? 'Skill（一个工具或技巧）' : 'SOP（几个步骤）'}</option>)}</select></label>
      <label className="full">适用场景（用于推荐和搜索，写成能拿来判断的一句话）
        <textarea data-testid="method-scenario" rows={2} value={draft.scenario} onChange={set('scenario')} maxLength={500}
          placeholder="想让不懂技术的人看懂一条流程：从哪进来、经过谁、最后到哪" /></label>
      <label>不适合（命中则不推荐）<input value={draft.avoid} onChange={set('avoid')} maxLength={300} placeholder="写代码、修 bug" /></label>
      <label>关键词（逗号分隔）<input value={draft.keywords} onChange={set('keywords')} placeholder="流程图，archify" /></label>
      <label className="full">怎么做（SOP 可用『方法名』引用其他卡）
        <textarea data-testid="method-steps" rows={5} value={draft.steps} onChange={set('steps')} maxLength={4000} required /></label>
      <label className="full">什么算做好<textarea rows={2} value={draft.done} onChange={set('done')} maxLength={1000} /></label>
    </div>
    {save.error && <p className="error" role="alert">{errorText(save.error)}</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>取消</button>
      <button type="submit" className="primary" data-testid="method-save" disabled={save.isPending}>{card ? '保存（r' + (card.revision + 1) + '）' : '收藏'}</button></div>
  </form>
}

function Examples({ card }: { card: Card }) {
  const cache = useQueryClient()
  const [taskNo, setTaskNo] = useState('')
  const [note, setNote] = useState({ title: '', content: '' })
  const refresh = () => void cache.invalidateQueries({ queryKey: ['methods'] })
  const add = useMutation({ mutationFn: (body: object) => request('/methods/' + card.id + '/examples', MethodCard, json('POST', body)),
    onSuccess: () => { setTaskNo(''); setNote({ title: '', content: '' }); refresh() } })
  const remove = useMutation({ mutationFn: (id: string) => request('/methods/' + card.id + '/examples/' + id, MethodCard, json('DELETE')), onSuccess: refresh })
  return <div className="method-examples">
    <h4>参照（满意的结果）</h4>
    {card.examples.length ? <ul>{card.examples.map(example => <li key={example.id}>
      <strong>{example.taskNo ? '#' + example.taskNo + ' ' : '本人确认 · '}{example.title}</strong> <span>r{example.revision} · {date(example.createdAt)}</span>
      <button type="button" onClick={() => remove.mutate(example.id)}>移除</button>
      <pre>{example.content.slice(0, 600)}</pre></li>)}</ul> : <p className="muted">还没有参照。挂上一次满意的结果，半年后才知道它好在哪。</p>}
    <div className="action-list">
      <input value={taskNo} onChange={event => setTaskNo(event.target.value)} placeholder="任务号，如 #23" data-testid="method-example-task" />
      <button type="button" disabled={!taskNo.trim() || add.isPending} onClick={() => add.mutate({ taskId: taskNo.trim() })}>挂上任务结果</button>
    </div>
    <div className="action-list">
      <input value={note.title} onChange={event => setNote({ ...note, title: event.target.value })} placeholder="标题（在中台外用过的）" />
      <input value={note.content} onChange={event => setNote({ ...note, content: event.target.value })} placeholder="内容或链接" />
      <button type="button" disabled={!note.title.trim() || !note.content.trim() || add.isPending} onClick={() => add.mutate(note)}>添加本人确认</button>
    </div>
    {(add.error || remove.error) && <p className="error" role="alert">{errorText(add.error ?? remove.error)}</p>}
  </div>
}

export function MethodLibrary() {
  const cache = useQueryClient()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Card | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [probe, setProbe] = useState('')
  const list = useQuery({ queryKey: ['methods', q.trim()], queryFn: ({ signal }) =>
    request('/methods' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''), MethodListResponse, { signal }) })
  const suggestion = useMutation({ mutationFn: (prompt: string) => request('/methods/suggest', MethodSuggestResponse, json('POST', { prompt })) })
  const remove = useMutation({ mutationFn: (id: string) => request('/methods/' + id, emptyResponse, json('DELETE')),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['methods'] }) })
  return <section data-testid="method-library">
    <div className="section-heading"><h2>方法库</h2>
      <div className="action-list"><input value={q} onChange={event => setQ(event.target.value)} placeholder="按名字、场景、关键词搜索" data-testid="method-search" />
        <button type="button" className="primary" data-testid="method-new" onClick={() => setEditing('new')}>＋ 收藏方法</button></div></div>
    <p className="muted">飞书里用 <code>用『名字』需求</code> 或 <code>/m 名字 需求</code> 点名；没点名时会按「适用场景」推荐，确认后才生效。方法只跟当次任务走。</p>
    {editing && <Editor key={editing === 'new' ? 'new' : editing.id} card={editing === 'new' ? undefined : editing} close={() => setEditing(null)} />}
    {list.error && <p className="error" role="alert">{errorText(list.error)}</p>}
    <div className="method-list">{(list.data ?? []).map(card => <article key={card.id} className="method-card" data-testid={'method-card-' + card.name}>
      <header><strong>{card.name}</strong> <span className="pill">{card.kind === 'sop' ? 'SOP' : 'Skill'}</span> <span className="pill">本人确认</span>
        <span className="muted"> r{card.revision} · {date(card.updatedAt)} · 参照 {card.examples.length}</span></header>
      {card.scenario && <p><b>适用场景：</b>{card.scenario}</p>}
      {card.avoid && <p><b>不适合：</b>{card.avoid}</p>}
      <div className="action-list"><button type="button" onClick={() => setOpen(open === card.id ? null : card.id)}>{open === card.id ? '收起' : '详情'}</button>
        <button type="button" onClick={() => setEditing(card)}>编辑</button>
        <button type="button" onClick={() => { if (window.confirm('删除『' + card.name + '』？已创建的任务保留当时的快照。')) remove.mutate(card.id) }}>删除</button></div>
      {open === card.id && <>
        <h4>怎么做</h4><pre>{card.steps}</pre>
        {card.done && <><h4>什么算做好</h4><pre>{card.done}</pre></>}
        <Examples card={card} />
      </>}
    </article>)}
    {list.data?.length === 0 && <p className="muted">{q ? '没有匹配的方法' : '还没有收藏方法。先收一张你最近用得满意的。'}</p>}</div>
    <div className="method-probe"><h3>试试推荐</h3>
      <div className="action-list"><input value={probe} onChange={event => setProbe(event.target.value)} placeholder="输入一句需求，看看会推荐哪张卡" data-testid="method-probe" />
        <button type="button" disabled={!probe.trim()} onClick={() => suggestion.mutate(probe)}>推荐</button></div>
      {suggestion.data && (suggestion.data.length ? <ul>{suggestion.data.map(item => <li key={item.id}>『{item.name}』 · 匹配度 {(item.score * 100).toFixed(0)}%</li>)}</ul>
        : <p className="muted">没有足够匹配的方法，不会弹出推荐</p>)}</div>
  </section>
}
