import { describe, expect, it } from 'vitest'
import { antigravityAdapter } from '../src/adapters/antigravity.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

const cid = '852f11b6-7ce0-4209-a7ca-fb513184e62f'
const step = (body: Record<string, unknown>) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: cid, ...body } })
const lines = [
  JSON.stringify({ event: 'init', conversation_id: cid, init: { cwd: '/tmp/ws', tools: ['read_file', 'write_file'] } }),
  step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
  step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Updating ' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'a.txt\n' }),
  step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: '/tmp/ws/a.txt' } } }),
  step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', duration_seconds: 0.2 }),
  JSON.stringify({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'Appended `world` to a.txt.\n',
    num_turns: 1, usage: { input_tokens: 16614, output_tokens: 620, thinking_tokens: 472, cache_read_tokens: 23270 } } }),
]

describe('antigravity adapter', () => {
  it('builds a print-mode invocation with the prompt on stdin', () => {
    const invocation = antigravityAdapter.buildInvocation({ exe: { command: '/home/u/.local/bin/agy-egress', prefixArgs: [] }, prompt: '-p tricky\nprompt',
      cwd: '/tmp/ws', profile: 'edit', extraArgs: [], resumeSessionId: cid, model: 'gemini-4-neon-high',
      adapterConfig: { enabled: true, argsOverride: {}, env: {}, passEnv: [] } as never })
    expect(invocation.args).toEqual(['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--conversation', cid, '--model', 'gemini-4-neon-high', '--mode', 'accept-edits'])
    expect(JSON.parse(invocation.stdin)).toEqual({ event: 'user', message: { content: '-p tricky\nprompt' } })
    expect(invocation.args.join(' ')).not.toContain('tricky')
  })

  it('maps profiles to agy permission modes', () => {
    const args = (profile: 'readonly' | 'edit' | 'full') => antigravityAdapter.buildInvocation({ exe: { command: 'agy', prefixArgs: [] }, prompt: 'x',
      cwd: '/tmp', profile, extraArgs: [], adapterConfig: { enabled: true, argsOverride: {}, env: {}, passEnv: [] } as never }).args.slice(5)
    expect(args('readonly')).toEqual(['--mode', 'plan', '--sandbox'])
    expect(args('full')).toEqual(['--dangerously-skip-permissions'])
  })

  it('parses a successful stream-json run', () => {
    const parser = antigravityAdapter.createParser()
    const items = lines.flatMap(line => parser.onStdout(line))
    expect(items.filter(item => item.kind === 'log')).toEqual([])
    expect(items).toContainEqual({ kind: 'session', cliSessionId: cid })
    expect(items).toContainEqual({ kind: 'agent', event: { type: 'tool_use', id: 'step-2', name: 'write_file', summary: '{"Path":"/tmp/ws/a.txt"}' } })
    expect(items).toContainEqual({ kind: 'agent', event: { type: 'tool_result', id: 'step-2', ok: true, summary: 'DONE' } })
    const text = items.flatMap(item => item.kind === 'agent' && item.event.type === 'message' ? [item.event.text] : []).join('')
    expect(text).toBe('Updating a.txt\n')
    const outcome = parser.finish({ code: 0, signal: null, timedOut: false, cancelled: false })
    expect(outcome).toMatchObject({ status: 'succeeded', summary: 'Appended `world` to a.txt.', cliSessionId: cid,
      usage: { inputTokens: 16614, outputTokens: 620, cacheReadTokens: 23270 }, filesChanged: ['/tmp/ws/a.txt'] })
  })

  it('falls back to streamed text and reports denied actions when response is empty', () => {
    const parser = antigravityAdapter.createParser()
    parser.onStdout(step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Implemented divide.\n' }))
    const items = parser.onStdout(JSON.stringify({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: '',
      num_turns: 1, denied_actions: [{ action: 'command', display_name: 'Bash' }] } }))
    expect(items).toContainEqual(expect.objectContaining({ kind: 'agent', event: expect.objectContaining({ type: 'error', fatal: false }) }))
    const outcome = parser.finish({ code: 0, signal: null, timedOut: false, cancelled: false })
    expect(outcome.status).toBe('succeeded')
    expect(outcome.summary).toContain('Implemented divide.')
    expect(outcome.summary).toContain('Bash')
  })

  it('reports an ERROR result as a failed run', () => {
    const parser = antigravityAdapter.createParser()
    parser.onStdout(JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '',
      error: 'invalid model selection (--model "x")', num_turns: 0 } }))
    const outcome = parser.finish({ code: 1, signal: null, timedOut: false, cancelled: false })
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'NONZERO_EXIT', errorMessage: 'invalid model selection (--model "x")' })
  })

  it('is registered with the worker', async () => {
    const config = WorkerConfigSchema.parse({ workerId: 'w1', hub: { url: 'ws://127.0.0.1:1/ws/worker' }, workspaces: [],
      adapters: { antigravity: { enabled: true, command: '/nonexistent/agy' } } })
    const registry = new AdapterRegistry(config)
    await registry.probe(['antigravity'])
    expect(registry.get('antigravity')?.adapter?.id).toBe('antigravity')
  })
})
