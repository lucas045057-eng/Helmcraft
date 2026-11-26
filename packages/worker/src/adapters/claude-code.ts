import type { CliAdapter, ParsedItem } from './types.js'
import { realCli } from './cli-probe.js'
import { agent, describe, ParserState, row, sessionId, str, structuredParser, usageFields } from './structured.js'
import type { Row } from './structured.js'

const profiles = {
  readonly: ['--permission-mode', 'plan', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit'],
  edit: ['--permission-mode', 'acceptEdits'],
  full: ['--permission-mode', 'bypassPermissions'],
}
const editTools = new Set(['Edit', 'Write', 'MultiEdit'])

function contentEvents(state: ParserState, message: Row, assistant: boolean): ParsedItem[] | undefined {
  if (!Array.isArray(message.content)) return
  const blocks = message.content.map(row)
  if (blocks.some(block => !block || !validBlock(block, assistant))) return
  const events: ParsedItem[] = []
  const texts: string[] = []
  for (const block of blocks) {
    if (!block) continue
    switch (block.type) {
      case 'text':
        if (assistant && typeof block.text === 'string') {
          texts.push(block.text)
          events.push(...state.message('assistant', block.text))
        }
        break
      case 'thinking':
        if (typeof block.thinking === 'string') events.push(agent({ type: 'thinking', text: block.thinking.slice(0, 8000) }))
        break
      case 'tool_use': {
        const id = str(block.id), name = str(block.name)
        if (!id || !name) break
        const path = str(row(block.input)?.file_path)
        if (path && editTools.has(name)) {
          state.file(path)
        }
        events.push(agent({ type: 'tool_use', id, name: name.slice(0, 128), summary: describe(block.input) }))
        break
      }
      case 'tool_result': {
        const id = str(block.tool_use_id)
        if (id) events.push(agent({ type: 'tool_result', id, ok: block.is_error !== true, summary: describe(block.content, 2000) }))
        break
      }
    }
  }
  if (texts.length) state.summary = texts.join('\n')
  return events
}

function validBlock(block: Row, assistant: boolean) {
  switch (block.type) {
    case 'text': return typeof block.text === 'string'
    case 'thinking': return assistant && typeof block.thinking === 'string'
    case 'tool_use': return assistant && !!str(block.id) && !!str(block.name) && !!row(block.input)
    case 'tool_result': return !assistant && !!str(block.tool_use_id) && (typeof block.content === 'string' || Array.isArray(block.content))
    default: return false
  }
}

/** rate_limit_info.unifiedWindows → [{ name, utilization, resetsAt(ms) }]；旧格式只有单个窗口时退回 rateLimitType。 */
export function quotaWindows(info: Row | undefined) {
  if (!info) return []
  const windows = row(info.unifiedWindows)
  const entries = windows ? Object.entries(windows) : str(info.rateLimitType) ? [[str(info.rateLimitType)!, info] as [string, unknown]] : []
  return entries.flatMap(([name, value]) => {
    const item = row(value), utilization = item?.utilization
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 10 || !/^[\w-]{1,32}$/u.test(name)) return []
    const resets = item?.resetsAt
    const status = str(item?.status)
    return [{ name, utilization: Math.round(utilization * 1000) / 1000,
      resetsAt: typeof resets === 'number' && Number.isFinite(resets) ? Math.round(resets < 1e12 ? resets * 1000 : resets) : null,
      ...(status && status.length <= 32 && { status }) }]
  }).slice(0, 8)
}

function createParser() {
  const state = new ParserState()
  let lastQuota = ''
  return structuredParser(state, event => {
    switch (event.type) {
      // 订阅额度：只在百分比或重置时间变化时上报，供面板「模型与用量」显示
      case 'rate_limit_event': {
        const windows = quotaWindows(row(event.rate_limit_info))
        const key = JSON.stringify(windows)
        if (!windows.length || key === lastQuota) return []
        lastQuota = key
        return [agent({ type: 'quota', windows })]
      }
      // 新版 CLI 的心跳与统计事件：不展示，也不算作格式异常
      case 'tool_progress': case 'stream_event': return []
      case 'system': {
        const id = sessionId(event.session_id)
        if (event.subtype !== 'init') return typeof event.subtype === 'string' ? [] : undefined
        if (!id) return
        const model = str(event.model)
        const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 200) : undefined
        return [agent({ type: 'init', ...(model && { model }), ...(tools && { tools }) }), ...state.session(id)]
      }
      case 'assistant':
      case 'user': {
        const message = row(event.message)
        return message && contentEvents(state, message, event.type === 'assistant')
      }
      case 'result': {
        const result = str(event.result), id = sessionId(event.session_id), usage = row(event.usage)
        if (result === undefined && !id && !usage && typeof event.is_error !== 'boolean') return
        const items = id ? state.session(id) : []
        if (result !== undefined) state.summary = result
        items.push(...state.reportUsage(usageFields(usage?.input_tokens, usage?.output_tokens,
          usage?.cache_read_input_tokens, event.total_cost_usd)))
        if (event.is_error === true || str(event.subtype)?.startsWith('error_')) {
          items.push(...state.error(result || describe(event.errors, 2000) || str(event.subtype) || 'Claude Code reported an error', true))
        }
        return items
      }
    }
  })
}

export const claudeCodeAdapter: CliAdapter = {
  ...realCli('claude-code', 'claude', [], ['auth', 'status', '--json']),
  id: 'claude-code', displayName: 'Claude Code',
  buildInvocation({ exe, prompt, profile, adapterConfig, extraArgs, model, resumeSessionId }) {
    return { command: exe.command, stdin: prompt, env: {},
      args: [...exe.prefixArgs, '-p', '--output-format', 'stream-json', '--verbose',
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []), ...(model ? ['--model', model] : []),
        ...(adapterConfig.argsOverride[profile] ?? profiles[profile]), ...extraArgs] }
  },
  createParser,
}
