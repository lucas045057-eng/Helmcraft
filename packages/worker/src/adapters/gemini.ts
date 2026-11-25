import type { CliAdapter, ParsedItem } from './types.js'
import { realCli } from './cli-probe.js'
import { agent, describe, errorText, ParserState, row, sessionId, str, structuredParser, usageFields } from './structured.js'

const approval = { readonly: 'default', edit: 'auto_edit', full: 'yolo' }
const deltaWindowMs = 500
const deltaWindowChars = 8000

function createParser() {
  const state = new ParserState()
  let pending = '', pendingSince = 0
  const flush = (force: boolean): ParsedItem[] => {
    if (!pending || (!force && Date.now() - pendingSince < deltaWindowMs)) return []
    const text = pending
    pending = ''
    return state.message('assistant', text)
  }
  const append = (text: string) => { state.summary = (state.summary + text).slice(0, 20_000) }
  return structuredParser(state, event => {
    const text = str(event.content)
    if (event.type === 'message' && event.role === 'assistant' && event.delta === true && text !== undefined) {
      const events = flush(pending.length + text.length > deltaWindowChars)
      if (!pending) pendingSince = Date.now()
      pending += text
      append(text)
      if (pending.length >= deltaWindowChars || text.includes('\n')) events.push(...flush(true))
      return events
    }
    const withPending = (items: ParsedItem[]) => [...flush(true), ...items]
    switch (event.type) {
      case 'init': {
        const id = sessionId(event.session_id), model = str(event.model)
        if (!id) return
        return withPending([agent({ type: 'init', ...(model && { model }) }), ...state.session(id)])
      }
      case 'message': {
        if ((event.role !== 'assistant' && event.role !== 'user') || text === undefined) return
        if (event.role === 'assistant') append(text)
        return withPending(state.message(event.role, text))
      }
      case 'tool_use': {
        const id = str(event.tool_id), name = str(event.tool_name)
        if (!id || !name || !row(event.parameters)) return
        return withPending([agent({ type: 'tool_use', id, name: name.slice(0, 128), summary: describe(event.parameters) })])
      }
      case 'tool_result': {
        const id = str(event.tool_id)
        if (!id || (event.status !== 'success' && event.status !== 'error')) return
        return withPending([agent({ type: 'tool_result', id, ok: event.status === 'success',
          summary: describe(event.output ?? event.error, 2000) })])
      }
      case 'error': {
        const message = str(event.message)
        return message === undefined ? undefined : withPending(state.error(message, false))
      }
      case 'result': {
        if (event.status === 'error') {
          return withPending(state.error(errorText(event.error) ?? 'Gemini reported an error', true))
        }
        const stats = row(event.stats)
        if (event.status !== 'success' || !stats) return
        return withPending(state.reportUsage(usageFields(stats.input_tokens ?? stats.input, stats.output_tokens, stats.cached)))
      }
    }
  }, flush)
}

export const geminiAdapter: CliAdapter = {
  ...realCli('gemini', 'gemini'),
  id: 'gemini', displayName: 'Gemini',
  buildInvocation({ exe, prompt, profile, adapterConfig, extraArgs, model, resumeSessionId }) {
    const options = adapterConfig.argsOverride[profile] ?? ['--approval-mode', approval[profile]]
    const customFormat = options.some(arg => arg === '--output-format' || arg === '-o' || arg.startsWith('--output-format='))
    return { command: exe.command, stdin: prompt, env: {},
      args: [...exe.prefixArgs, ...(customFormat ? [] : ['--output-format', 'stream-json']),
        ...(model ? ['--model', model] : []), ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        ...options, ...extraArgs] }
  },
  createParser,
}
