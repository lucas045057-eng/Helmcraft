import { useState } from 'react'
import { AdapterId, Profile } from '@agent-hub/protocol'
import type { ApprovalOverrides, TaskDetail, WorkerView } from '@agent-hub/protocol'

export function TaskFields({ workers, task }: { workers: WorkerView[]; task?: TaskDetail }) {
  const [workerId, setWorkerId] = useState('')
  const candidates = workers.filter(worker => worker.status === 'active' && (!workerId || worker.id === workerId))
  const workspaces = new Map(candidates.flatMap(worker => worker.workspaces.map(workspace => [workspace.id, workspace.label] as const)))
  if (task && !workspaces.has(task.workspaceId)) workspaces.set(task.workspaceId, task.workspaceId)
  const adapters = [...new Set(candidates.flatMap(worker => worker.adapters.map(adapter => adapter.id)))]
  if (task?.adapter && !adapters.includes(task.adapter as AdapterId)) adapters.push(task.adapter as AdapterId)
  return <div className="task-fields">
    <label>指定 Worker<select name="requiredWorkerId" data-testid="task-worker" value={workerId} onChange={event => setWorkerId(event.target.value)}>
      <option value="">{task ? '保持原设置' : '自动调度'}</option>
      {workers.filter(worker => worker.status === 'active').map(worker => <option key={worker.id} value={worker.id}>{worker.displayName} · {worker.id}</option>)}
    </select></label>
    <label>工作区<select name="workspaceId" data-testid="task-workspace" defaultValue={task?.workspaceId ?? ''} required>
      <option value="" disabled>选择工作区</option>
      {[...workspaces].map(([id, label]) => <option key={id} value={id}>{label || id}</option>)}
    </select></label>
    <label>CLI<select name="adapter" data-testid="task-adapter" defaultValue={task?.adapter ?? ''}>
      <option value="">{task ? '保持原设置' : '自动选择'}</option>
      {adapters.map(adapter => <option key={adapter}>{adapter}</option>)}
    </select></label>
    <label>权限档位<select name="profile" data-testid="task-profile" defaultValue={task?.profile ?? 'edit'}>
      {Profile.options.map(profile => <option key={profile}>{profile}</option>)}
    </select></label>
    <label className="full">Prompt<textarea name="prompt" data-testid="task-prompt" rows={5} maxLength={32000}
      defaultValue={task?.prompt ?? ''} required placeholder="描述任务目标和验收要求" /></label>
  </div>
}

export function readTaskFields(form: HTMLFormElement, task?: TaskDetail) {
  const input = new FormData(form)
  const value = (key: string) => String(input.get(key) ?? '')
  const adapter = value('adapter'), worker = value('requiredWorkerId')
  const prompt = value('prompt'), profile = Profile.parse(value('profile')), workspaceId = value('workspaceId')
  const fields = { prompt, profile, workspaceId, ...(adapter && { adapter: AdapterId.parse(adapter) }), ...(worker && { requiredWorkerId: worker }) }
  const overrides: ApprovalOverrides = {
    ...(prompt !== task?.prompt && { prompt }), ...(profile !== task?.profile && { profile }),
    ...(workspaceId !== task?.workspaceId && { workspaceId }),
    ...(fields.adapter && fields.adapter !== task?.adapter && { adapter: fields.adapter }),
    ...(fields.requiredWorkerId && { requiredWorkerId: fields.requiredWorkerId }),
  }
  return { fields, overrides }
}

