import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { projectOf, TaskListResponse } from '@agent-hub/protocol'
import type { TaskStatus, TaskSummary } from '@agent-hub/protocol'
import { errorText, request, searchParams } from './api.js'
import { duration, sourceLabels, statusLabels } from './format.js'
import { VerificationBadge } from './harness/VerificationPanel.js'

// 首页只回答三件事：要我处理什么、在跑什么、最近做完了什么。完整历史在「查看全部历史」里。
export const RECENT_WINDOW_MS = 24 * 3600_000
export const RECENT_LIMIT = 5
const running: TaskStatus[] = ['queued', 'dispatching', 'running', 'cancelling']
const finished: TaskStatus[] = ['succeeded', 'failed', 'timed_out', 'cancelled', 'rejected']
const needsMe = (task: TaskSummary) => task.status === 'awaiting_approval' || task.status === 'awaiting_input' || task.resultDeliveryStatus === 'pending_review'
const ago = (now: number, at: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  return minutes < 1 ? '刚刚' : minutes < 60 ? minutes + ' 分钟前' : Math.round(minutes / 60) + ' 小时前'
}

/** 同一串追问（parentTaskId 链）合并成一条，只保留最新一轮；rounds 为本串在窗口内的轮数。 */
export function recentChains(tasks: TaskSummary[], now: number, windowMs = RECENT_WINDOW_MS, limit = RECENT_LIMIT) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const rootOf = (task: TaskSummary) => {
    let current = task
    for (let hops = 0; current.parentTaskId && byId.has(current.parentTaskId) && hops < 50; hops++) current = byId.get(current.parentTaskId)!
    return current.id
  }
  const chains = new Map<string, { latest: TaskSummary; rounds: number }>()
  for (const task of tasks) {
    if (!finished.includes(task.status) || task.finishedAt === null || now - task.finishedAt > windowMs) continue
    const root = rootOf(task)
    const chain = chains.get(root)
    if (!chain) chains.set(root, { latest: task, rounds: 1 })
    else chains.set(root, { latest: task.taskNo > chain.latest.taskNo ? task : chain.latest, rounds: chain.rounds + 1 })
  }
  return [...chains.values()].sort((a, b) => (b.latest.finishedAt ?? 0) - (a.latest.finishedAt ?? 0)).slice(0, limit)
}

function Row({ task, now, open, rounds }: { task: TaskSummary; now: number; open(): void; rounds?: number }) {
  const failed = ['failed', 'timed_out'].includes(task.status)
  const hint = task.status === 'awaiting_approval' ? '等你批准' : task.status === 'awaiting_input' ? 'AI 在等你回答问题'
    : task.resultDeliveryStatus === 'pending_review' ? '结果等你审核后发出' : task.lastProgress ?? task.scheduleHint
  return <button type="button" className={'today-row' + (failed ? ' failed' : '')} onClick={open} data-testid={'task-card-' + task.taskNo} data-status={task.status}>
    <span className="today-title"><strong>#{task.taskNo}</strong> {task.title}</span>
    {projectOf(task.subdir) && <span className="pill project-pill">{projectOf(task.subdir)}</span>}
    <span className="today-meta">
      <span className={'pill status-' + task.status}>{statusLabels[task.status]}</span>
      {rounds && rounds > 1 && <span className="pill">共 {rounds} 轮</span>}
      {task.verification && task.verification !== 'skipped' && task.verification !== 'pending' && <VerificationBadge state={task.verification} />}
      <span className="muted">{task.adapter ?? '自动选择 CLI'} · {sourceLabels[task.origin.source]}</span>
      <span className="muted">{task.finishedAt ? ago(now, task.finishedAt) : task.startedAt ? '已运行 ' + duration(now - task.startedAt) : ago(now, task.createdAt)}</span>
    </span>
    {hint && <span className="today-hint">{hint}</span>}
  </button>
}

export function Today({ live, now, workspaceId, subdir = '', open, showHistory }: { live: Record<string, TaskSummary>; now: number; workspaceId: string;
  subdir?: string; open(id: string): void; showHistory(): void }) {
  // 「要你处理」不分工作区（别的工作区等你批准也要看到）；进行中 / 最近完成只看当前范围
  const query = useQuery({ queryKey: ['task-history', 'today'], refetchInterval: 15_000,
    queryFn: ({ signal }) => request('/tasks' + searchParams({ limit: '200' }), TaskListResponse, { signal }) })
  const tasks = useMemo(() => {
    const joined = new Map<string, TaskSummary>()
    for (const item of query.data?.items ?? []) joined.set(item.id, item)
    for (const task of Object.values(live)) {
      const previous = joined.get(task.id)
      if (!previous || previous.version <= task.version) joined.set(task.id, task)
    }
    return [...joined.values()].sort((a, b) => b.taskNo - a.taskNo)
  }, [query.data, live])
  const scoped = tasks.filter(task => (!workspaceId || task.workspaceId === workspaceId) && (!subdir || projectOf(task.subdir) === subdir))
  const mine = tasks.filter(needsMe)
  const active = scoped.filter(task => running.includes(task.status) && !needsMe(task))
  // 已在「要你处理」里的（如结果待审核）不在最近完成里重复出现
  const recent = recentChains(scoped.filter(task => !needsMe(task)), now)
  return <section className="today" data-testid="today">
    {query.error && <p className="error" role="alert">{errorText(query.error)}</p>}
    {mine.length > 0 && <div className="today-group attention" data-testid="today-attention"><h2>要你处理 <span className="pill">{mine.length}</span></h2>
      {mine.map(task => <Row key={task.id} task={task} now={now} open={() => open(task.id)} />)}</div>}
    <div className="today-group" data-testid="today-running"><h2>进行中 {active.length > 0 && <span className="pill">{active.length}</span>}</h2>
      {active.length ? active.map(task => <Row key={task.id} task={task} now={now} open={() => open(task.id)} />)
        : <p className="muted">现在没有在跑的任务</p>}</div>
    <div className="today-group" data-testid="today-recent"><h2>最近完成 <span className="muted small">24 小时内 · 同一串追问合并显示</span></h2>
      {recent.length ? recent.map(({ latest, rounds }) => <Row key={latest.id} task={latest} rounds={rounds} now={now} open={() => open(latest.id)} />)
        : <p className="muted">24 小时内没有完成的任务</p>}
      <button type="button" className="text-button" data-testid="show-history" onClick={showHistory}>查看全部历史 →</button></div>
  </section>
}
