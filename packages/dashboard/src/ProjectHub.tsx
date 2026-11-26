import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ProjectOverview } from '@agent-hub/protocol'
import type { WorkerView } from '@agent-hub/protocol'
import { errorText, request } from './api.js'
import { VerificationBadge } from './harness/VerificationPanel.js'
import { ProjectBoard, projectHeadline } from './ProjectBoard.js'
import { useDashboard } from './store.js'

const projectList = ProjectOverview.array()
export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: ({ signal }) => request('/projects', projectList, { signal }), refetchInterval: 5000 })
}
const key = (project: ProjectOverview) => project.workerId + '/' + project.workspaceId
function Status({ project }: { project: ProjectOverview }) {
  return <span className={'pill ' + (project.workerOnline ? 'online' : 'offline')}><i className="dot" />
    {!project.workerOnline ? '节点离线' : project.activeTasks ? '执行中 ' + project.activeTasks : '空闲'}</span>
}
function Adapters({ project }: { project: ProjectOverview }) {
  return <span className="cli-tags">{project.allowedAdapters.map(adapter => <code key={adapter}>{adapter}</code>)}</span>
}

interface Actions {
  workspaceId: string
  filter(id: string): void
  open(id: string): void
  create(project: ProjectOverview): void
}
function ProjectDetail({ project, worker, workspaceId, filter, create, open }: Actions & {
  project: ProjectOverview; worker: WorkerView | undefined
}) {
  const draining = useDashboard(state => state.overview?.hub.draining)
  const { latestTaskId } = project
  return <article className="project-detail">
    <header className="project-header">
      <div><h3>{project.label} <Status project={project} /></h3><small className="muted mono">{key(project)}</small></div>
      <div className="project-actions">
        <button className="primary" data-testid="project-new-task" disabled={draining || worker?.status !== 'active' || !project.allowedAdapters.length}
          onClick={() => create(project)}>＋ 派任务到此项目</button>
        <button data-testid="project-filter-tasks" aria-pressed={workspaceId === project.workspaceId}
          onClick={() => filter(workspaceId === project.workspaceId ? '' : project.workspaceId)}>只看本项目任务</button>
      </div>
    </header>
    <div className="project-context">
      {latestTaskId && <button className="text-button" onClick={() => open(latestTaskId)}>打开最近一次任务 #{project.latestTaskNo}</button>}
    </div>
    {project.board ? <ProjectBoard board={project.board} /> : <div className="project-facts">
      <span>共 {project.totalTasks} 项任务 · 成功 {project.succeededTasks} · 失败 {project.failedTasks}</span><Adapters project={project} />
    </div>}
  </article>
}

export function ProjectHub({ query, workers, ...actions }: Actions & { query: ReturnType<typeof useProjects>; workers: WorkerView[] }) {
  const [selected, setSelected] = useState('')
  const projects = query.data ?? []
  const candidates = actions.workspaceId ? projects.filter(p => p.workspaceId === actions.workspaceId) : projects
  const project = candidates.find(p => key(p) === selected) ?? candidates[0]
  const visibleProject = project && key(project)
  useEffect(() => { if (visibleProject) setSelected(visibleProject) }, [visibleProject])
  return <section className="project-hub" data-testid="project-hub">
    <div className="section-heading"><h2>项目管理中心</h2><span className="muted">{projects.length} 个项目</span></div>
    {query.error && <p role="alert" className="error">{errorText(query.error)}</p>}
    {query.isPending && <p role="status">正在读取项目…</p>}
    {query.isSuccess && !projects.length && <p className="empty-panel">暂无已登记的工作区</p>}
    <div className="project-grid">{projects.map(p => {
      const summary = projectHeadline(p.board)
      return <button type="button" className="project-card" key={key(p)} aria-pressed={project && key(p) === key(project)} onClick={() => {
        setSelected(key(p))
        if (actions.workspaceId) actions.filter(p.workspaceId)
      }}>
        <span className="project-card-heading"><strong>{p.label}</strong><Status project={p} /></span>
        <small className="mono muted">{key(p)}</small>
        {summary && <span className="project-headline">{summary}</span>}
        <Adapters project={p} />
        <span className="project-counts">成功 {p.succeededTasks} · 失败 {p.failedTasks}
          {p.latestVerification && p.latestVerification !== 'skipped' && p.latestVerification !== 'pending' && <VerificationBadge state={p.latestVerification} />}</span>
      </button>
    })}</div>
    {project && <ProjectDetail key={key(project)} project={project} worker={workers.find(w => w.id === project.workerId)} {...actions} />}
  </section>
}
