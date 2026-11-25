import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createTestHub } from '../src/app.js'
import { expect, it } from 'vitest'
import { RunDispatch } from '@agent-hub/protocol'
import { FakeWorker, eventually, openHarness, tmpDir } from './pi/harness.js'
import { capabilities, dispatch, finish, mockPrompt, owner, snapshot } from './pi/phase7.js'

it('recovers the frozen directive, including the original facts timestamp, after changing policy', async () => {
  const dir = tmpDir()
  const settings = { storage: { path: join(dir, 'hub.sqlite') }, server: { port: 0, allowInsecureWorker: true } }
  let hub = await createTestHub(settings)
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'worker-freeze', headers: capabilities })
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    const original = await worker.waitFor('run.dispatch')
    const run = RunDispatch.parse(original.payload)
    expect(run.taskId).toBe(task.id)
    expect(run.harness?.facts?.currentRun.runId).toBe(run.runId)
    await hub.close()
    hub = await createTestHub({ ...settings, harness: { enabled: false } })
    const next = await FakeWorker.connect(hub, { workerId: 'worker-freeze', headers: capabilities, identity: worker.identity })
    const resent = await next.waitFor('run.dispatch')
    expect(RunDispatch.parse(resent.payload).harness).toEqual(run.harness)
    await next.ackCommand(resent)
    await finish(hub, next, run)
    const second = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    expect(await dispatch(next, second.id)).not.toHaveProperty('harness')
  } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }) }
}, 15000)

it('keeps legacy-source handoffs queued until the same worker negotiates blackboard.v1', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const id = 'worker-legacy'
    const old = await FakeWorker.connect(hub, { workerId: id })
    const first = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    const run = await dispatch(old, first.id)
    await finish(hub, old, run)
    const child = await hub.ctx.orchestrator.handoff(first.id, owner, { intent: 'relay', prompt: mockPrompt, adapter: 'mock' })
    await eventually(() => hub.ctx.store.repos.tasks.get(child.id)?.scheduleHint === 'HARNESS_UNSUPPORTED')
    const next = await FakeWorker.connect(hub, { workerId: id, identity: old.identity, headers: capabilities })
    const relay = await dispatch(next, child.id)
    expect(relay.resume).toBeUndefined()
    expect(relay.harness).toMatchObject({ inject: 'handoff', facts: { handoff: { from: { runId: run.runId } } } })
    expect(relay.harness?.facts?.continuity).toBeUndefined()
    await finish(hub, next, relay)
    const follow = await hub.ctx.orchestrator.followUp(child.id, owner, { prompt: mockPrompt })
    const resume = await dispatch(next, follow.id)
    expect(resume.harness).toMatchObject({ inject: 'resume' })
    expect(resume.harness?.facts).toBeUndefined()
    await finish(hub, next, resume)
    const earlier = await hub.ctx.orchestrator.followUp(first.id, owner, { prompt: mockPrompt })
    expect((await dispatch(next, earlier.id)).harness?.facts?.continuity?.interleavedTotal).toBe(2)
  } finally { await cleanup() }
}, 15000)

it('persists unnegotiated events, preserves sequence acknowledgements and keeps verification orthogonal to task transitions', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const id = 'worker-orthogonal'
    const worker = await FakeWorker.connect(hub, { workerId: id })
    const data = { prompt: 'ordinary task', workspaceId: 'sandbox', profile: 'edit' as const }
    const histories: unknown[] = []
    for (const extra of [false, true]) {
      const task = await hub.ctx.orchestrator.createTask(data, owner)
      const run = await dispatch(worker, task.id)
      const events = extra ? [
        { kind: 'harness', applied: { board: 'capture', inject: 'none', trust: 'owner', bootstrap: false, verify: false, autoFixMaxRetries: 0, downgrades: [] }, board: snapshot('captured') },
        { kind: 'verify', attempt: 1, phase: 'started', commands: ['test'] },
      ] : []
      const result = { kind: 'finished', status: 'succeeded', exitCode: 0, signal: null, summary: '', durationMs: 1,
        ...(extra && { verification: { status: 'failed', failed: ['test'], attempts: 1 } }) }
      worker.events(run.runId, task.id, [...events, result].map((e, i) => ({ ...e, ts: Date.now(), seq: i + 1 })))
      await eventually(() => hub.ctx.store.repos.runs.get(run.runId)?.status === 'succeeded')
      const detail = hub.ctx.orchestrator.getTask(task.id)!
      histories.push({ version: detail.version, status: detail.status, timeline: detail.timeline.filter(t => t.to && t.from !== t.to).map(t => t.event) })
      if (extra) {
        expect(detail.runs[0]!.lastSeq).toBe(3)
        expect(hub.ctx.orchestrator.runHarness(task.id, run.runId).board.pre?.files[0]?.content).toBe('captured')
      }
    }
    expect(histories[1]).toEqual(histories[0])
    expect(hub.ctx.orchestrator.metrics().harnessUnnegotiatedEvents).toBe(2)
  } finally { await cleanup() }
})

it('applies hot policy to subsequent dispatches and renegotiates gateway changes on reconnect', async () => {
  const { hub, cleanup } = await openHarness()
  try {
    const workerId = 'worker-hot'
    const worker = await FakeWorker.connect(hub, { workerId, headers: capabilities })
    await hub.fibers.get('workers')!.update({ ...hub.config.workers, capabilities: [] })
    expect(hub.ctx.workers.capabilities(workerId)).toEqual(['blackboard.v1'])
    const fiber = hub.fibers.get('orchestrator')!
    await fiber.update({ ...hub.config.orchestrator, harness: { ...hub.config.harness, enabled: false },
      requesterReplyPolicy: 'auto', timezone: hub.config.server.timezone })
    const task = await hub.ctx.orchestrator.createTask({ prompt: mockPrompt, workspaceId: 'sandbox' }, owner)
    const run = await dispatch(worker, task.id)
    expect(run.harness).toBeUndefined()
    await finish(hub, worker, run)
    await fiber.restart()
    const reconnected = await FakeWorker.connect(hub, { workerId, headers: capabilities, identity: worker.identity })
    expect(reconnected.welcome?.capabilities).toEqual([])
    expect(hub.ctx.workers.capabilities(workerId)).toEqual([])
  } finally { await cleanup() }
})
