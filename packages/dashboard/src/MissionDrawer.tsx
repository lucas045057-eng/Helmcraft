import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_PREFIX, TaskDetail } from '@agent-hub/protocol'
import type { TaskAction, WorkerView } from '@agent-hub/protocol'
import { VerificationPanel } from './harness/VerificationPanel.js'
import { BoardPanel } from './harness/BoardPanel.js'
import { WorkspacePointer } from './harness/WorkspacePointer.js'
import { HandoffModal } from './harness/HandoffModal.js'
import { errorText, json, request, runHarness } from './api.js'
import type { DashboardConnection } from './connection.js'
import { formatTime, statusLabels } from './format.js'
import { LogBuffer } from './logs.js'
import { useDashboard } from './store.js'
import { readTaskFields, TaskFields } from './TaskForm.js'
import { TerminalPane } from './Terminal.js'

const actionNames: Record<TaskAction, string> = { approve: '批准', reject: '驳回', cancel: '取消', retry: '重试',
  input: '补充输入', followup: '继续对话', deliver_result: '审核回传' }

function Interventions({ task, workers, stale, open }: { task: TaskDetail; workers: WorkerView[]; stale: boolean; open: (id: string) => void }) {
  const [selected, setSelected] = useState<TaskAction>()
  const cache = useQueryClient()
  const queryKey = ['task', task.id]
  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: TaskAction; body: object }) =>
      request('/tasks/' + task.id + '/' + action.replace('_', '-'), TaskDetail, json('POST', body)),
    onSuccess: (updated, input) => {
      cache.setQueryData(['task', updated.id], updated)
      void cache.invalidateQueries({ queryKey: ['task-history'] })
      setSelected(undefined)
      if (input.action === 'followup') open(updated.id)
    },
    onError: () => { void cache.invalidateQueries({ queryKey }) },
  })
  const allowed = selected && task.allowedActions.includes(selected) ? selected : undefined
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!allowed || stale) return
    const form = event.currentTarget
    const data = new FormData(form, (event.nativeEvent as SubmitEvent).submitter)
    const value = (key: string) => String(data.get(key) ?? '')
    const expectedVersion = task.version
    let body: object = { expectedVersion }
    switch (allowed) {
      case 'approve': {
        const mode = value('harness')
        body = { expectedVersion, overrides: { ...readTaskFields(form, task).overrides,
          ...(mode && mode !== 'default' && { harness: { blackboard: mode !== 'off', ...(mode !== 'board' && { verify: mode === 'board_verify' }) } }) } }
        break
      }
      case 'reject': body = { expectedVersion, reason: value('reason') }; break
      case 'input': body = { expectedVersion, requestId: task.inputRequest?.requestId, answer: value('option') || value('answer') }; break
      case 'followup': body = { expectedVersion, prompt: value('prompt') }; break
      case 'deliver_result': body = { expectedVersion, action: value('delivery'), ...(value('summary') && { summaryOverride: value('summary') }) }; break
    }
    mutation.mutate({ action: allowed, body })
  }
  return <section className="interventions" data-testid="task-actions">
    <div className="section-heading"><h3>干预操作台</h3><span className="mono muted">v{task.version}</span></div>
    <div className="action-list">{task.allowedActions.map(action => <button type="button" data-testid={'action-' + action}
      key={action} className={action === 'approve' ? 'primary' : action === 'cancel' || action === 'reject' ? 'danger' : ''}
      aria-expanded={['approve', 'reject', 'input', 'followup', 'deliver_result'].includes(action) ? allowed === action : undefined}
      disabled={stale || mutation.isPending} onClick={() => {
        mutation.reset()
        if (action === 'cancel' || action === 'retry') mutation.mutate({ action, body: { expectedVersion: task.version } })
        else setSelected(allowed === action ? undefined : action)
      }}>{actionNames[action]}</button>)}
      {!task.allowedActions.length && <span className="muted">当前状态无可用操作</span>}
    </div>
    {allowed && !stale && <form className="action-form" data-testid={'action-form-' + allowed} onSubmit={submit} key={allowed}>
      {allowed === 'approve' && <><TaskFields workers={workers} task={task} />
        <label>工作区辅助<select name="harness" defaultValue="default">
          <option value="default">使用默认策略</option><option value="board">黑板</option>
          <option value="board_verify">黑板与验证</option><option value="off">关闭</option>
        </select></label></>}
      {allowed === 'reject' && <label>驳回理由<textarea name="reason" maxLength={500} rows={2} /></label>}
      {allowed === 'input' && task.inputRequest && <>
        <p>{task.inputRequest.question}</p>
        {task.inputRequest.options?.length ? <label>选项<select defaultValue="" name="option" data-testid="input-option">
          <option value="">自定义答案</option>{task.inputRequest.options.map(option => <option key={option}>{option}</option>)}
        </select></label> : null}
        <label>答复<textarea name="answer" rows={3} maxLength={20000} data-testid="input-answer" /></label>
      </>}
      {allowed === 'followup' && <label>Prompt<textarea name="prompt" required rows={4} maxLength={32000} /></label>}
      {allowed === 'deliver_result' ? <>
        <label>结果摘要<textarea name="summary" maxLength={20000} defaultValue={task.resultSummary ?? ''} rows={4} /></label>
        <div className="action-list"><button className="primary" name="delivery" value="send" disabled={mutation.isPending}>发送结果</button>
          <button className="danger" name="delivery" value="suppress" disabled={mutation.isPending}>屏蔽结果</button></div>
      </> : <button className="primary" data-testid={allowed + '-submit'} type="submit" disabled={mutation.isPending}>{actionNames[allowed]}</button>}
    </form>}
    {mutation.error && <p role="alert" className="error compact">{errorText(mutation.error)}</p>}
  </section>
}

export function MissionDrawer({ id, workers, connection, close, open }: { id: string; workers: WorkerView[];
  connection: DashboardConnection; close: () => void; open: (id: string) => void }) {
  const [tab, setTab] = useState<'logs' | 'timeline'>('logs')
  const [tech, setTech] = useState(false)
  const [pinnedRun, setRun] = useState('')
  const history = useQuery({ queryKey: ['task', id], queryFn: ({ signal }) => request('/tasks/' + id, TaskDetail, { signal }) })
  const detail = useDashboard(state => state.details[id])
  const summary = useDashboard(state => state.tasks[id])
  const streamedRun = useDashboard(state => state.runs)
  const saved = history.data
  const task = detail && detail.version >= (saved?.version ?? -1) ? detail : saved
  const runId = pinnedRun || task?.runs[0]?.id || ''
  const buffer = useMemo(() => new LogBuffer(), [runId])
  const run = streamedRun[runId] ?? task?.runs.find(candidate => candidate.id === runId)
  const [handoff, setHandoff] = useState<{ runId: string; prompt: string; intent?: 'fix' }>()
  const acceptedId = useDashboard(s => run && s.pointers[run.workerId + '/' + run.workspaceId]?.lastAccepted?.runId)
  const harness = useQuery({ queryKey: ['run-harness', id, runId, run?.lastSeq, run?.status, acceptedId], enabled: !!run?.harness || run?.status === 'succeeded' && run.profile !== 'readonly',
    queryFn: ({ signal }) => runHarness(id, runId, signal) })
  // Dashboard routes require an authenticated Owner session.
  const allowHandoff = task?.allowedActions.includes('followup') && run?.startedAt != null && run.finishedAt != null && (summary?.version ?? -1) <= task.version
  useEffect(() => connection.getTask(id), [connection, id])
  useEffect(() => runId ? connection.followRun(runId, buffer) : undefined, [connection, buffer, runId])
  useEffect(() => {
    function handle(event: KeyboardEvent) { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [close])
  return <div className="dialog-layer">
    <button className="backdrop" aria-label="关闭任务详情" tabIndex={-1} onClick={close} />
    <aside className="mission-drawer" role="dialog" aria-modal="true" aria-label="任务现场" data-testid="mission-drawer">
      <header className="drawer-header"><div><div className="mono muted">{task ? '#' + task.taskNo + ' · ' + statusLabels[summary?.status ?? task.status] : '任务现场'}</div>
        <h2>{task?.title ?? '任务详情'}</h2></div><button type="button" onClick={close} aria-label="关闭" data-testid="drawer-close">×</button></header>
      {history.error && <p role="alert" className="error">{errorText(history.error)}</p>}
      {task && <div className="drawer-body">
        {task.method && <p className="pill method-used" data-testid="task-method-used">使用方法：{task.method.name} · r{task.method.revision}{task.method.via === 'suggested' ? '（推荐后确认）' : ''}</p>}
        {task.resultSummary ? <section className="drawer-result" data-testid="drawer-result"><h3>结果</h3><pre>{task.resultSummary}</pre></section>
          : summary?.lastProgress || task.lastProgress ? <p className="drawer-progress">当前进展：{summary?.lastProgress ?? task.lastProgress}</p> : null}
        <Interventions task={task} workers={workers} stale={(summary?.version ?? -1) > task.version} open={open} />
        <details className="prompt"><summary>你的需求 · {task.workspaceId}</summary><pre>{task.prompt}</pre></details>
        <details className="tech-details" data-testid="tech-details" open={tech} onToggle={event => setTech((event.target as HTMLDetailsElement).open)}>
        <summary>技术详情（排查问题时用）</summary>
        <ul className="tech-help muted">
          <li><b>终端日志</b>：AI 运行时的原始输出，任务出错时先看这里；<b>时间线</b>：任务每一步状态变化的时间。</li>
          <li><b>黑板快照</b>：项目记忆文件（.board）在这次任务前后的变化。</li>
          <li><b>验证</b>：任务结束后 Worker 自动运行的检查命令及结果。</li>
          <li><b>工作区指针</b>：哪一次任务的结果被认作当前可用版本（lastAccepted）。</li>
          <li><b>换 CLI 接力</b>：让另一个 AI 接着这个任务继续做。</li>
        </ul>
        {tech && <>
        <div className="drawer-controls">
          <div className="segmented"><button type="button" data-testid="drawer-logs" aria-pressed={tab === 'logs'} onClick={() => setTab('logs')}>终端日志</button>
            <button type="button" data-testid="drawer-timeline" aria-pressed={tab === 'timeline'} onClick={() => setTab('timeline')}>时间线</button></div>
          {runId && <div className="run-controls"><select aria-label="切换 Run" data-testid="run-select" value={runId} onChange={e => setRun(e.target.value)}>
            {task.runs.map(item => <option value={item.id} key={item.id}>Run #{item.attempt} · {(streamedRun[item.id] ?? item).status}</option>)}
          </select><a data-testid="logs-download" className="button" href={API_PREFIX + '/tasks/' + id + '/runs/' + runId + '/logs.txt'} download>下载 logs.txt</a></div>}
        </div>
        {tab === 'timeline' ? <ol className="timeline" data-testid="task-timeline">
          {task.timeline.map((item, index) => <li key={index}><time>{formatTime(item.ts)}</time><div><strong>{item.event}</strong>
            <span className="muted"> · {item.actor.name ?? item.actor.id}</span>
            <p>{item.from && item.from + ' → '}{item.to}{item.note && ' · ' + item.note}</p></div></li>)}
        </ol> : run ? <TerminalPane key={runId} buffer={buffer} /> : <div className="empty-panel">任务尚未生成运行记录</div>}
        {run && <section aria-label="Harness">
          {harness.error && <p role="alert">{errorText(harness.error)}</p>}
          {harness.data && <>{run.harness && <BoardPanel board={harness.data.board} restore={allowHandoff ? prompt => setHandoff({ runId, prompt }) : undefined} />}
            {harness.data.verification && <VerificationPanel key={runId} task={task} run={run} verification={harness.data.verification}
              tamper={harness.data.tamper} allowFix={!!allowHandoff} open={open} switchCli={() => setHandoff({ runId, prompt: '', intent: 'fix' })} />}
            <WorkspacePointer pointer={harness.data.pointer} run={run} canAccept={harness.data.canAccept} refresh={() => void harness.refetch()} /></>}
        </section>}
        {allowHandoff && <button data-testid="handoff-open" onClick={() => setHandoff({ runId, prompt: '' })}>换 CLI 接力</button>}
        {allowHandoff && run && handoff?.runId === run.id && <HandoffModal key={run.id} task={task} run={run} worker={workers.find(w => w.id === run.workerId)}
          initialIntent={handoff.intent} initialPrompt={handoff.prompt} close={() => setHandoff(undefined)} open={open} />}
        </>}
        </details>
      </div>}
    </aside>
  </div>
}

