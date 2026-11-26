import { expect, it } from 'vitest'
import { AgentOverviewResponse } from '@agent-hub/protocol'
import { FakeWorker, openHarness } from './pi/harness.js'
import { dispatch } from './pi/phase7.js'

const settings = { server: { port: 0, allowInsecureWorker: true } }
const claude = { id: 'claude-code', status: 'ready', version: '2.0.0', features: { resume: true, liveInput: false, structuredOutput: true } }

it('sets a default model per agent, applies it at dispatch and reports the model used, tokens, cost and quota', async () => {
  const { hub, cleanup } = await openHarness(settings, {})
  try {
    const authorization = 'Bearer ' + hub.ctx.auth.createApiToken('test', ['admin'])
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
      hub.ctx.http.app.inject({ method, url: '/api/v1' + url, headers: { authorization }, ...(payload !== undefined && { payload }) })
    const worker = await FakeWorker.connect(hub, { workerId: 'agents', adapters: [claude] })

    expect((await call('PUT', '/agents/claude-code/model', { model: 'rm -rf' })).statusCode).toBe(400)
    expect((await call('PUT', '/agents/nope/model', { model: 'x' })).statusCode).toBe(404)
    expect((await call('PUT', '/agents/claude-code/model', { model: 'sonnet' })).json()).toEqual({ adapter: 'claude-code', defaultModel: 'sonnet' })

    // 没指定模型 → 用默认模型；任务自己指定的模型优先
    const plain = (await call('POST', '/tasks', { prompt: 'a', workspaceId: 'sandbox', adapter: 'claude-code' })).json()
    const run = await dispatch(worker, plain.id)
    expect(run.model).toBe('sonnet')
    worker.events(run.runId, run.taskId, [
      { kind: 'started', pid: 1, effectiveProfile: 'edit', adapter: 'claude-code', commandSummary: 'claude', seq: 1, ts: Date.now() },
      { kind: 'agent', event: { type: 'init', model: 'claude-sonnet-5-5' }, seq: 2, ts: Date.now() },
      { kind: 'agent', event: { type: 'quota', windows: [{ name: 'five_hour', utilization: 0.22, resetsAt: Date.now() + 3_600_000, status: 'allowed' },
        { name: 'seven_day', utilization: 0.36, resetsAt: null }] }, seq: 3, ts: Date.now() },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 5,
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, costUsd: 0.05 }, seq: 4, ts: Date.now() },
    ])
    const pinned = (await call('POST', '/tasks', { prompt: 'b', workspaceId: 'sandbox', adapter: 'claude-code', model: 'opus' })).json()
    await new Promise(resolve => setTimeout(resolve, 300))
    const second = await dispatch(worker, pinned.id)
    expect(second.model).toBe('opus')
    worker.events(second.runId, second.taskId, [
      { kind: 'started', pid: 2, effectiveProfile: 'edit', adapter: 'claude-code', commandSummary: 'claude', seq: 1, ts: Date.now() },
      { kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 5, seq: 2, ts: Date.now() },
    ])
    await new Promise(resolve => setTimeout(resolve, 300))

    const agents = AgentOverviewResponse.parse((await call('GET', '/agents')).json())
    const view = agents.find(a => a.adapter === 'claude-code')!
    expect(view).toMatchObject({ ready: true, defaultModel: 'sonnet',
      usage: { today: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, costUsd: 0.05 } } })
    expect(view.usage.month.runs).toBe(2)
    expect(view.byModel.find(m => m.model === 'claude-sonnet-5-5')).toMatchObject({ runs: 1, inputTokens: 1000 })
    expect(view.suggestedModels).toEqual(expect.arrayContaining(['sonnet', 'opus', 'haiku', 'claude-sonnet-5-5']))
    expect(view.quota[0]).toMatchObject({ workerId: 'agents', windows: [{ name: 'five_hour', utilization: 0.22 }, { name: 'seven_day', resetsAt: null }] })

    // 恢复 CLI 默认 → 不再下发 --model
    await call('PUT', '/agents/claude-code/model', { model: null })
    const third = (await call('POST', '/tasks', { prompt: 'c', workspaceId: 'sandbox', adapter: 'claude-code' })).json()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await dispatch(worker, third.id)).model).toBeUndefined()
  } finally { await cleanup() }
}, 20_000)
