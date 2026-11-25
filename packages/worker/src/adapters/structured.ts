import type { AgentEvent } from '@agent-hub/protocol'
import type { OutputParser, ParsedItem, ParsedOutcome } from './types.js'

export type Row = Record<string, unknown>
export type Usage = NonNullable<ParsedOutcome['usage']>
export const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
export const str = (value: unknown) => typeof value === 'string' ? value : undefined
export const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
export const cost = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
export const agent = (event: AgentEvent): ParsedItem => ({ kind: 'agent', event })
export const describe = (value: unknown, limit = 1000) => (str(value) ?? JSON.stringify(value) ?? '').slice(0, limit)
export const sessionId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
export const errorText = (value: unknown) => str(value) ?? str(row(value)?.message) ?? str(row(row(value)?.data)?.message)
export const usageFields = (input: unknown, output: unknown, cached: unknown, usd?: unknown): Usage => {
  const inputTokens = integer(input), outputTokens = integer(output), cacheReadTokens = integer(cached), costUsd = cost(usd)
  return { ...(inputTokens !== undefined && { inputTokens }), ...(outputTokens !== undefined && { outputTokens }),
    ...(cacheReadTokens !== undefined && { cacheReadTokens }), ...(costUsd !== undefined && { costUsd }) }
}

export class ParserState {
  summary = ''
  cliSessionId?: string
  private usage?: Usage
  private failed = false
  private errorMessage?: string
  private readonly files = new Set<string>()

  session(id: string): ParsedItem[] {
    if (this.cliSessionId === id) return []
    this.cliSessionId = id
    return [{ kind: 'session', cliSessionId: id }]
  }
  file(path: string) {
    if (this.files.size < 200) this.files.add(path)
  }
  message(role: 'assistant' | 'user', text: string, final = false): ParsedItem[] {
    // Keep each event within the wire limit without discarding message text.
    const events: ParsedItem[] = []
    let offset = 0
    do {
      let end = Math.min(offset + 16_000, text.length)
      const last = text.charCodeAt(end - 1)
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
      events.push(agent({ type: 'message', role, text: text.slice(offset, end), final: final && end === text.length }))
      offset = end
    } while (offset < text.length)
    return events
  }
  reportUsage(usage: Usage, accumulate = false): ParsedItem[] {
    if (!Object.keys(usage).length) return []
    this.usage ??= {}
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd'] as const) {
      const value = usage[key]
      if (value !== undefined) this.usage[key] = accumulate ? (this.usage[key] ?? 0) + value : value
    }
    const { inputTokens, outputTokens, costUsd } = usage
    return [agent({ type: 'usage', ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }), ...(costUsd !== undefined && { costUsd }) })]
  }
  error(message: string, fatal: boolean): ParsedItem[] {
    if (fatal || !this.failed) this.errorMessage = message.slice(0, 2000)
    this.failed ||= fatal
    return [agent({ type: 'error', message: message.slice(0, 4000), fatal })]
  }
  finish({ code, timedOut, cancelled }: Parameters<OutputParser['finish']>[0], fallback?: string): ParsedOutcome {
    const status = timedOut ? 'timed_out' : cancelled ? 'cancelled' : code !== 0 || this.failed ? 'failed' : 'succeeded'
    const formatChanged = status === 'succeeded' && fallback !== undefined
    const errorMessage = formatChanged ? '输出格式无法识别，CLI 版本可能不兼容' : this.errorMessage
    return { status, summary: (formatChanged ? fallback : this.summary).slice(0, 20_000),
      ...(status === 'failed' && { errorCode: code !== 0 ? 'NONZERO_EXIT' : 'ADAPTER_ERROR' }),
      ...(errorMessage && { errorMessage }), ...(this.cliSessionId && { cliSessionId: this.cliSessionId }),
      ...(this.usage && { usage: this.usage }), ...(this.files.size && { filesChanged: [...this.files] }) }
  }
}

export function structuredParser(state: ParserState, decode: (data: Row) => ParsedItem[] | undefined,
  flush?: (force: boolean) => ParsedItem[]): OutputParser {
  let lines = 0, malformed = 0
  const tail: string[] = []
  return {
    onStdout(line) {
      lines++
      tail.push(line.slice(0, 20_000))
      if (tail.length > 50) tail.shift()
      try {
        const data = row(JSON.parse(line))
        const items = data && decode(data)
        if (items !== undefined) return items
      } catch { /* Unrecognized CLI output is retained as a log. */ }
      malformed++
      return [...(flush?.(true) ?? []), { kind: 'log', stream: 'stdout', text: line }]
    },
    onStderr: text => [{ kind: 'log', stream: 'stderr', text }],
    ...(flush && { flushPending: () => flush(false) }),
    finish(exit, emit) {
      for (const item of flush?.(true) ?? []) emit?.(item)
      return state.finish(exit, malformed > lines / 2 ? tail.join('\n').slice(-20_000) : undefined)
    },
  }
}
