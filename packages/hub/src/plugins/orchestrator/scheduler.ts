import { AdapterId, Profile } from '@agent-hub/protocol'
import type { WorkerView } from '@agent-hub/protocol'
import type { RunRow, TaskRow } from '../../services/store.js'

export function selectWorker(task: TaskRow, workers: WorkerView[], active: RunRow[], order: AdapterId[],
  recentRefusal: (id: string) => boolean, lastDispatch: (id: string) => number) {
  const candidates = workers.filter(worker => worker.status === 'active' && worker.connection === 'online' && !worker.drain &&
    (!task.requiredWorkerId || task.requiredWorkerId === worker.id))
  const prefs = task.adapter ? [AdapterId.parse(task.adapter)] : [...(task.adapterPrefsJson ?? []), ...order]
  if (!candidates.length) return { hint: 'NO_ONLINE_WORKER' }
  if (task.handoffFromRunId && !candidates.some(worker => worker.protocolCapabilities?.includes('blackboard.v1'))) return { hint: 'HARNESS_UNSUPPORTED' }
  let adapterAvailable = false, workspaceAvailable = false, profileAvailable = false
  const eligible = []
  for (const worker of candidates) {
    if (task.handoffFromRunId && !worker.protocolCapabilities?.includes('blackboard.v1')) continue
    const readyAdapters = prefs.filter(id => worker.adapters.some(item => item.id === id && item.status === 'ready')) as AdapterId[]
    if (!readyAdapters.length) continue
    adapterAvailable = true
    const workspace = worker.workspaces.find(item => item.id === task.workspaceId)
    const adapter = workspace ? readyAdapters.find(id => workspace.allowedAdapters.includes(id)) : undefined
    if (!workspace || !adapter) continue
    workspaceAvailable = true
    if (Profile.options.indexOf(task.profile) > Profile.options.indexOf(workspace.maxProfile)) continue
    profileAvailable = true
    const runs = active.filter(run => run.workerId === worker.id)
    const slots = runs.length
    if (recentRefusal(worker.id) || slots >= worker.maxConcurrency) continue
    const same = runs.filter(run => run.workspaceId === workspace.id)
    if (task.profile === 'readonly' ? same.filter(run => run.profile === 'readonly').length >= workspace.maxConcurrent :
      same.some(run => run.profile !== 'readonly')) continue
    eligible.push({ worker, adapter, score: slots / worker.maxConcurrency })
  }
  eligible.sort((a, b) => a.score - b.score ||
    Number(b.worker.id === task.preferredWorkerId) - Number(a.worker.id === task.preferredWorkerId) ||
    lastDispatch(a.worker.id) - lastDispatch(b.worker.id) || a.worker.id.localeCompare(b.worker.id))
  const chosen = eligible[0]
  return chosen ? { chosen } : { hint: !adapterAvailable ? 'NO_READY_ADAPTER' : !workspaceAvailable ? 'WORKSPACE_UNAVAILABLE'
    : !profileAvailable ? 'PROFILE_NOT_ALLOWED' : 'NO_AVAILABLE_SLOT' }
}
