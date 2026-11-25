import type { TaskStatus } from '@agent-hub/protocol'

export const lanes: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: 'approval', label: '待审批', statuses: ['awaiting_approval'] },
  { id: 'queue', label: '排队中', statuses: ['queued', 'dispatching'] },
  { id: 'running', label: '执行中', statuses: ['running', 'cancelling'] },
  { id: 'input', label: '待补充输入', statuses: ['awaiting_input'] },
  { id: 'complete', label: '已完成', statuses: ['succeeded'] },
  { id: 'failed', label: '异常/终止', statuses: ['failed', 'timed_out', 'cancelled', 'rejected'] },
]

export const statusLabels: Record<TaskStatus, string> = {
  awaiting_approval: '待审批', queued: '排队中', dispatching: '派发中', running: '执行中', cancelling: '取消中',
  awaiting_input: '待补充输入', succeeded: '成功', failed: '失败', timed_out: '超时', cancelled: '已取消', rejected: '已驳回',
}
export const sourceLabels = { dashboard: '面板', api: 'API', feishu: '飞书' }
export const formatTime = (time: number) => new Date(time).toLocaleString('zh-CN', { hour12: false })
export function duration(ms: number | null) {
  if (ms === null) return '—'
  const seconds = Math.max(0, ms / 1000)
  if (seconds < 60) return seconds.toFixed(1) + 's'
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? minutes + 'm ' + Math.floor(seconds % 60) + 's' : Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm'
}
export const bytes = (n: number) => n < 1024 ? n + ' B' : n < 1024 ** 2 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1024 ** 2).toFixed(1) + ' MiB'

