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
/** 指挥台当前看的范围：workspaceId '' = 全部工作区；subdir '' = 整个工作区。 */
export interface Scope { workspaceId: string; subdir: string }
const key = (project: ProjectOverview) => project.workerId + '/' + project.workspaceId + (project.subdir ? '/' + project.subdir : '')
const SCOPE_KEY = 'helmcraft.workspace'
export function storedWorkspace() {
  try { return localStorage.getItem(SCOPE_KEY) } catch { return null }
}
function rememberWorkspace(id: string) {
  try { localStorage.setItem(SCOPE_KEY, id) } catch { /* 隐私模式下只是记不住选择 */ }
}
/** 没选过时默认看「有子项目最多」的工作区；都没有子项目就看全部。 */
export function defaultWorkspace(projects: ProjectOverview[]) {
  const counts = new Map<string, number>()
  for (const p of projects) if (p.subdir) counts.set(p.workspaceId, (counts.get(p.workspaceId) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
}

function Status({ project }: { project: ProjectOverview }) {
  return <span className={'pill ' + (project.workerOnline ? 'online' : 'offline')}><i className="dot" />
    {!project.workerOnline ? '节点离线' : project.activeTasks ? '执行中 ' + project.activeTasks : '空闲'}</span>
}
function Adapters({ project }: { project: ProjectOverview }) {
  return <span className="cli-tags">{project.allowedAdapters.map(adapter => <code key={adapter}>{adapter}</code>)}</span>
}

interface Actions {
  scope: Scope
  setScope(scope: Scope): void
  open(id: string): void
  create(project: ProjectOverview): void
}
function ProjectDetail({ project, worker, scope, setScope, create, open }: Actions & {
  project: ProjectOverview; worker: WorkerView | undefined
}) {
  const draining = useDashboard(state => state.overview?.hub.draining)
  const { latestTaskId } = project
  const subdir = project.subdir ?? ''
  const scoped = scope.workspaceId === project.workspaceId && scope.subdir === subdir
  // 工作区本身用上方的「工作区」选择切换；卡片上的「只看」只针对工作区里的子项目
  const canFilter = !!subdir
  return <article className="project-detail">
    <header className="project-header">
      <div><h3>{project.label} <Status project={project} /></h3>
        <small className="muted mono">{subdir ? '项目文件夹 ' + subdir + '/' : key(project)}</small></div>
      <div className="project-actions">
        <button className="primary" data-testid="project-new-task" disabled={draining || worker?.status !== 'active' || !project.allowedAdapters.length}
          onClick={() => create(project)}>＋ 派任务到此项目</button>
        {canFilter && <button data-testid="project-filter-tasks" aria-pressed={scoped}
          onClick={() => setScope({ workspaceId: project.workspaceId, subdir: scoped ? '' : subdir })}>只看本项目任务</button>}
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
  const { scope, setScope } = actions
  const [selected, setSelected] = useState('')
  const all = query.data ?? []
  const workspaces = all.filter(p => !p.subdir)
  // 选了工作区：只列它的子项目（没有子项目时列它自己）；全部工作区：每个工作区一张卡
  const inWorkspace = all.filter(p => p.workspaceId === scope.workspaceId)
  const cards = !scope.workspaceId ? workspaces : inWorkspace.some(p => p.subdir) ? inWorkspace.filter(p => p.subdir) : inWorkspace
  const project = cards.find(p => key(p) === selected) ?? cards.find(p => p.subdir === (scope.subdir || undefined)) ?? cards[0]
  const visibleProject = project && key(project)
  useEffect(() => { if (visibleProject) setSelected(visibleProject) }, [visibleProject])
  const choose = (workspaceId: string) => { rememberWorkspace(workspaceId || '*'); setScope({ workspaceId, subdir: '' }) }
  return <section className="project-hub" data-testid="project-hub">
    <div className="section-heading"><h2>项目管理中心</h2>
      <label className="workspace-picker">工作区<select data-testid="project-workspace" value={scope.workspaceId} onChange={e => choose(e.target.value)}>
        {workspaces.map(ws => <option key={key(ws)} value={ws.workspaceId}>{ws.label}</option>)}
        {scope.workspaceId && !workspaces.some(ws => ws.workspaceId === scope.workspaceId) && <option value={scope.workspaceId}>{scope.workspaceId}</option>}
        <option value="">全部工作区</option>
      </select></label>
      <span className="muted">{scope.workspaceId ? cards.filter(p => p.subdir).length + ' 个项目' : workspaces.length + ' 个工作区'}</span></div>
    {query.error && <p role="alert" className="error">{errorText(query.error)}</p>}
    {query.isPending && <p role="status">正在读取项目…</p>}
    {query.isSuccess && !cards.length && <p className="empty-panel">暂无已登记的工作区</p>}
    {scope.workspaceId && !inWorkspace.some(p => p.subdir) && query.isSuccess &&
      <p className="muted small">在这个工作区目录下新建文件夹，它就会作为一个项目出现在这里（约 10 秒内）。</p>}
    <div className="project-grid">{cards.map(p => {
      const summary = projectHeadline(p.board)
      return <button type="button" className="project-card" key={key(p)} aria-pressed={project && key(p) === key(project)} onClick={() => {
        setSelected(key(p))
        // 已在按项目筛选时，换卡片就跟着换筛选
        if (scope.subdir && p.subdir) setScope({ workspaceId: p.workspaceId, subdir: p.subdir })
      }}>
        <span className="project-card-heading"><strong>{p.label}</strong><Status project={p} /></span>
        <small className="mono muted">{p.subdir ? (p.isGitRepo ? 'git 仓库' : '文件夹') : key(p)}</small>
        {summary && <span className="project-headline">{summary}</span>}
        {!p.subdir && <Adapters project={p} />}
        <span className="project-counts">{p.totalTasks ? '成功 ' + p.succeededTasks + ' · 失败 ' + p.failedTasks : '还没有任务'}
          {p.latestVerification && p.latestVerification !== 'skipped' && p.latestVerification !== 'pending' && <VerificationBadge state={p.latestVerification} />}</span>
      </button>
    })}</div>
    {project && <ProjectDetail key={key(project)} project={project} worker={workers.find(w => w.id === project.workerId)} {...actions} />}
  </section>
}
