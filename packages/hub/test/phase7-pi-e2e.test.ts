/**
 * Pi 独立验收 · Phase 7a 端到端（真实 Hub 进程 + 真实 Worker + mock-cli）
 * E2E-15 ~ E2E-18。
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOARD_TEMPLATES } from '@agent-hub/protocol'
import { expect, it } from 'vitest'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { enrollWorker, eventually, openHarness, wsUrl } from './pi/harness.js'
import { owner, requester } from './pi/phase7.js'

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const startScenario = (name: string, ops?: unknown[]) => '#scenario:' + name + ' harness=1' + (ops ? ' ops=' + b64(ops) : '')

async function ready() {
  const opened = await openHarness()
  const workerId = 'pi-e2e'
  const identity = await enrollWorker(opened.hub, workerId)
  const path = join(opened.dir, 'repo')
  mkdirSync(path, { recursive: true })
  const worker = await startWorker(WorkerConfigSchema.parse({ workerId, hub: { url: wsUrl(opened.hub.address!) },
    adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path, allowedAdapters: ['mock'], maxProfile: 'full' }] }),
  { stateDir: join(opened.dir, 'worker-state'),
    identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint } })
  await eventually(() => opened.hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 15000 })
  return { ...opened, worker, path, workerId }
}

const settle = async (hub: Awaited<ReturnType<typeof ready>>['hub'], id: string, timeoutMs = 30000) => {
  const task = await eventually(() => {
    const current = hub.ctx.orchestrator.getTask(id)
    return current && ['succeeded', 'failed', 'rejected', 'cancelled'].includes(current.status) ? current : undefined
  }, { timeoutMs })
  return task
}

it('E2E-15 bootstraps the blackboard and injects all four files on the next fresh run', async () => {
  const session = await ready()
  try {
    const { hub, path } = session
    const creation = [{ op: 'mkdir', path: '.board' },
      ...Object.entries(BOARD_TEMPLATES).map(([name, content]) => ({ op: 'write', path: '.board/' + name, content }))]
    const boot = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('fs', creation) }, owner)
    const booted = await settle(hub, boot.id)
    expect(booted.status).toBe('succeeded')
    expect(readdirSync(join(path, '.board')).sort()).toEqual(Object.keys(BOARD_TEMPLATES).sort())
    const bootRun = booted.runs[0]!
    expect(bootRun.harness?.board).toBe('write')
    expect(booted.runs.length).toBe(1)
    expect(hub.ctx.orchestrator.runHarness(boot.id, bootRun.id).applied?.bootstrap).toBe(true)
    const changes = hub.ctx.orchestrator.runHarness(boot.id, bootRun.id).board.diff
    expect(changes.filter(change => change.change === 'created')).toHaveLength(4)

    const second = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('echo-harness') }, owner)
    const fresh = await settle(hub, second.id)
    expect(fresh.status).toBe('succeeded')
    const summary = JSON.parse(fresh.runs[0]!.summary!) as { hx: boolean; mode: string; blocks:
      { preamble: boolean; facts: boolean; board: string[]; bootstrap: boolean } }
    expect(summary.hx).toBe(true)
    expect(summary.mode).toBe('fresh')
    expect(summary.blocks.bootstrap).toBe(false)
    expect(summary.blocks.board.sort()).toEqual(Object.keys(BOARD_TEMPLATES).sort())
    expect(summary.blocks.facts).toBe(true)
    // MOCK-4：mock 摘要的 sha256 必须等于 Worker 记录的 prompt 摘要
    const view = hub.ctx.orchestrator.runHarness(second.id, fresh.runs[0]!.id)
    expect(JSON.parse(fresh.runs[0]!.summary!)).toMatchObject({ sha256: view.prompt?.sha256, bytes: view.prompt?.bytes })
  } finally { await session.worker.close(); await session.cleanup() }
}, 90000)

it('E2E-16/E2E-17 relay the baton to a new session, pin the worker and warn about interleaving', async () => {
  const session = await ready()
  try {
    const { hub, workerId } = session
    // 先建立黑板，使接力轮能注入四个文件
    const seedOps = [{ op: 'mkdir', path: '.board' },
      ...Object.entries(BOARD_TEMPLATES).map(([name, content]) => ({ op: 'write', path: '.board/' + name, content }))]
    const seed = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('fs', seedOps) }, owner)
    expect((await settle(hub, seed.id)).status).toBe('succeeded')
    const source = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('echo-harness') }, owner)
    const first = await settle(hub, source.id)
    expect(first.status).toBe('succeeded')
    // 另一个写入型任务在交接之前改动了同一工作区
    const interleaved = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('echo-harness') }, owner)
    const interleavedDone = await settle(hub, interleaved.id)
    expect(interleavedDone.status).toBe('succeeded')
    const preview = hub.ctx.orchestrator.handoffPreview(source.id, owner, { intent: 'relay', adapter: 'mock' })
    expect(preview.warnings).toContain('INTERLEAVED')
    expect(preview.promptPreview).toContain('WARNING')
    expect(preview.facts.continuity?.interleaved.map(entry => entry.runId)).toContain(interleavedDone.runs[0]!.id)
    const child = await hub.ctx.orchestrator.handoff(source.id, owner, { intent: 'relay', prompt: startScenario('echo-harness') })
    const relayed = await settle(hub, child.id)
    expect(relayed.status).toBe('succeeded')
    expect(relayed).toMatchObject({ parentTaskId: source.id })
    const childRow = hub.ctx.store.repos.tasks.get(child.id)!
    expect(childRow).toMatchObject({ parentTaskId: source.id, rootTaskId: source.id, requiredWorkerId: workerId,
      handoffFromRunId: first.runs[0]!.id, resumeSessionId: null })
    expect(relayed.handoff).toMatchObject({ fromRunId: first.runs[0]!.id, intent: 'relay' })
    const view = hub.ctx.orchestrator.runHarness(child.id, relayed.runs[0]!.id)
    expect(view.directive).toMatchObject({ inject: 'handoff', board: 'write' })
    expect(view.facts?.handoff?.from.runId).toBe(first.runs[0]!.id)
    expect(view.facts?.continuity?.interleavedTotal).toBeGreaterThanOrEqual(1)
    const summary = JSON.parse(relayed.runs[0]!.summary!) as { mode: string; blocks: { board: string[] } }
    expect(summary.mode).toBe('handoff')
    expect(summary.blocks.board).toHaveLength(4)
    // 换 CLI 必为新会话：不再 resume
    expect(relayed.resumeSessionId ?? null).toBeNull()
    const pointer = hub.ctx.store.repos.pointers.get(workerId, 'sandbox')!
    expect(pointer.lastAttemptRunId).toBe(relayed.runs[0]!.id)
    expect(pointer.lastAcceptedRunId).toBe(relayed.runs[0]!.id)
    expect(hub.ctx.orchestrator.listWorkspacePointers()).toHaveLength(1)
  } finally { await session.worker.close(); await session.cleanup() }
}, 120000)

it('E2E-18 gates a Requester result after the blackboard file is deleted until the Owner sends it', async () => {
  const session = await ready()
  try {
    const { hub, path } = session
    // 先由 Owner 建立黑板
    const seedOps = [{ op: 'mkdir', path: '.board' },
      ...Object.entries(BOARD_TEMPLATES).map(([name, content]) => ({ op: 'write', path: '.board/' + name, content }))]
    const seed = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('fs', seedOps) }, owner)
    expect((await settle(hub, seed.id)).status).toBe('succeeded')
    expect(readdirSync(join(path, '.board'))).toHaveLength(4)
    const task = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: startScenario('fs', [{ op: 'delete', path: '.board/HANDOFF.md' }]) }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner, { overrides: { harness: { blackboard: true } } })
    const gated = await settle(hub, task.id)
    expect(gated.status).toBe('succeeded')
    expect(gated.resultDeliveryStatus).toBe('pending_review')
    expect(gated.timeline.map(entry => entry.event)).toContain('task.harness.result_gated')
    expect(hub.ctx.orchestrator.runHarness(task.id, gated.runs[0]!.id).board.diff)
      .toContainEqual(expect.objectContaining({ file: 'HANDOFF.md', change: 'deleted' }))
    expect(readdirSync(join(path, '.board'))).not.toContain('HANDOFF.md')
    // Owner 发送后状态才变为 delivered；Requester 自己无法发送
    expect(await hub.ctx.orchestrator.deliverResult(task.id, requester, { action: 'send' })
      .catch((error: { status: number }) => error.status)).toBe(403)
    expect(hub.ctx.orchestrator.getTask(task.id)?.resultDeliveryStatus).toBe('pending_review')
    const delivered = await hub.ctx.orchestrator.deliverResult(task.id, owner, { action: 'send' })
    expect(delivered.resultDeliveryStatus).toBe('delivered')
    expect(delivered.timeline.map(entry => entry.event)).toContain('task.result.delivered')
  } finally { await session.worker.close(); await session.cleanup() }
}, 120000)

it('E2E-15b keeps the non-harness mock path byte-identical (no .board, no harness events)', async () => {
  const session = await ready()
  try {
    const { hub, path } = session
    writeFileSync(join(path, 'note.txt'), 'unchanged')
    const task = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit',
      prompt: '#scenario:success' }, owner)
    const done = await settle(hub, task.id)
    expect(done.status).toBe('succeeded')
    expect(done.runs[0]).not.toHaveProperty('harness')
    expect(hub.ctx.orchestrator.runHarness(task.id, done.runs[0]!.id).applied).toBeNull()
    expect(readdirSync(path).sort()).toEqual(['note.txt'])
    expect(hub.ctx.store.repos.pointers.list()).toHaveLength(1)
  } finally { await session.worker.close(); await session.cleanup() }
}, 90000)
