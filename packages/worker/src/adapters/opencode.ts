import type { CliAdapter, ParsedItem } from './types.js'
import { realCli } from './cli-probe.js'
import { agent, describe, errorText, ParserState, row, sessionId, str, structuredParser, usageFields } from './structured.js'
import type { Row } from './structured.js'

const profiles = {
  readonly: { edit: 'deny', bash: 'deny', external_directory: 'deny' },
  edit: { edit: 'allow', bash: 'ask', external_directory: 'deny' },
  full: { '*': 'allow' },
}

function decode(state: ParserState, event: Row): ParsedItem[] | undefined {
  const part = row(event.part)
  switch (event.type) {
    case 'step_start':
      return part ? [] : undefined
    case 'text': {
      const text = str(part?.text)
      if (text === undefined) return
      state.summary = (state.summary + text).slice(0, 20_000)
      return state.message('assistant', text)
    }
    case 'tool_use': {
      const name = str(part?.tool), id = str(part?.callID)
      const tool = row(part?.state)
      if (!name || !id || !tool) return
      const items = [agent({ type: 'tool_use', id, name: name.slice(0, 128), summary: describe(tool.input) })]
      if (tool.status === 'completed' || tool.status === 'error') items.push(agent({
        type: 'tool_result', id, ok: tool.status === 'completed', summary: describe(tool.output ?? tool.error, 2000),
      }))
      return items
    }
    case 'step_finish': {
      const tokens = row(part?.tokens)
      if (!tokens) return
      return state.reportUsage(usageFields(tokens.input, tokens.output, row(tokens.cache)?.read, part?.cost), true)
    }
    case 'error': {
      const message = errorText(event.error)
      return message === undefined ? undefined : state.error(message, true)
    }
  }
}

function createParser() {
  const state = new ParserState()
  return structuredParser(state, event => {
    const id = sessionId(event.sessionID)
    if (!id) return
    const items = decode(state, event)
    if (items) return [...(state.cliSessionId ? [] : state.session(id)), ...items]
  })
}

export const opencodeAdapter: CliAdapter = {
  ...realCli('opencode', 'opencode', [['run']]),
  id: 'opencode', displayName: 'OpenCode',
  buildInvocation({ exe, prompt, profile, adapterConfig, extraArgs, model, resumeSessionId }) {
    const path = 'opencode.json'
    const permission = profiles[profile]
    return { command: exe.command, stdin: prompt,
      env: { OPENCODE_CONFIG: path, OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_DISABLE_PROJECT_CONFIG: 'true' },
      tempFiles: [{ path, content: JSON.stringify({ permission }) }],
      args: [...exe.prefixArgs, 'run', '--format', 'json', ...(model ? ['--model', model] : []),
        ...(resumeSessionId ? ['--session', resumeSessionId] : []), ...(adapterConfig.argsOverride[profile] ?? []), ...extraArgs] }
  },
  createParser,
}
