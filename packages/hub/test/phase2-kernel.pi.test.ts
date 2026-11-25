/**
 * Pi 独立验收 · Phase 2 门禁：K-9 / K-10（Cordis 内核与级联重启）
 */
import { Context, Service } from 'cordis'
import { expect, it } from 'vitest'
import { waitForActive } from '../src/kernel/lifecycle.js'
import { FiberState } from '../src/kernel/fiber-state.js'
import { safeOn } from '../src/kernel/safe.js'
import { openHarness } from './pi/harness.js'

it('K-9 ctx.on 自动解绑：插件 dispose 后再 emit，其监听器不再被调用', async () => {
  const root = new Context()
  const seen: string[] = []
  class Listener extends Service {
    constructor(ctx: Context) { super(ctx, 'k9') }
    [Service.init]() {
      // eslint-disable-next-line local/safe-events -- K-9 必须验证裸 ctx.on 在 dispose 后自动解绑
      this.ctx.on('k9/ping', (value: string) => { seen.push(value) })
    }
  }
  const fiber = root.use(Listener).ctx.fiber
  expect(await waitForActive(root, [fiber])).toEqual({ success: true })
  root.emit('k9/ping', 'before')
  expect(seen).toEqual(['before'])
  await fiber.dispose()
  expect(fiber.state).toBe(FiberState.DISPOSED)
  root.emit('k9/ping', 'after')
  expect(seen).toEqual(['before'])
})

it('K-10 Provider 重启级联：workers 重启 → orchestrator / dashboard-api 重启，恢复后与 DB 一致且路由可用', async () => {
  const { hub, cleanup } = await openHarness({ server: { port: 0, allowInsecureWorker: true } })
  try {
    const token = hub.ctx.auth.createApiToken('k10', ['admin'])
    const task = await hub.ctx.orchestrator.createTask({ prompt: 'survive restart', workspaceId: 'sandbox' }, 
      { type: 'owner', id: 'dashboard:owner', channel: 'dashboard' })
    const before = hub.ctx.orchestrator.getTask(task.id)
    expect(before?.status).toBe('queued')

    const states = new Map<string, number[]>()
    const watch = new Set(['WorkerGatewayWs', 'OrchestratorService', 'dashboard-api'])
    const detach = safeOn(hub.ctx, 'internal/status', (fiber: { name: string; state: number }) => {
      if (!watch.has(fiber.name)) return
      const list = states.get(fiber.name) ?? []
      list.push(fiber.state)
      states.set(fiber.name, list)
    }, { global: true })

    const bootBefore = hub.ctx.workers.bootId
    await hub.fibers.get('workers')!.restart()
    detach()
    expect(await waitForActive(hub.ctx, hub.fibers.values())).toEqual({ success: true })
    expect(hub.ctx.workers.bootId).not.toBe(bootBefore)

    // 消费者确实被级联重启（经历 DISPOSED/UNLOADING 后重新 ACTIVE）
    for (const name of ['OrchestratorService', 'dashboard-api']) {
      const history = states.get(name) ?? []
      expect(history, name + ' 未观察到重启').not.toHaveLength(0)
      expect(history.some(state => state === FiberState.DISPOSED || state === FiberState.UNLOADING || state === FiberState.PENDING),
        name + ' 未观察到卸载/重建').toBe(true)
    }

    // 恢复后与 DB 一致
    const after = hub.ctx.orchestrator.getTask(task.id)
    expect(after).toMatchObject({ id: task.id, status: before!.status, version: before!.version })

    // 路由仍可用
    const overview = await fetch(new URL('/api/v1/overview', hub.address!), { headers: { Authorization: 'Bearer ' + token } })
    expect(overview.status).toBe(200)
    const tasks = await fetch(new URL('/api/v1/tasks', hub.address!), { headers: { Authorization: 'Bearer ' + token } })
    expect(tasks.status).toBe(200)
    expect((await tasks.json() as { items: { id: string }[] }).items.map(item => item.id)).toContain(task.id)
  } finally { await cleanup() }
})
