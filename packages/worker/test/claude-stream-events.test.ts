import { expect, it } from 'vitest'
import { claudeCodeAdapter } from '../src/adapters/claude-code.js'

const exitOk = { code: 0, signal: null, timedOut: false, cancelled: false }
const json = (value: unknown) => JSON.stringify(value)

it('keeps the real answer when a newer Claude CLI floods the stream with heartbeat and stats events', () => {
  const parser = claudeCodeAdapter.createParser()
  parser.onStdout(json({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [] }))
  // 实际 #17：73 行 thinking_tokens、10 行 rate_limit_event、tool_progress、task_* 通知
  for (let i = 0; i < 80; i++) expect(parser.onStdout(json({ type: 'system', subtype: 'thinking_tokens', tokens: i, session_id: 's1' }))).toEqual([])
  for (let i = 0; i < 10; i++) expect(parser.onStdout(json({ type: 'rate_limit_event', rate_limit_info: {} }))).toEqual([])
  parser.onStdout(json({ type: 'tool_progress', tool_use_id: 't', elapsed_time_seconds: 30, heartbeat: true }))
  parser.onStdout(json({ type: 'system', subtype: 'task_notification', status: 'completed' }))
  parser.onStdout(json({ type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text: '审查完成' }] } }))
  parser.onStdout(json({ type: 'result', subtype: 'success', result: '## 结论\n审查完成，发现 3 个问题。', is_error: false, session_id: 's1',
    usage: { input_tokens: 1, output_tokens: 2 } }))
  const outcome = parser.finish(exitOk)
  expect(outcome).toMatchObject({ status: 'succeeded', summary: '## 结论\n审查完成，发现 3 个问题。' })
  expect(outcome.errorMessage).toBeUndefined()
})

it('still falls back to raw output when no line of a JSON stream is understood', () => {
  const parser = claudeCodeAdapter.createParser()
  for (let i = 0; i < 5; i++) parser.onStdout(json({ kind: 'brand-new-format', text: 'line ' + i }))
  const outcome = parser.finish(exitOk)
  expect(outcome.errorMessage).toContain('输出格式无法识别')
  expect(outcome.summary).toContain('brand-new-format')
})

it('reports subscription quota windows once per change', () => {
  const parser = claudeCodeAdapter.createParser()
  const event = (five: number) => json({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour',
    unifiedWindows: { five_hour: { utilization: five, resetsAt: 1795718400, status: 'allowed' }, seven_day: { utilization: 0.36, resetsAt: 1796108400, status: 'allowed' } } } })
  expect(parser.onStdout(event(0.22))).toEqual([{ kind: 'agent', event: { type: 'quota', windows: [
    { name: 'five_hour', utilization: 0.22, resetsAt: 1795718400000, status: 'allowed' },
    { name: 'seven_day', utilization: 0.36, resetsAt: 1796108400000, status: 'allowed' }] } }])
  expect(parser.onStdout(event(0.22))).toEqual([])
  expect(parser.onStdout(event(0.23))).toHaveLength(1)
})
