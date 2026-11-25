import type { CliAdapter, ParsedItem } from './types.js'
import { realCli } from './cli-probe.js'
import { agent, describe, ParserState, row, sessionId, str, structuredParser, usageFields } from './structured.js'

// Antigravity CLI (`agy`) 1.5.x print mode. The prompt goes over stdin as one stream-json user message, so it stays
// out of argv (length limits, process listings). `--print=` with an empty value is required to select print mode.
const profiles = {
  readonly: ['--mode', 'plan', '--sandbox'],
  edit: ['--mode', 'accept-edits'],
  full: ['--dangerously-skip-permissions'],
}
const editTool = /(?:write|edit|replace|create|delete|move|rename|patch)/iu
const deltaWindowMs = 500
const deltaWindowChars = 8000

function createParser() {
  const state = new ParserState()
  let pending = '', pendingSince = 0, streamed = ''
  const flush = (force: boolean): ParsedItem[] => {
    if (!pending || (!force && Date.now() - pendingSince < deltaWindowMs)) return []
    const text = pending
    pending = ''
    return state.message('assistant', text)
  }
  const withPending = (items: ParsedItem[]) => [...flush(true), ...items]
  return structuredParser(state, event => {
    switch (event.event) {
      case 'init': {
        const id = sessionId(event.conversation_id)
        const init = row(event.init)
        if (!id) return []
        const tools = Array.isArray(init?.tools) ? init.tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 200) : undefined
        return withPending([agent({ type: 'init', ...(tools && { tools }) }), ...state.session(id)])
      }
      case 'step_update': {
        const step = row(event.step_update)
        if (!step) return
        const index = typeof step.step_index === 'number' ? step.step_index : -1
        switch (step.step_type) {
          case 'agent_response': {
            const text = str(step.text_delta)
            if (text === undefined) return []
            const items = flush(pending.length + text.length > deltaWindowChars)
            if (!pending) pendingSince = Date.now()
            pending += text
            streamed = (streamed + text).slice(-20_000)
            if (step.state === 'DONE' || pending.length >= deltaWindowChars || text.includes('\n')) items.push(...flush(true))
            return items
          }
          case 'tool': {
            const name = str(step.tool_name) ?? str(row(step.tool_info)?.name)
            if (!name) return []
            const id = 'step-' + index
            const parameters = row(row(step.tool_info)?.parameters)
            if (step.state === 'ACTIVE') {
              const path = str(parameters?.Path) ?? str(parameters?.path) ?? str(parameters?.TargetFile)
              if (path && editTool.test(name)) state.file(path)
              return withPending([agent({ type: 'tool_use', id, name: name.slice(0, 128), summary: describe(parameters ?? {}) })])
            }
            if (step.state === 'DONE' || step.state === 'ERROR' || step.state === 'FAILED' || step.state === 'CANCELED') {
              return withPending([agent({ type: 'tool_result', id, ok: step.state === 'DONE',
                summary: describe(step.error ?? step.state, 2000) })])
            }
            return []
          }
          default:
            return []
        }
      }
      case 'result': {
        const result = row(event.result)
        if (!result) return
        const id = sessionId(result.conversation_id)
        const items = withPending(id ? state.session(id) : [])
        // headless 模式下无法弹窗授权的操作会被自动拒绝（如 edit 档里的终端命令），response 可能因此为空
        const denied = Array.isArray(result.denied_actions)
          ? [...new Set(result.denied_actions.map(row).map(action => str(action?.display_name) ?? str(action?.action)).filter(Boolean))] : []
        const deniedNote = denied.length ? 'Antigravity 自动拒绝了需要授权的操作：' + denied.join('、') + '（headless 模式无法弹窗授权；需要时改用 full 档）' : ''
        const response = str(result.response)?.trim() ? str(result.response)! : streamed
        state.summary = [response.trim(), deniedNote].filter(Boolean).join('\n\n').slice(0, 20_000)
        if (deniedNote) items.push(...state.error(deniedNote, false))
        const usage = row(result.usage)
        if (usage) items.push(...state.reportUsage(usageFields(usage.input_tokens, usage.output_tokens, usage.cache_read_tokens)))
        if (result.status !== 'SUCCESS') {
          items.push(...state.error(str(result.error) || 'Antigravity reported ' + (str(result.status) ?? 'an error'), true))
        }
        return items
      }
      case 'error': {
        const message = str(event.message) ?? str(row(event.error)?.message) ?? str(event.error)
        return message === undefined ? undefined : withPending(state.error(message, false))
      }
    }
  }, flush)
}

export const antigravityAdapter: CliAdapter = {
  ...realCli('antigravity', 'agy'),
  id: 'antigravity', displayName: 'Antigravity',
  buildInvocation({ exe, prompt, profile, adapterConfig, extraArgs, model, resumeSessionId }) {
    return { command: exe.command, env: {},
      stdin: JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n',
      args: [...exe.prefixArgs, '--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
        ...(resumeSessionId ? ['--conversation', resumeSessionId] : []), ...(model ? ['--model', model] : []),
        ...(adapterConfig.argsOverride[profile] ?? profiles[profile]), ...extraArgs] }
  },
  createParser,
}
