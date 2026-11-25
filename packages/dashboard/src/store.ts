import { create } from 'zustand'
import type { WorkspacePointerView, DashEventFrame, DashServerFrame, Overview, RunView, TaskDetail, TaskSummary, WorkerView } from '@agent-hub/protocol'

type Snapshot = Extract<DashServerFrame, { t: 'snapshot' }>
type Connection = 'connecting' | 'live' | 'offline' | 'limited'
interface State {
  pointers: Record<string, WorkspacePointerView>
  eventSeq: number
  overview: Overview | null
  workers: Record<string, WorkerView>
  tasks: Record<string, TaskSummary>
  details: Record<string, TaskDetail>
  runs: Record<string, RunView>
  connection: Connection
  clockOffset: number
  event(frame: DashEventFrame): void
  snapshot(frame: Snapshot): void
  clear(): void
}

const initial = () => ({ eventSeq: 0, pointers: {}, overview: null, workers: {}, tasks: {}, details: {}, runs: {} })
export const useDashboard = create<State>(set => ({
  ...initial(), connection: 'connecting', clockOffset: 0,
  event: frame => set(state => {
    const { eventSeq } = frame
    if (eventSeq <= state.eventSeq) return state
    switch (frame.type) {
      case 'overview.updated': return { eventSeq, overview: frame.data }
      case 'system.status': {
        const { feishu, ...hub } = frame.data
        return { eventSeq, overview: state.overview && { ...state.overview, hub, feishu } }
      }
      case 'workspace.updated': return { eventSeq, pointers: { ...state.pointers, [frame.data.workerId + '/' + frame.data.workspaceId]: frame.data } }
      case 'worker.updated': return { eventSeq, workers: { ...state.workers, [frame.data.id]: frame.data } }
      case 'worker.removed': {
        const workers = { ...state.workers }
        delete workers[frame.data.id]
        return { eventSeq, workers }
      }
      case 'task.created':
      case 'task.updated': {
        const task = frame.data
        if ((state.tasks[task.id]?.version ?? -1) > task.version) return { eventSeq }
        return { eventSeq, tasks: { ...state.tasks, [task.id]: task } }
      }
      case 'task.detail': {
        const detail = frame.data
        if (Math.max(state.tasks[detail.id]?.version ?? -1, state.details[detail.id]?.version ?? -1) > detail.version) return { eventSeq }
        return { eventSeq, details: { ...state.details, [detail.id]: detail } }
      }
      case 'run.updated': return { eventSeq, runs: { ...state.runs, [frame.data.id]: frame.data } }
    }
  }),
  snapshot: frame => set(state => {
    if (frame.eventSeq < state.eventSeq) return state
    return { eventSeq: frame.eventSeq, pointers: {}, overview: frame.overview,
      workers: Object.fromEntries(frame.workers.map(worker => [worker.id, worker])),
      tasks: Object.fromEntries(frame.activeTasks.map(task => [task.id, task])) }
  }),
  clear: () => set(initial()),
}))

