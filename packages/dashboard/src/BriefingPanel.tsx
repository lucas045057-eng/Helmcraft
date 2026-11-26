import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectOverview } from '@agent-hub/protocol'
import { dispatchBriefingAction, errorText, listBriefings, runBriefing } from './api.js'

const healthLabels = {
  healthy: ['状态健康', 'online'],
  attention: ['有待办/关注项', 'suspect'],
  warning: ['需要处理', 'offline'],
} as const

export function BriefingPanel({ project, open }: { project: ProjectOverview; open: (id: string) => void }) {
  const cache = useQueryClient()
  const subdir = project.subdir ?? ''
  const query = useQuery({
    queryKey: ['briefings', project.workerId, project.workspaceId, subdir],
    queryFn: ({ signal }) => listBriefings({ workerId: project.workerId, workspaceId: project.workspaceId, subdir, limit: '5' }, signal),
  })
  const trigger = useMutation({
    mutationFn: () => runBriefing({ workerId: project.workerId, workspaceId: project.workspaceId, subdir }),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['briefings', project.workerId, project.workspaceId, subdir] }),
  })
  const dispatch = useMutation({
    mutationFn: ({ briefingId, index }: { briefingId: string; index: number }) => dispatchBriefingAction(briefingId, index),
    onSuccess: task => {
      void cache.invalidateQueries({ queryKey: ['task-history'] })
      open(task.id)
    },
  })

  const latest = query.data?.[0]
  const [label, cls] = latest ? healthLabels[latest.health] : ['未巡检', '']

  return <div className="briefing-panel" data-testid="briefing-panel">
    <div className="autopilot-toolbar">
      <div>
        <h4>📋 项目管家巡检与待拍板 {latest && <span className={'pill ' + cls}>{label}</span>}</h4>
        <small className="muted">自动核对 .board/ 记忆漂移、技术债、测试验证健康度，并生成可直接派发的下一步。</small>
      </div>
      <button type="button" data-testid="briefing-run" disabled={trigger.isPending} onClick={() => trigger.mutate()}>
        {trigger.isPending ? '巡检中…' : '🔍 立即巡检'}
      </button>
    </div>

    {(query.error || trigger.error || dispatch.error) &&
      <p className="error compact" role="alert">{errorText(query.error ?? trigger.error ?? dispatch.error)}</p>}

    {!latest ? <p className="empty-panel">还没有该项目巡检记录，点击「立即巡检」生成项目体检与行动建议。</p> : <>
      <p className="briefing-summary">{latest.summary}</p>
      {latest.findings.length > 0 && <ul className="briefing-findings">
        {latest.findings.map((f, i) => <li key={i}>
          <span className={'pill ' + (f.severity === 'error' ? 'offline' : f.severity === 'warning' ? 'suspect' : '')}>{f.category}</span>
          <span>{f.message}</span>
        </li>)}
      </ul>}
      {latest.actions.length > 0 && <div className="briefing-actions">
        <h5>推荐下一步</h5>
        {latest.actions.map(action => <div key={action.index} className="briefing-action-row">
          <div>
            <strong>#{action.index} {action.title}</strong>
            <span className="muted small"> · {action.adapter ?? '自动'} · {action.profile}</span>
          </div>
          <button type="button" className={action.index === 1 ? 'primary' : ''} data-testid={'briefing-dispatch-' + action.index}
            disabled={dispatch.isPending} onClick={() => dispatch.mutate({ briefingId: latest.id, index: action.index })}>
            派发执行
          </button>
        </div>)}
      </div>}
    </>}
  </div>
}
