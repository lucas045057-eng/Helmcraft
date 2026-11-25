import { Fragment, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { RunHarnessView, RunView, TaskDetail, VerificationState } from '@agent-hub/protocol'
import { errorText, handoffTask } from '../api.js'

const labels = { pending: '等待验证', running: '验证中', passed: '验证通过', failed: '验证失败', skipped: '已跳过验证', unverified: '未验证' }
export function VerificationBadge({ state }: { state: VerificationState }) {
  return <span className="pill" data-testid="verification-badge" data-state={state}>{labels[state]}</span>
}
export function VerificationPanel({ verification, tamper, allowFix, task, run, open, switchCli }: {
  verification: NonNullable<RunHarnessView['verification']>; tamper: RunHarnessView['tamper']; allowFix: boolean
  task: TaskDetail; run: RunView; open(id: string): void; switchCli(): void
}) {
  const request = useRef({ version: -1, key: '' })
  const fix = useMutation({ mutationFn: () => {
    if (request.current.version !== task.version) request.current = { version: task.version, key: crypto.randomUUID() }
    return handoffTask(task.id, { intent: 'fix', fromRunId: run.id, expectedVersion: task.version }, request.current.key)
  }, onSuccess: child => open(child.id) })
  const { outcome } = verification
  return <section data-testid="verification-panel" aria-label="工作区验证">
    <h3>工作区验证 <VerificationBadge state={verification.state} /></h3>
    {outcome?.reason && <p>{outcome.reason}</p>}
    {tamper && <details open><summary>TAMPER_RISK · {tamper.total} 个路径</summary>
      <ul>{tamper.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}
    {verification.attempts.map(a => <table key={a.attempt}><caption>第 {a.attempt} 次验证</caption>
      <thead><tr><th>命令</th><th>状态</th><th>退出码</th><th>耗时</th></tr></thead>
      <tbody>{a.commands.map((id, i) => {
        const result = a.results[i]
        return <Fragment key={i}><tr><td>{id}</td><td>{result?.status ?? '进行中'}</td><td>{result?.exitCode ?? '—'}</td>
          <td>{result ? result.durationMs + ' ms' : '—'}</td></tr>
          {result?.tail && <tr><td colSpan={4}><pre>{result.tail}</pre></td></tr>}</Fragment>
      })}</tbody></table>)}
    {outcome?.autoFix && <p>自动修复 {outcome.autoFix.attempts} 次 · {outcome.autoFix.stoppedBy}</p>}
    {allowFix && verification.state === 'failed' && <div className="action-list">
      <button type="button" disabled={fix.isPending} data-testid="verification-fix-same" onClick={() => fix.mutate()}>带报错修复</button>
      <button type="button" disabled={fix.isPending} data-testid="verification-fix-switch" onClick={switchCli}>换 CLI 修复</button>
    </div>}
    {fix.error && <p role="alert">{errorText(fix.error)}</p>}
  </section>
}
