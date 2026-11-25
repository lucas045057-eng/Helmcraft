import { useMutation } from '@tanstack/react-query'
import type { RunView, WorkspacePointerView } from '@agent-hub/protocol'
import { acceptWorkspaceRun, errorText } from '../api.js'
import { useDashboard } from '../store.js'

export function WorkspacePointer({ pointer, run, canAccept, refresh }: { pointer: WorkspacePointerView | null; run: RunView; canAccept: boolean; refresh(): void }) {
  const live = useDashboard(s => s.pointers[run.workerId + '/' + run.workspaceId])
  const current = live && (!pointer || live.updatedAt >= pointer.updatedAt) ? live : pointer
  const seq = run.harness?.workspaceSeq ?? (current?.lastAttempt?.runId === run.id ? current.lastAttempt.seq : undefined)
  const newer = seq === undefined ? current?.lastAccepted?.runId === pointer?.lastAccepted?.runId
    : seq > (current?.lastAccepted?.seq ?? 0)
  const accept = useMutation({ mutationFn: () => acceptWorkspaceRun(run.workerId, run.workspaceId,
    { runId: run.id, expectedAcceptedRunId: current?.lastAccepted?.runId ?? null }), onSettled: refresh })
  return <section data-testid="pointer-indicator"><h3>工作区指针</h3>
    {(['lastAccepted', 'lastAttempt'] as const).map(key => {
      const ref = current?.[key]
      return <p key={key}>{key} {ref ? '#' + ref.taskNo + ' ' + ref.adapter + ' · ' + ref.runStatus : '—'}</p>
    })}
    {canAccept && newer && current?.lastAccepted?.runId !== run.id &&
      <button data-testid="pointer-accept" disabled={accept.isPending} onClick={() => {
        if (window.confirm('采纳此 Run 为工作区 lastAccepted？')) accept.mutate()
      }}>采纳为 lastAccepted</button>}
    {accept.error && <p role="alert">{errorText(accept.error)}</p>}
  </section>
}
