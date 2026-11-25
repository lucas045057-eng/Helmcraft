import { BoardFileName, RunDispatch } from '@agent-hub/protocol'
import type { BoardSnapshot, Profile } from '@agent-hub/protocol'
import type { TestHub } from '../../src/app.js'
import { FakeWorker, eventually } from './harness.js'

export const owner = { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' } as const
export const requester = { type: 'requester', id: 'requester', channel: 'api' } as const
export const mockPrompt = '#scenario: echo-harness harness=1'
export const capabilities = { 'X-Agent-Hub-Capabilities': 'blackboard.v1' }

export function snapshot(content?: string): BoardSnapshot {
  return { dir: 'present', capturedAt: Date.now(), agentsMd: { status: 'absent', bytes: 0 },
    files: BoardFileName.options.map((file, index) => index === 0 && content !== undefined
      ? { file, status: 'present', bytes: Buffer.byteLength(content), lines: 1, schemaOk: true, overBudget: false, content, sha256: 'a'.repeat(64) }
      : { file, status: 'absent', bytes: 0, lines: 0, schemaOk: false, overBudget: false }) }
}
export async function dispatch(worker: FakeWorker, taskId: string) {
  const frame = await worker.waitFor('run.dispatch', f => (f.payload as RunDispatch).taskId === taskId)
  await worker.ackCommand(frame)
  return RunDispatch.parse(frame.payload)
}
export async function finish(hub: TestHub, worker: FakeWorker, run: RunDispatch, pre = snapshot('private board text'), post = snapshot(),
  profile: Profile = 'edit') {
  const { harness } = run
  const items: Record<string, unknown>[] = [{ kind: 'started', pid: 42, effectiveProfile: profile, adapter: run.adapter, commandSummary: 'test' }]
  if (harness) items.push({ kind: 'harness', applied: { board: harness.board, inject: harness.inject, trust: harness.trust, bootstrap: false,
    verify: false, autoFixMaxRetries: 0, downgrades: [] }, board: pre }, { kind: 'workspace', round: 0, board: post })
  items.push({ kind: 'finished', status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 1, cliSessionId: 'session-' + run.runId })
  const events = items.map((item, i) => ({ ...item, seq: i + 1, ts: Date.now() }))
  worker.events(run.runId, run.taskId, events)
  await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
  return events
}
