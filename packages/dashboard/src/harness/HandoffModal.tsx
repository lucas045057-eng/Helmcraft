import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { HANDOFF_DEFAULT_PROMPTS, PREVIEW_NONCE, neutralizeReservedTags } from '@agent-hub/protocol'
import type { AdapterId, HandoffTaskRequest, RunView, TaskDetail, WorkerView } from '@agent-hub/protocol'
import { errorText, handoffPreview, handoffTask } from '../api.js'

export function HandoffModal({ task, run, worker, initialPrompt, initialIntent = 'relay', close, open }: {
  task: TaskDetail; run: RunView; worker?: WorkerView | undefined; initialPrompt: string; initialIntent?: 'relay' | 'fix' | undefined; close(): void; open(id: string): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current!
    node.showModal()
    return () => node.close()
  }, [])
  const [intent, setIntent] = useState<'relay' | 'fix'>(initialIntent)
  const [adapter, setAdapter] = useState<AdapterId>()
  const [prompt, setPrompt] = useState(initialPrompt)
  const [tab, setTab] = useState<'facts' | 'board' | 'prompt'>('facts')
  const key = useRef({ body: '', id: '' })
  const targets = worker?.adapters.filter(a => a.status === 'ready' && worker.workspaces.find(w => w.id === run.workspaceId)?.allowedAdapters.includes(a.id))
  const query = useQuery({ queryKey: ['handoff-preview', task.id, run.id, intent, adapter], queryFn: ({ signal }) =>
    handoffPreview(task.id, { fromRunId: run.id, intent, adapter }, signal) })
  const mutation = useMutation({ mutationFn: () => {
    const body: HandoffTaskRequest = { fromRunId: run.id, intent, adapter, ...(prompt.trim() && { prompt }), expectedVersion: task.version }
    const hash = JSON.stringify(body)
    if (key.current.body !== hash) key.current = { body: hash, id: crypto.randomUUID() }
    return handoffTask(task.id, body, key.current.id)
  }, onSuccess: child => { close(); open(child.id) } })
  const preview = query.data
  const marker = '<task id="' + PREVIEW_NONCE + '">'
  const composed = preview?.promptPreview.replace(marker + '\n' + neutralizeReservedTags(HANDOFF_DEFAULT_PROMPTS[intent]), () => marker + '\n' + neutralizeReservedTags(prompt.trim() ? prompt : HANDOFF_DEFAULT_PROMPTS[intent]))
  return <dialog ref={dialog} aria-label="换 CLI 接力" className="handoff-dialog" onCancel={e => { e.preventDefault(); close() }}
    onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}><div className="action-form">
    <h3>换 CLI 接力</h3>
    <label>目标 CLI<select data-testid="handoff-cli" value={adapter ?? ''} onChange={e => setAdapter(e.target.value as AdapterId || undefined)}>
      <option value="">自动选择</option>{targets?.map(a => <option key={a.id}>{a.id}</option>)}</select></label>
    <label>意图<select data-testid="handoff-intent" value={intent} onChange={e => setIntent(e.target.value as typeof intent)}>
      <option value="relay">接力</option><option value="fix">修复</option></select></label>
    <label>任务要求<textarea data-testid="handoff-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={32000} placeholder={HANDOFF_DEFAULT_PROMPTS[intent]} /></label>
    <div data-testid="handoff-preview">
      {preview?.warnings.map(w => <p className="warning" key={w}>{w}</p>)}
      {(['facts', 'board', 'prompt'] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{{ facts: '可信事实', board: '黑板快照', prompt: '组合 Prompt' }[t]}</button>)}
      {preview && <pre>{tab === 'facts' ? JSON.stringify(preview.facts, null, 2) : tab === 'prompt' ? composed :
        preview.board?.files.map(f => f.file + '\n' + (f.content ?? f.status)).join('\n\n') ?? '无快照'}</pre>}
      {query.isPending && <p>正在加载预览…</p>}
      {query.error && <p role="alert">{errorText(query.error)}</p>}
    </div>
    {mutation.error && <p role="alert">{errorText(mutation.error)}</p>}
    <div><button onClick={close}>关闭</button> <button className="primary" data-testid="handoff-submit" disabled={mutation.isPending || !preview} onClick={() => mutation.mutate()}>创建接力任务</button></div>
  </div></dialog>
}
