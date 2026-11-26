import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AuthMeResponse, LoginResponse, TaskDetail } from '@agent-hub/protocol'
import type { WorkerView } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, request, sessionExpired, setCsrf } from './api.js'
import { DashboardConnection } from './connection.js'
import { Login } from './Login.js'
import { MissionDrawer } from './MissionDrawer.js'
import { Pipeline } from './Pipeline.js'
import { Today } from './Today.js'
import { ProjectHub, useProjects } from './ProjectHub.js'
import { useDashboard } from './store.js'
import { SystemPage } from './SystemPage.js'
import { MethodLibrary } from './MethodLibrary.js'
import { readTaskFields, TaskFields } from './TaskForm.js'
import type { TaskDefaults } from './TaskForm.js'

const feishuLabels = { disabled: '已关闭', connecting: '连接中', connected: '已连接', reconnecting: '重连中', failed: '异常' }
const connectionLabels = { connecting: '连接中', live: '实时在线', offline: '连接中断', limited: '连接数已满' }
function Header({ create, approval, logout, activeProjects }: { create: () => void; approval: () => void; logout: () => void; activeProjects: number | undefined }) {
  const overview = useDashboard(state => state.overview)
  const connection = useDashboard(state => state.connection)
  const hub = overview?.hub
  const alerts = [hub?.draining && 'Hub 正在排空并关闭', hub?.restartRequired && '配置已更改，需重启 Hub', hub?.configError,
    hub?.storageLevel === 'warning' && '数据库容量已达 80%，日志保留期减半',
    hub?.storageLevel === 'critical' && '数据库容量已达 95%，已暂停保存新日志正文，任务状态仍会更新',
  ].filter(Boolean)
  const pending = overview ? overview.counts.awaiting_approval + overview.counts.awaiting_input : 0
  const metric = (label: string, value: string | number) => <div className="metric"><span>{label}</span><strong>{value}</strong></div>
  return <>
    <header className="command-header" data-testid="command-header">
      <div className="header-brand"><div className="brand-mark" aria-hidden="true">⌘</div>
        <div><div className="wordmark">AGENT<span>HUB</span></div><span>虚拟中台指挥台</span></div></div>
      <div className="header-actions"><span className={'pill realtime ' + connection} data-testid="dashboard-connection"><i className="dot" />{connectionLabels[connection]}</span>
        <button type="button" data-testid="logout" onClick={logout}>登出</button>
        <button type="button" className="primary" data-testid="new-task" onClick={create} disabled={hub?.draining}>＋ 新建任务</button>
      </div>
    </header>
    <div className="metrics" data-testid="overview-metrics">
      <div className="metric"><span>飞书长连接</span><strong><i className={'dot ' + (overview?.feishu.state ?? 'disabled')} />{overview ? feishuLabels[overview.feishu.state] : '—'}</strong></div>
      {metric('进行中', overview ? overview.counts.queued + overview.counts.running + overview.counts.dispatching + overview.counts.cancelling : '—')}
      <button type="button" className="metric approval-metric" data-testid="pending-approval" onClick={approval} title="待审批 + AI 在等你回答">
        <span>要你处理</span><strong>{pending ? <i className="dot red" /> : null}{overview ? pending : '—'}</strong></button>
      {metric('今日完成 / 失败', overview ? overview.today.succeeded + ' / ' + overview.today.failed : '—')}
      {activeProjects !== undefined && activeProjects > 0 && metric('活跃项目', activeProjects)}
    </div>
    {alerts.length > 0 && <div className="hub-alerts warning" role="alert" data-testid="hub-alerts">{alerts.join(' · ')}</div>}
  </>
}

function CreateDialog({ close, workers, ...defaults }: TaskDefaults & { close: () => void; workers: WorkerView[] }) {
  const cache = useQueryClient()
  const create = useMutation({
    mutationFn: (fields: ReturnType<typeof readTaskFields>['fields']) => request('/tasks', TaskDetail, json('POST', fields)),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ['task-history'] }); close() },
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [close])
  return <div className="dialog-layer center">
    <button className="backdrop" tabIndex={-1} aria-label="关闭" onClick={close} />
    <section role="dialog" aria-modal="true" aria-labelledby="new-task-title" className="create-dialog" data-testid="new-task-dialog">
      <header className="drawer-header"><h2 id="new-task-title">新建任务</h2>
        <button type="button" aria-label="关闭" onClick={close}>×</button></header>
      <form onSubmit={event => { event.preventDefault(); create.mutate(readTaskFields(event.currentTarget).fields) }}>
        <TaskFields workers={workers} {...defaults} />
        {create.error && <p className="error" role="alert">{errorText(create.error)}</p>}
        <div className="dialog-actions"><button type="button" onClick={close}>取消</button>
          <button type="submit" className="primary" data-testid="task-create-submit" disabled={create.isPending}>提交任务</button></div>
      </form>
    </section>
  </div>
}

function Console({ logout }: { logout: () => Promise<void> }) {
  const cache = useQueryClient()
  const projects = useProjects()
  const client = useMemo(() => new DashboardConnection(() => { void cache.invalidateQueries() },
    () => { void cache.invalidateQueries({ queryKey: ['projects'] }, { cancelRefetch: false }) }), [cache])
  const workerMap = useDashboard(state => state.workers)
  const clockOffset = useDashboard(state => state.clockOffset)
  const live = useDashboard(state => state.tasks)
  const [time, setTime] = useState(Date.now)
  const [page, setPage] = useState<'overview' | 'methods' | 'system'>('overview')
  const [lane, setLane] = useState('')
  const [history, setHistory] = useState(false)
  const [taskId, setTaskId] = useState<string | undefined>(() => /^\/tasks\/(tsk_[0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(window.location.pathname)?.[1])
  const [createDefaults, setCreateDefaults] = useState<TaskDefaults>()
  const [workspaceId, setWorkspaceId] = useState('')
  const [error, setError] = useState('')
  const workers = useMemo(() => Object.values(workerMap).sort((a, b) => a.displayName.localeCompare(b.displayName)), [workerMap])
  const closeCreate = useCallback(() => setCreateDefaults(undefined), [])
  const closeTask = useCallback(() => setTaskId(undefined), [])
  useEffect(() => client.start(), [client])
  useEffect(() => {
    const timer = setInterval(() => setTime(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <div className="console" data-testid="command-center">
    <Header activeProjects={projects.data?.filter(project => project.activeTasks > 0).length}
      create={() => setCreateDefaults({})} approval={() => { setPage('overview'); setWorkspaceId(''); setHistory(false) }}
      logout={() => void logout().catch(error => setError(errorText(error)))} />
    {error && <p role="alert" className="error">{error}</p>}
    <nav className="main-tabs" aria-label="指挥台">
      <button type="button" aria-current={page === 'overview' ? 'page' : undefined} data-testid="operations-tab" onClick={() => setPage('overview')}>▦ 指挥台</button>
      <button type="button" aria-current={page === 'methods' ? 'page' : undefined} data-testid="methods-tab" onClick={() => setPage('methods')}>📚 方法库</button>
      <button type="button" aria-current={page === 'system' ? 'page' : undefined} data-testid="system-tab" onClick={() => setPage('system')}>⚙ 系统治理</button>
    </nav>
    <main className="console-body">{page === 'overview' ? <>
      <ProjectHub query={projects} workers={workers} workspaceId={workspaceId} filter={setWorkspaceId} open={setTaskId}
        create={project => setCreateDefaults({ defaultWorkspaceId: project.workspaceId, defaultWorkerId: project.workerId, defaultProfile: 'full' })} />
      {history ? <>
        <button type="button" className="text-button" data-testid="back-to-today" onClick={() => setHistory(false)}>← 返回今日概览</button>
        <Pipeline live={live} workers={workers} projects={projects.data ?? []} workspaceId={workspaceId} setWorkspace={setWorkspaceId}
          now={time + clockOffset} lane={lane} setLane={setLane} open={setTaskId} initialMode="table" />
      </> : <Today live={live} now={time + clockOffset} workspaceId={workspaceId} open={setTaskId} showHistory={() => setHistory(true)} />}
    </> : page === 'methods' ? <MethodLibrary /> : <SystemPage workers={workers} now={time + clockOffset} open={setTaskId} />}</main>
    {createDefaults && <CreateDialog close={closeCreate} workers={workers} {...createDefaults} />}
    {taskId && <MissionDrawer key={taskId} id={taskId} workers={workers} connection={client} close={closeTask} open={setTaskId} />}
  </div>
}

export function App() {
  const [session, setSession] = useState<'checking' | 'owner' | 'anonymous'>('checking')
  const cache = useQueryClient()
  useEffect(() => {
    const abort = new AbortController()
    const clear = () => {
      setCsrf()
      setSession('anonymous')
      cache.clear()
      useDashboard.getState().clear()
      useDashboard.setState({ connection: 'connecting', clockOffset: 0 })
    }
    sessionExpired.addEventListener('expired', clear)
    void request('/auth/me', AuthMeResponse, { signal: abort.signal }).then(me => {
      if (!abort.signal.aborted) { setCsrf(me.csrfToken); setSession('owner') }
    }).catch(() => { if (!abort.signal.aborted) clear() })
    return () => { abort.abort(); sessionExpired.removeEventListener('expired', clear) }
  }, [cache])
  if (session === 'checking') return <main className="login-shell"><p role="status">正在恢复会话…</p></main>
  if (session === 'anonymous') return <Login onLogin={async token => {
    const login = await request('/auth/login', LoginResponse, json('POST', { token }))
    setCsrf(login.csrfToken)
    const me = await request('/auth/me', AuthMeResponse)
    setCsrf(me.csrfToken)
    setSession('owner')
  }} />
  return <Console logout={async () => {
    await request('/auth/logout', emptyResponse, json('POST'))
    sessionExpired.dispatchEvent(new Event('expired'))
  }} />
}

