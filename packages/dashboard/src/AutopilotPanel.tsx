import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PersonalProjectView } from '@agent-hub/protocol'
import type { AutopilotPreflightResponse, PersonalReports, ProjectOverview } from '@agent-hub/protocol'
import { emptyResponse, errorText, json, personalReports, preflightProject, request, startAutopilot } from './api.js'

const phaseOrder = [
  ['planning', '规划'], ['plan_consulting', '顾问复核'], ['implementing', '编码实现'],
  ['verifying', '自动测试'], ['reviewing', '独立审查'], ['committing', '交付提交'], ['done', '验收完成'],
] as const

const phaseLabel: Record<string, string> = {
  planning: '生成计划', plan_ready: '等待顾问', plan_consulting: '顾问评估',
  implementation_ready: '准备实现', implementing: '编码实现', verifying: '自动验证',
  review_ready: '等待审查', reviewing: '独立审查', repair_ready: '准备修复',
  debug_ready: '等待诊断', diagnosing: '定位故障', delivery_ready: '准备提交',
  committing: '提交变更', push_ready: '准备推送', pushing: '推送远端',
  core_ready: '最终验证', verifying_final: '终检中', final_ready: '最终评估',
  final_consulting: '顾问终审', acceptance_ready: '收尾清理', done: '已完成', blocked: '已阻塞', stopped: '已停止',
}

function downloadMd(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function AutopilotPanel({ project, open }: { project: ProjectOverview; open: (id: string) => void }) {
  const cache = useQueryClient()
  const [inputMode, setInputMode] = useState<'prompt' | 'doc'>('prompt')
  const [inlinePrompt, setInlinePrompt] = useState('')
  const [sourcesText, setSourcesText] = useState('PRD.md')
  const [autoCommit, setAutoCommit] = useState(true)
  const [autoPush, setAutoPush] = useState(false)
  const [preflightResult, setPreflightResult] = useState<AutopilotPreflightResponse>()
  const [reportTab, setReportTab] = useState<keyof PersonalReports>('ACCEPTANCE.md')
  const [reports, setReports] = useState<{ id: string; files: PersonalReports }>()

  const list = useQuery({
    queryKey: ['personal-projects'],
    queryFn: ({ signal }) => request('/personal/projects', PersonalProjectView.array(), { signal }),
    refetchInterval: 2500,
  })
  const matching = (list.data ?? []).filter(p =>
    (!p.workerId || p.workerId === project.workerId) &&
    (p.workspaceId === undefined || p.workspaceId === project.workspaceId) &&
    (project.subdir ? p.subdir === project.subdir : !p.subdir),
  )
  const active = matching[0]

  const runPreflight = useMutation({
    mutationFn: () => preflightProject({
      workerId: project.workerId,
      workspaceId: project.workspaceId,
      ...(project.subdir && { subdir: project.subdir }),
      mode: 'flexible',
      autoCommit,
      autoPush: autoCommit && autoPush,
    }),
    onSuccess: data => setPreflightResult(data),
  })

  const start = useMutation({
    mutationFn: () => startAutopilot({
      workerId: project.workerId,
      workspaceId: project.workspaceId,
      ...(project.subdir && { subdir: project.subdir }),
      ...(inputMode === 'prompt'
        ? { inlinePrompt: inlinePrompt.trim() }
        : { sources: sourcesText.split(/[,，\n]/u).map(s => s.trim()).filter(Boolean) }),
      autoCommit,
      autoPush: autoCommit && autoPush,
      boardSync: true,
    }),
    onSuccess: () => {
      setInlinePrompt('')
      void cache.invalidateQueries({ queryKey: ['personal-projects'] })
      void cache.invalidateQueries({ queryKey: ['task-history'] })
    },
  })

  const control = useMutation({
    mutationFn: (input: { id: string; action: 'pause' | 'resume' | 'stop' }) =>
      request('/personal/projects/' + encodeURIComponent(input.id) + '/' + input.action, emptyResponse, json('POST')),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ['personal-projects'] }),
  })

  const loadReports = useMutation({
    mutationFn: async (id: string) => ({ id, files: await personalReports(id) }),
    onSuccess: res => setReports(res),
  })

  const closed = active && ['done', 'stopped'].includes(active.phase)
  const canSubmit = project.workerOnline && !start.isPending && (inputMode === 'prompt' ? inlinePrompt.trim().length > 0 : sourcesText.trim().length > 0)

  return <div className="autopilot-panel" data-testid="autopilot-panel">
    <div className="autopilot-toolbar">
      <div>
        <h4>🚀 一句话启动三角色自动交付</h4>
        <small className="muted">自动在线预检 Git 与执行器，按「规划 → 顾问 → 编码 → 测试 → 审查 → 交付」无人值守推进。</small>
      </div>
      <button type="button" data-testid="autopilot-preflight" disabled={!project.workerOnline || runPreflight.isPending} onClick={() => runPreflight.mutate()}>
        {runPreflight.isPending ? '预检中…' : '在线预检环境'}
      </button>
    </div>

    {preflightResult && <div className={'preflight-result ' + (preflightResult.ok ? 'online' : 'offline')} data-testid="preflight-status">
      {preflightResult.ok && preflightResult.binding
        ? <span>✅ 预检通过 · 分支 <code className="mono">{preflightResult.binding.branch}</code> · 主力 <code>{preflightResult.binding.adapters?.main ?? 'codex'}</code> / 审查 <code>{preflightResult.binding.adapters?.reviewer ?? 'claude-code'}</code> · 检查 {preflightResult.noChecks ? '无额外验证命令' : preflightResult.checks.join('、')}</span>
        : <span>❌ 预检未通过：{preflightResult.error ?? '未知原因'}</span>}
    </div>}

    <form className="autopilot-form" onSubmit={e => { e.preventDefault(); start.mutate() }}>
      <div className="segmented">
        <button type="button" aria-pressed={inputMode === 'prompt'} onClick={() => setInputMode('prompt')}>一句话目标</button>
        <button type="button" aria-pressed={inputMode === 'doc'} onClick={() => setInputMode('doc')}>需求 Markdown</button>
      </div>
      {inputMode === 'prompt'
        ? <textarea data-testid="autopilot-prompt" rows={3} value={inlinePrompt} onChange={e => setInlinePrompt(e.target.value)}
            placeholder={`描述 ${project.label} 本次要自动完成的目标，如：完善导出表格功能并补齐单测…`} maxLength={16000} />
        : <input data-testid="autopilot-sources" value={sourcesText} onChange={e => setSourcesText(e.target.value)} placeholder="PRD.md" />}
      <div className="autopilot-options">
        <label className="checkbox-inline"><input type="checkbox" checked={autoCommit} onChange={e => { const next = e.target.checked; setAutoCommit(next); if (!next) setAutoPush(false) }} /> 验收通过后自动 Git Commit</label>
        <label className="checkbox-inline"><input type="checkbox" checked={autoPush} disabled={!autoCommit} onChange={e => setAutoPush(e.target.checked)} /> 自动 Git Push 到远端</label>
        <button type="submit" className="primary" data-testid="autopilot-start" disabled={!canSubmit}>
          {start.isPending ? '正在启动…' : '🚀 启动自动交付'}
        </button>
      </div>
    </form>

    {(start.error || runPreflight.error || control.error || loadReports.error) &&
      <p className="error compact" role="alert">{errorText(start.error ?? runPreflight.error ?? control.error ?? loadReports.error)}</p>}

    {active && <div className="autopilot-active" data-testid="autopilot-status">
      <div className="section-heading">
        <div>
          <strong className="mono">{active.id}</strong> · <span className="pill">{phaseLabel[active.phase] ?? active.phase}</span>
          {active.currentItem && <span className="pill">当前子项 {active.currentItem}</span>}
        </div>
        <div className="action-list">
          <button type="button" onClick={() => open(active.taskId)}>打开任务</button>
          {!closed && ['running', 'paused'].includes(active.control) && <>
            {active.phase !== 'blocked' && <button type="button" disabled={control.isPending}
              onClick={() => control.mutate({ id: active.id, action: active.control === 'paused' ? 'resume' : 'pause' })}>
              {active.control === 'paused' ? '继续派发' : '暂停'}</button>}
            <button type="button" className="danger" disabled={control.isPending}
              onClick={() => control.mutate({ id: active.id, action: 'stop' })}>停止</button>
          </>}
          <button type="button" disabled={loadReports.isPending} onClick={() => loadReports.mutate(active.id)}>预览验收报告</button>
        </div>
      </div>

      <div className="autopilot-stepper">
        {phaseOrder.map(([key, title]) => <span key={key} className={'pill ' + (active.phase === key ? 'online' : '')}>{title}</span>)}
      </div>
      {active.reason && <p className="warning compact">阻塞原因：{active.reason}</p>}

      {!!active.items?.length && <div className="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>交付项</th><th>状态</th><th>审查轮次</th><th>Commit</th></tr></thead>
          <tbody>{active.items.map(item => <tr key={item.id}>
            <td className="mono">{item.id}</td>
            <td>{item.title ?? '—'}</td>
            <td><span className={'pill ' + (item.status === 'delivered' ? 'online' : item.status === 'failed' ? 'offline' : '')}>{item.status}</span></td>
            <td>{item.reviewRounds}</td>
            <td className="mono">{item.commitSha ? item.commitSha.slice(0, 8) : '—'}</td>
          </tr>)}</tbody>
        </table>
      </div>}

      {reports?.id === active.id && <div className="autopilot-reports" data-testid="autopilot-reports">
        <div className="section-heading">
          <div className="segmented">
            {(['ACCEPTANCE.md', 'ADVISOR_FINAL.md', 'UNRESOLVED.md'] as const).map(name =>
              <button key={name} type="button" aria-pressed={reportTab === name} onClick={() => setReportTab(name)}>{name}</button>)}
          </div>
          <button type="button" onClick={() => downloadMd(reportTab, reports.files[reportTab])}>下载 {reportTab}</button>
        </div>
        <pre>{reports.files[reportTab]}</pre>
      </div>}
    </div>}
  </div>
}
