import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AdapterId, MethodListResponse, MethodSuggestResponse, Profile } from '@agent-hub/protocol'
import { json, request } from './api.js'
import type { ApprovalOverrides, TaskDetail, WorkerView } from '@agent-hub/protocol'

export interface TaskDefaults {
  defaultWorkerId?: string
  defaultWorkspaceId?: string
  defaultProfile?: Profile
  defaultSubdir?: string
}

export function TaskFields({ workers, task, defaultWorkerId, defaultWorkspaceId, defaultProfile, defaultSubdir }: TaskDefaults & { workers: WorkerView[]; task?: TaskDetail }) {
  const [workerId, setWorkerId] = useState(defaultWorkerId ?? '')
  const [workspaceId, setWorkspaceId] = useState(task?.workspaceId ?? defaultWorkspaceId ?? '')
  const [subdir, setSubdir] = useState(task?.subdir ?? defaultSubdir ?? '')
  const [methodId, setMethodId] = useState('')
  const [suggested, setSuggested] = useState<{ id: string; name: string } | null>(null)
  const methods = useQuery({ queryKey: ['methods'], enabled: !task, queryFn: ({ signal }) => request('/methods', MethodListResponse, { signal }) })
  // 方法库推荐（docs/specs/10）：只提示，不自动套用
  const suggest = (prompt: string) => {
    if (task || methodId || !prompt.trim() || !methods.data?.length) return setSuggested(null)
    void request('/methods/suggest', MethodSuggestResponse, json('POST', { prompt })).then(list => setSuggested(list[0] ?? null), () => setSuggested(null))
  }
  const candidates = workers.filter(worker => worker.status === 'active' && (!workerId || worker.id === workerId))
  const workspaces = new Map(candidates.flatMap(worker => worker.workspaces.map(workspace => [workspace.id, workspace.label] as const)))
  if (task && !workspaces.has(task.workspaceId)) workspaces.set(task.workspaceId, task.workspaceId)
  // 工作区里的一级子文件夹 = 项目；选了项目，任务就在那个文件夹里运行
  const projects = [...new Set(candidates.flatMap(worker => worker.workspaces.filter(ws => ws.id === workspaceId).flatMap(ws => ws.projects ?? []).map(p => p.dir)))]
  if (subdir && !projects.includes(subdir)) projects.push(subdir)
  const adapters = [...new Set(candidates.flatMap(worker => worker.adapters.map(adapter => adapter.id)))]
  if (task?.adapter && !adapters.includes(task.adapter as AdapterId)) adapters.push(task.adapter as AdapterId)
  return <div className="task-fields">
    <label>指定 Worker<select name="requiredWorkerId" data-testid="task-worker" value={workerId} onChange={event => setWorkerId(event.target.value)}>
      <option value="">{task ? '保持原设置' : '自动调度'}</option>
      {workers.filter(worker => worker.status === 'active').map(worker => <option key={worker.id} value={worker.id}>{worker.displayName} · {worker.id}</option>)}
    </select></label>
    <label>工作区<select name="workspaceId" data-testid="task-workspace" value={workspaceId} required
      onChange={event => { setWorkspaceId(event.target.value); setSubdir('') }}>
      <option value="" disabled>选择工作区</option>
      {[...workspaces].map(([id, label]) => <option key={id} value={id}>{label || id}</option>)}
    </select></label>
    <label>项目<select name="subdir" data-testid="task-project" value={subdir} onChange={event => setSubdir(event.target.value)}>
      <option value="">整个工作区（根目录）</option>
      {projects.map(dir => <option key={dir} value={dir}>{dir}</option>)}
    </select></label>
    <label>CLI<select name="adapter" data-testid="task-adapter" defaultValue={task?.adapter ?? ''}>
      <option value="">{task ? '保持原设置' : '自动选择'}</option>
      {adapters.map(adapter => <option key={adapter}>{adapter}</option>)}
    </select></label>
    {!task && <label>模型<input name="model" data-testid="task-model" maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:/\[\]\-]*"
      placeholder="不填 = 用该 Agent 的默认模型" title="例如 opus、sonnet，或完整模型 ID" /></label>}
    <label>权限档位<select name="profile" data-testid="task-profile" defaultValue={task?.profile ?? defaultProfile ?? 'edit'}>
      {Profile.options.map(profile => <option key={profile}>{profile}</option>)}
    </select></label>
    {!task && <label>方法<select name="methodId" data-testid="task-method" value={methodId} onChange={event => { setMethodId(event.target.value); setSuggested(null) }}>
      <option value="">不使用</option>
      {(methods.data ?? []).map(method => <option key={method.id} value={method.id}>{method.name}</option>)}
    </select></label>}
    <label className="full">Prompt<textarea name="prompt" data-testid="task-prompt" rows={5} maxLength={32000}
      defaultValue={task?.prompt ?? ''} required placeholder="描述任务目标和验收要求" onBlur={event => suggest(event.target.value)} /></label>
    {suggested && <p className="full method-suggestion" data-testid="task-method-suggestion">要不要用『{suggested.name}』？
      <button type="button" onClick={() => { setMethodId(suggested.id); setSuggested(null) }}>用</button>
      <button type="button" onClick={() => setSuggested(null)}>不用</button></p>}
  </div>
}

export function readTaskFields(form: HTMLFormElement, task?: TaskDetail) {
  const input = new FormData(form)
  const value = (key: string) => String(input.get(key) ?? '')
  const adapter = value('adapter'), worker = value('requiredWorkerId'), methodId = value('methodId'), model = value('model').trim()
  const prompt = value('prompt'), profile = Profile.parse(value('profile')), workspaceId = value('workspaceId'), subdir = value('subdir')
  const fields = { prompt, profile, workspaceId, ...(subdir && { subdir }), ...(adapter && { adapter: AdapterId.parse(adapter) }), ...(worker && { requiredWorkerId: worker }), ...(!task && methodId && { methodId }), ...(!task && model && { model }) }
  const overrides: ApprovalOverrides = {
    ...(prompt !== task?.prompt && { prompt }), ...(profile !== task?.profile && { profile }),
    ...(workspaceId !== task?.workspaceId && { workspaceId }),
    ...(subdir && subdir !== (task?.subdir ?? '') && { subdir }),
    ...(fields.adapter && fields.adapter !== task?.adapter && { adapter: fields.adapter }),
    ...(fields.requiredWorkerId && { requiredWorkerId: fields.requiredWorkerId }),
  }
  return { fields, overrides }
}

