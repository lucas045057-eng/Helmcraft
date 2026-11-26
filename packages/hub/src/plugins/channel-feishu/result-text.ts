import type { TaskDetailView } from '@agent-hub/protocol'

const limit = 8000
const labels = { failed: '执行失败', timed_out: '执行超时', succeeded: '已完成', cancelled: '已取消', rejected: '已驳回' }

export function resultMessages(task: TaskDetailView, clean: (value: string) => string) {
  const status = task.status
  if (!(status in labels)) return []
  const heading = '#' + task.taskNo + ' · ' + labels[status as keyof typeof labels]
  const summary = clean(task.resultSummary ?? '')
  const messages = summary.trim() ? splitResult(summary) : []
  if (status === 'failed' || status === 'timed_out') {
    const reason = task.runs[0]?.errorMessage || task.errorCode || task.resultSummary
    messages.push(reason ? heading + '\n' + clean(reason).slice(0, 600) : heading)
  }
  return messages.length ? messages : [heading]
}

export function splitResult(text: string): string[] {
  if (text.length <= limit) return [text]
  // Even if every chunk contained a single character, this header would fit.
  const capacity = limit - (String(text.length).length * 2 + 2)
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + capacity, text.length)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start) end = newline + 1
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts.map((part, i) => (i + 1) + '/' + parts.length + '\n' + part)
}
