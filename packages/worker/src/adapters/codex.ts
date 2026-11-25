import type { CliAdapter, ParsedItem } from './types.js'
import { realCli } from './cli-probe.js'
import { agent, describe, errorText, integer, ParserState, row, sessionId, str, structuredParser, usageFields } from './structured.js'
import type { Row } from './structured.js'

const sandbox = { readonly: 'read-only', edit: 'workspace-write', full: 'danger-full-access' }
const changes = new Map([['add', 'add'], ['update', 'modify'], ['modify', 'modify'], ['delete', 'delete'], ['rename', 'rename']] as const)

function itemEvents(state: ParserState, item: Row, complete: boolean): ParsedItem[] | undefined {
  const id = str(item.id)
  switch (item.type) {
    case 'agent_message': {
      const text = str(item.text)
      if (text === undefined) return
      if (complete) state.summary = text
      return state.message('assistant', text, complete)
    }
    case 'reasoning':
      return typeof item.text === 'string' ? [agent({ type: 'thinking', text: item.text.slice(0, 8000) })] : undefined
    case 'command_execution': {
      const command = str(item.command)
      const exitCode = item.exit_code == null ? null : integer(item.exit_code)
      const output = str(item.aggregated_output)
      if (command === undefined || exitCode === undefined) return
      return [agent({ type: 'command', command: command.slice(0, 2000), exitCode,
        ...(output !== undefined && { outputTail: output.slice(-4000) }) })]
    }
    case 'file_change': {
      if (!Array.isArray(item.changes)) return
      const entries = item.changes.map(change => {
        const data = row(change)
        const path = str(data?.path)
        const kind = changes.get(data?.kind as Parameters<typeof changes.get>[0])
        return path && kind ? { path, kind } : undefined
      })
      if (entries.some(entry => !entry)) return
      return entries.flatMap(entry => {
        if (!entry) return []
        if (complete && item.status !== 'failed') state.file(entry.path)
        return [agent({ type: 'file_change', path: entry.path.slice(0, 512), change: entry.kind })]
      })
    }
    case 'mcp_tool_call': {
      const server = str(item.server), tool = str(item.tool)
      if (!server || !tool) return
      return [agent({ type: 'tool_use', ...(id && { id }), name: (server + ':' + tool).slice(0, 128),
        summary: describe(item.arguments) })]
    }
    case 'web_search': {
      const query = str(item.query)
      if (query === undefined) return
      return [agent({ type: 'tool_use', ...(id && { id }), name: 'web_search', summary: query.slice(0, 1000) })]
    }
    case 'error':
      return typeof item.message === 'string' ? state.error(item.message, false) : undefined
  }
}

function createParser() {
  const state = new ParserState()
  return structuredParser(state, event => {
    switch (event.type) {
      case 'thread.started': {
        const id = sessionId(event.thread_id)
        return id ? state.session(id) : undefined
      }
      case 'turn.started':
        return []
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = row(event.item)
        return item && itemEvents(state, item, event.type === 'item.completed')
      }
      case 'turn.completed': {
        const usage = row(event.usage)
        if (!usage || integer(usage.input_tokens) === undefined || integer(usage.output_tokens) === undefined) return
        return state.reportUsage(usageFields(usage.input_tokens, usage.output_tokens, usage.cached_input_tokens))
      }
      case 'turn.failed': {
        const message = errorText(event.error)
        return message === undefined ? undefined : state.error(message, true)
      }
      case 'error':
        return typeof event.message === 'string' ? state.error(event.message, false) : undefined
    }
  })
}

export const codexAdapter: CliAdapter = {
  ...realCli('codex', 'codex', [['exec'], ['exec', 'resume']], ['login', 'status']),
  id: 'codex', displayName: 'Codex',
  buildInvocation({ exe, cwd, prompt, profile, adapterConfig, extraArgs, model, resumeSessionId }) {
    if (resumeSessionId?.startsWith('-')) throw new Error('Invalid Codex session ID')
    const args = resumeSessionId ? ['exec', 'resume', resumeSessionId, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check', '-C', cwd]
    // The resume subcommand in 0.166.0 accepts -c, but has no --sandbox or -C.
    const mode = sandbox[profile]
    const profileArgs = resumeSessionId ? ['-c', 'sandbox_mode=' + JSON.stringify(mode)] : ['--sandbox', mode]
    return { command: exe.command, stdin: prompt, env: {},
      args: [...exe.prefixArgs, ...args, ...(model ? ['--model', model] : []),
        ...(adapterConfig.argsOverride[profile] ?? profileArgs), ...extraArgs, '-'] }
  },
  createParser,
}
