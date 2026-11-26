import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MethodCard, TaskDetail } from '@agent-hub/protocol'
import type { TaskDetail as TaskDetailType } from '@agent-hub/protocol'
import { errorText, json, request } from './api.js'
import { statusLabels } from './format.js'

export function RelayChain({ task, open }: { task: TaskDetailType; open: (id: string) => void }) {
  const cache = useQueryClient()
  const [distilling, setDistilling] = useState(false)
  const [name, setName] = useState(() => task.title.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || '我的方法')
  const [scenario, setScenario] = useState('')
  const [steps, setSteps] = useState(() => (task.prompt + '\n\n参考输出：\n' + (task.resultSummary ?? '')).slice(0, 3500))
  const [savedCard, setSavedCard] = useState<string>()

  const parentTask = useQuery({
    queryKey: ['task-brief', task.parentTaskId],
    enabled: Boolean(task.parentTaskId),
    queryFn: ({ signal }) => request('/tasks/' + encodeURIComponent(task.parentTaskId!), TaskDetail, { signal }),
  })

  const saveMethod = useMutation({
    mutationFn: () => request('/methods', MethodCard, json('POST', {
      name: name.trim(),
      kind: 'skill',
      scenario: scenario.trim(),
      avoid: '',
      keywords: task.subdir ? [task.subdir] : [],
      steps: steps.trim(),
      done: '',
    })),
    onSuccess: card => {
      setSavedCard(card.name)
      setDistilling(false)
      void cache.invalidateQueries({ queryKey: ['methods'] })
    },
  })

  const parentData = parentTask.data
  const hasChain = Boolean(task.handoff || task.parentTaskId || task.children.length)

  return <section className="relay-chain surface" data-testid="relay-chain">
    <div className="section-heading">
      <h3>🔀 Agent 接力轨迹与经验沉淀</h3>
      {task.status === 'succeeded' && !savedCard && <button type="button" data-testid="distill-method-btn" onClick={() => setDistilling(!distilling)}>
        {distilling ? '收起' : '📚 沉淀为方法卡'}
      </button>}
    </div>
    {savedCard && <p className="pill online">已收藏到方法库：『{savedCard}』</p>}
    {hasChain && <div className="relay-nodes">
      {(task.handoff || task.parentTaskId) && <>
        <button type="button" className="relay-node" onClick={() => open(task.handoff?.fromTaskId ?? task.parentTaskId!)}>
          <span className="muted">上游{task.handoff ? ` (${task.handoff.intent === 'fix' ? '修复' : '接力'})` : '对话'}</span>
          <strong>#{task.handoff?.fromTaskNo ?? parentData?.taskNo ?? '…'}</strong>
          {parentData?.adapter && <code>{parentData.adapter}</code>}
        </button>
        <span className="relay-arrow">→</span>
      </>}
      <div className="relay-node current">
        <span className="muted">当前任务</span>
        <strong>#{task.taskNo}</strong>
        <code>{task.runs[0]?.adapter ?? task.adapter ?? '自动'}</code>
        <span className="pill">{statusLabels[task.status]}</span>
      </div>
      {task.children.map(child => <span key={child.id} className="relay-branch">
        <span className="relay-arrow">→</span>
        <button type="button" className="relay-node" onClick={() => open(child.id)}>
          <span className="muted">下游接力</span>
          <strong>#{child.taskNo}</strong>
          <span className="pill">{statusLabels[child.status]}</span>
        </button>
      </span>)}
    </div>}
    {distilling && <form className="action-form" data-testid="distill-method-form" onSubmit={e => { e.preventDefault(); saveMethod.mutate() }}>
      <label>方法名称<input required value={name} onChange={e => setName(e.target.value)} maxLength={60} /></label>
      <label>适用场景<input value={scenario} onChange={e => setScenario(e.target.value)} placeholder="遇到类似问题时自动推荐" maxLength={500} /></label>
      <label>执行步骤<textarea required rows={3} value={steps} onChange={e => setSteps(e.target.value)} maxLength={4000} /></label>
      {saveMethod.error && <p className="error compact" role="alert">{errorText(saveMethod.error)}</p>}
      <button type="submit" className="primary" disabled={saveMethod.isPending}>保存到方法库</button>
    </form>}
  </section>
}
