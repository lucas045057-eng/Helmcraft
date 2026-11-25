import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { AgentEvent } from '@agent-hub/protocol'
import { z } from 'zod'
import { buildEnvironment } from '../security/env.js'
import type { CliAdapter, OutputParser, ParsedItem } from './types.js'
const resolve = createRequire(import.meta.url).resolve
const session = z.object({ type: z.literal('session'), cliSessionId: z.string().max(256) })
const progress = z.object({ type: z.literal('progress'), phase: z.string().max(64), detail: z.string().max(256).optional() })
const input = z.object({ type: z.literal('input_request'), question: z.string().max(4000), options: z.array(z.string().max(200)).max(10).optional() })

function createParser(): OutputParser {
  let summary = '', cliSessionId: string | undefined, errorMessage: string | undefined, lines = 0, malformed = 0
  const tail: string[] = []
  return {
    onStdout(line): ParsedItem[] {
      lines++
      tail.push(line.slice(0, 400))
      if (tail.length > 50) tail.shift()
      if (line.charCodeAt(0) !== 123) {
        malformed++
        return [{ kind: 'log', stream: 'stdout', text: line }]
      }
      let data: unknown
      try { data = JSON.parse(line) } catch { data = null }
      const agent = AgentEvent.safeParse(data)
      if (agent.success) {
        if (agent.data.type === 'message' && agent.data.role === 'assistant' && agent.data.final) summary = agent.data.text
        if (agent.data.type === 'error') errorMessage = agent.data.message.slice(0, 2000)
        return [{ kind: 'agent', event: agent.data }]
      }
      const sessionEvent = session.safeParse(data)
      if (sessionEvent.success) {
        cliSessionId = sessionEvent.data.cliSessionId
        return [{ kind: 'session', cliSessionId }]
      }
      const progressEvent = progress.safeParse(data)
      if (progressEvent.success) return [{ kind: 'progress', phase: progressEvent.data.phase,
        ...(progressEvent.data.detail !== undefined && { detail: progressEvent.data.detail }) }]
      const inputEvent = input.safeParse(data)
      if (inputEvent.success) return [{ kind: 'input_request', question: inputEvent.data.question,
        ...(inputEvent.data.options && { options: inputEvent.data.options }) }]
      malformed++
      return [{ kind: 'log', stream: 'stdout', text: line }]
    },
    onStderr: text => [{ kind: 'log', stream: 'stderr', text }],
    finish({ code, timedOut, cancelled }) {
      const status = timedOut ? 'timed_out' : cancelled ? 'cancelled' : code === 0 ? 'succeeded' : 'failed'
      const fallback = code === 0 && malformed > lines / 2
      return { status, summary: fallback ? tail.join('\n').slice(-20_000) : summary,
        ...(cliSessionId && { cliSessionId }), ...(status === 'failed' && { errorCode: 'NONZERO_EXIT' }),
        ...(fallback ? { errorMessage: '输出格式无法识别，CLI 版本可能不兼容' } : errorMessage ? { errorMessage } : {}) }
    },
  }
}
export const mockAdapter: CliAdapter = {
  id: 'mock', displayName: 'Mock', features: { resume: true, liveInput: true, structuredOutput: true },
  async probe(signal) {
    try {
      const path = resolve('@agent-hub/mock-cli')
      await access(path)
      const { env } = buildEnvironment(process.env, { passEnv: [], env: {} })
      const version = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [path, '--version'], { env, signal, timeout: 5000, shell: false, windowsHide: true },
          (error, out) => error ? reject(error) : resolve(out.trim()))
      })
      return { status: 'ready', version: version.slice(0, 64), exe: { command: process.execPath, prefixArgs: [path] } }
    } catch { return { status: 'missing', error: 'Mock CLI is unavailable' } }
  },
  buildInvocation({ exe, prompt, extraArgs, resumeSessionId, adapterConfig, profile }) {
    const args = [...exe.prefixArgs, ...(adapterConfig.argsOverride[profile] ?? []), ...extraArgs]
    if (resumeSessionId) args.push('--resume', resumeSessionId)
    return { command: exe.command, args, stdin: prompt, env: {} }
  },
  createParser,
}
