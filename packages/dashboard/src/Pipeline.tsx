import { useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { TaskListResponse } from '@agent-hub/protocol'
import type { ProjectOverview, TaskSummary, WorkerView } from '@agent-hub/protocol'
import { errorText, request, searchParams } from './api.js'
import { VerificationBadge } from './harness/VerificationPanel.js'
import { duration, lanes, sourceLabels, statusLabels } from './format.js'

function TaskCard({ task, now, open }: { task: TaskSummary; now: number; open: () => void }) {
  return <button className="task-card" type="button" onClick={open} data-testid={'task-card-' + task.taskNo} data-status={task.status}>
    <span className="task-card-top"><strong>#{task.taskNo}</strong><span className="pill" title={task.origin.feishu?.chatName ?? task.requester.name ?? task.requester.id}>{sourceLabels[task.origin.source]}</span></span>
    <span className="task-title">{task.title}</span>
    <span className="task-meta">{task.adapter ?? '自动 CLI'} · {task.workerId ?? '未分配'}</span>
    {task.verification && task.verification !== 'skipped' && <VerificationBadge state={task.verification} />}
    {task.lastProgress && <span className="task-progress">{task.lastProgress}</span>}
    {task.scheduleHint && <span className="warning task-progress">{task.scheduleHint}</span>}
    <span className="task-card-bottom"><span>{statusLabels[task.status]}</span>
      <span>{duration(task.startedAt === null ? null : (task.finishedAt ?? now) - task.startedAt)}</span></span>
  </button>
}

export function Pipeline({ live, workers, now, lane, setLane, open, projects, workspaceId, setWorkspace }: { live: Record<string, TaskSummary>; workers: WorkerView[];
  projects: ProjectOverview[]; workspaceId: string; setWorkspace(id: string): void;
  now: number; lane: string; setLane: (value: string) => void; open: (id: string) => void }) {
  const [mode, setMode] = useState<'kanban' | 'table'>('kanban')
  const workspaces = new Map(projects.map(project => [project.workspaceId, project.label]))
  const [adapter, setAdapter] = useState('')
  const [keyword, setKeyword] = useState('')
  const statuses = lanes.find(item => item.id === lane)?.statuses
  const q = keyword.trim()
  const query = useInfiniteQuery({
    queryKey: ['task-history', lane, workspaceId, adapter, q], initialPageParam: '',
    queryFn: ({ pageParam, signal }) => request('/tasks' + searchParams({
      status: statuses?.join(','), workspaceId, adapter, q, limit: '50', cursor: pageParam,
    }), TaskListResponse, { signal }),
    getNextPageParam: page => page.nextCursor,
    refetchInterval: q ? 3000 : false,
  })
  const filtered = useMemo(() => {
    const joined = new Map<string, TaskSummary>()
    for (const page of query.data?.pages ?? []) for (const item of page.items) joined.set(item.id, item)
    for (const task of Object.values(live)) {
      const previous = joined.get(task.id)
      if (previous && previous.version > task.version) continue
      if (!q || previous || task.title.toLocaleLowerCase().includes(q.toLocaleLowerCase())) joined.set(task.id, task)
    }
    return [...joined.values()].filter(task => (!statuses || statuses.includes(task.status)) && (!workspaceId || workspaceId === task.workspaceId) &&
      (!adapter || adapter === task.adapter)).sort((a, b) => b.taskNo - a.taskNo)
  }, [query.data, live, q, statuses, workspaceId, adapter])
  const shownLanes = lane ? lanes.filter(item => item.id === lane) : lanes
  const adapters = [...new Set([...workers.flatMap(worker => worker.adapters.map(item => item.id)), ...filtered.flatMap(t => t.adapter ? [t.adapter] : [])])]
  return <section data-testid="task-pipeline">
    <div className="section-heading"><h2>任务流水线</h2>
      <div className="segmented"><button type="button" aria-pressed={mode === 'kanban'} data-testid="view-kanban" onClick={() => setMode('kanban')}>▦ 看板</button>
        <button type="button" aria-pressed={mode === 'table'} data-testid="view-table" onClick={() => setMode('table')}>☷ 表格</button></div>
    </div>
    <div className="filters">
      <input aria-label="关键词" placeholder="搜索任务关键词" value={keyword} onChange={e => setKeyword(e.target.value)} data-testid="task-search" />
      <select aria-label="任务状态" value={lane} onChange={e => setLane(e.target.value)} data-testid="task-filter-status">
        <option value="">全部状态</option>{lanes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <select aria-label="项目工作区" value={workspaceId} onChange={e => setWorkspace(e.target.value)} data-testid="task-filter-workspace">
        <option value="">全部项目</option>{[...workspaces].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <select aria-label="CLI" value={adapter} onChange={e => setAdapter(e.target.value)} data-testid="task-filter-adapter">
        <option value="">全部 CLI</option>{adapters.map(id => <option key={id}>{id}</option>)}
      </select>
    </div>
    {query.error && <p className="error" role="alert">{errorText(query.error)}</p>}
    {mode === 'kanban' ? <div className="kanban" data-testid="kanban">{shownLanes.map(item => {
      const items = filtered.filter(task => item.statuses.includes(task.status))
      return <section className={'lane lane-' + item.id} data-testid={'lane-' + item.id} key={item.id}>
        <h3><i className="dot" />{item.label}<span>{items.length}</span></h3>
        <div className="lane-tasks">{items.map(task => <TaskCard key={task.id} task={task} now={now} open={() => open(task.id)} />)}
          {!items.length && <div className="lane-empty">暂无任务</div>}</div>
      </section>
    })}</div> : <div className="table-wrap"><table data-testid="task-table"><thead>
      <tr><th>任务</th><th>来源</th><th>状态</th><th>CLI</th><th>Worker</th><th>耗时</th><th>进展</th></tr>
    </thead><tbody>{filtered.map(task => <tr key={task.id} data-status={task.status}>
      <td><button type="button" className="text-button" onClick={() => open(task.id)} data-testid={'task-row-' + task.taskNo}>#{task.taskNo} {task.title}</button></td>
      <td>{sourceLabels[task.origin.source]}</td><td>{statusLabels[task.status]} {task.verification && task.verification !== 'skipped' && <VerificationBadge state={task.verification} />}</td><td>{task.adapter ?? '—'}</td><td>{task.workerId ?? '—'}</td>
      <td>{duration(task.startedAt === null ? null : (task.finishedAt ?? now) - task.startedAt)}</td><td>{task.lastProgress ?? task.scheduleHint ?? '—'}</td>
    </tr>)}</tbody></table>{!filtered.length && <p className="empty-panel">暂无匹配任务</p>}</div>}
    {query.hasNextPage && <button type="button" className="more" data-testid="load-history" onClick={() => void query.fetchNextPage()}
      disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? '加载中…' : '加载更多历史'}</button>}
  </section>
}

