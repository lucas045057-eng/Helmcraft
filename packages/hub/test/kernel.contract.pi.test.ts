/**
 * Pi 独立验收 · 01 Cordis 内核契约门禁 K-1 ~ K-8
 *
 * 与既有 `kernel.test.ts` 的差异：本文件逐条对齐 pi-test-matrix §1 的预期，
 * 并把「镜像常量必须等于运行时 enum」「热键改动不得 dispose effect」
 * 「waitForActive 超时返回 PENDING 列表」「safeOn 错误计数」等断言写到最严格。
 */
import { Context, Service, ValidationError } from 'cordis'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  FiberState, guardAsync, listenerFailureCount, onHotUpdate, safeOn, supervise, waitForActive,
} from '../src/index.js'

interface Deferred<T = void> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// K-1 FiberState 镜像常量
// ---------------------------------------------------------------------------

describe('K-1 FiberState 镜像常量', () => {
  it('equals the runtime enum exported by cordis rc.13', async () => {
    const cordis = await import('cordis') as unknown as { FiberState: Record<string, number> }
    const runtime = cordis.FiberState
    expect(runtime).toBeTypeOf('object')
    expect(Object.keys(FiberState).sort()).toEqual(['ACTIVE', 'DISPOSED', 'FAILED', 'LOADING', 'PENDING', 'UNLOADING'])
    for (const [name, value] of Object.entries(FiberState)) {
      expect(runtime[name], 'mirror mismatch for ' + name).toBe(value)
    }
    // 规格 01 §2：PENDING=0, LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5
    expect({ ...FiberState }).toEqual({ PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5 })
  })

  it('matches every runtime state reached by a real fiber (PENDING/LOADING/ACTIVE/FAILED/DISPOSED)', async () => {
    const root = new Context()
    const gate = deferred()
    const observed: number[] = []
    class Provider extends Service {
      constructor(ctx: Context) { super(ctx, 'k1Provider') }
      async [Service.init]() {
        observed.push(this.ctx.fiber.state)
        await gate.promise
      }
    }
    const consumer = root.inject(['k1Provider'], (ctx) => { observed.push(ctx.fiber.state) })
    const pending = (root as unknown as { registry: { values(): Iterable<{ fibers: Iterable<{ state: number }> }> } })
    expect([...pending.registry.values()].flatMap((batch) => [...batch.fibers]).some((f) => f.state === FiberState.PENDING))
      .toBe(true)
    const provider = root.use(Provider)
    await expect.poll(() => provider.state).toBe(FiberState.LOADING)
    gate.resolve()
    expect(await waitForActive(root, [provider, consumer])).toEqual({ success: true })
    expect(provider.state).toBe(FiberState.ACTIVE)
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(observed).toContain(FiberState.LOADING)

    class Broken extends Service {
      constructor(ctx: Context) { super(ctx, 'k1Broken') }
      [Service.init]() { throw new Error('boom') }
    }
    const broken = root.use(Broken)
    await expect(broken.await()).rejects.toThrow('boom')
    expect(broken.state).toBe(FiberState.FAILED)

    const disposal = provider.dispose()
    expect(provider.state).toBe(FiberState.UNLOADING)
    await disposal
    expect(provider.state).toBe(FiberState.DISPOSED)
    await broken.dispose()
    await consumer.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-2 依赖缺失
// ---------------------------------------------------------------------------

describe('K-2 依赖缺失', () => {
  it('keeps a dependent PENDING until the provider becomes ACTIVE', async () => {
    const root = new Context()
    const applied: string[] = []
    class Store extends Service {
      constructor(ctx: Context) { super(ctx, 'k2store') }
    }
    const consumer = root.inject(['k2store'], () => { applied.push('consumer') })
    await consumer
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(applied).toEqual([])
    expect(root.get('k2store')).toBeUndefined()

    const store = root.use(Store)
    expect(await waitForActive(root, [store, consumer])).toEqual({ success: true })
    expect(consumer.state).toBe(FiberState.ACTIVE)
    expect(applied).toEqual(['consumer'])
    expect(root.get('k2store')).toBeDefined()
    await consumer.dispose()
    await store.dispose()
  })

  it('stays PENDING when only one of two declared dependencies is available', async () => {
    const root = new Context()
    class A extends Service {
      constructor(ctx: Context) { super(ctx, 'k2a') }
    }
    const consumer = root.inject(['k2a', 'k2b'], () => undefined)
    root.use(A)
    await consumer
    expect(consumer.state).toBe(FiberState.PENDING)
    expect(await waitForActive(root, [consumer], { timeoutMs: 20 }))
      .toMatchObject({ success: false, pending: [expect.objectContaining({ state: FiberState.PENDING })] })
    await consumer.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-3 异步 init 门控
// ---------------------------------------------------------------------------

describe('K-3 异步 init 门控', () => {
  it('defers the dependent apply until the provider init resolves', async () => {
    const root = new Context()
    const order: string[] = []
    const slow = deferred()
    class Provider extends Service {
      constructor(ctx: Context) { super(ctx, 'k3') }
      async [Service.init]() {
        order.push('init:start')
        await slow.promise
        order.push('init:end')
      }
    }
    const ready = deferred()
    const consumer = root.inject(['k3'], (ctx) => {
      order.push('consumer:apply')
      expect(ctx.get('k3')).toBeInstanceOf(Provider)
      ready.resolve()
    })
    const provider = root.use(Provider)
    await expect.poll(() => provider.state).toBe(FiberState.LOADING)
    expect(order).toEqual(['init:start'])
    expect(consumer.state).toBe(FiberState.PENDING)

    slow.resolve()
    await ready.promise
    await consumer
    expect(order).toEqual(['init:start', 'init:end', 'consumer:apply'])
    expect(consumer.state).toBe(FiberState.ACTIVE)
    await consumer.dispose()
    await provider.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-4 卸载顺序
// ---------------------------------------------------------------------------

describe('K-4 卸载顺序', () => {
  it('unloads the consumer before the provider and runs effect disposers LIFO', async () => {
    const root = new Context()
    const order: string[] = []
    const blocked = deferred()
    class Provider extends Service {
      constructor(ctx: Context) { super(ctx, 'k4') }
      [Service.init]() {
        this.ctx.effect(function* () {
          yield () => { order.push('provider:1') }
          yield () => { order.push('provider:2') }
          yield () => { order.push('provider:3') }
        })
        this.ctx.effect(() => () => { order.push('provider:separate') })
      }
    }
    const provider = root.use(Provider)
    const consumer = root.inject(['k4'], (ctx) => {
      ctx.effect(() => async () => {
        order.push('consumer:start')
        await blocked.promise
        order.push('consumer:end')
      })
    })
    expect(await waitForActive(root, [provider, consumer])).toEqual({ success: true })

    const disposal = provider.dispose()
    await expect.poll(() => order).toEqual(['consumer:start'])
    blocked.resolve()
    await disposal
    expect(order).toEqual([
      'consumer:start', 'consumer:end',
      // 同一 Fiber 内后注册的 effect 先执行；generator 内的 disposer 亦为 LIFO
      'provider:separate', 'provider:3', 'provider:2', 'provider:1',
    ])
    expect(provider.state).toBe(FiberState.DISPOSED)
    await consumer.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-5 热更新拦截
// ---------------------------------------------------------------------------

describe('K-5 热更新拦截', () => {
  const Config = z.object({
    nested: z.object({ rate: z.number(), name: z.string().default('default') }),
    cold: z.string(),
  })
  type Config = z.output<typeof Config>

  function harness() {
    const root = new Context()
    const calls: string[] = []
    const plugin = {
      name: 'k5',
      Config,
      apply(ctx: Context, config: z.input<typeof Config>) {
        calls.push('init:' + config.nested.name)
        ctx.effect(() => () => { calls.push('dispose') })
        onHotUpdate<Config>(ctx, ['nested.rate', 'cold2'], (next) => { calls.push('hot:' + next.nested.rate) })
      },
    }
    return { root, calls, plugin }
  }

  it('applies hot key changes in place without disposing effects', async () => {
    const { root, calls, plugin } = harness()
    const fiber = root.use(plugin, { nested: { rate: 1 }, cold: 'a' })
    expect(await waitForActive(root, [fiber])).toEqual({ success: true })
    expect(calls).toEqual(['init:default'])

    await fiber.update({ nested: { rate: 2 }, cold: 'a' })
    expect(calls).toEqual(['init:default', 'hot:2'])
    expect(fiber.state).toBe(FiberState.ACTIVE)

    // 重复相同配置：既不热应用也不重启
    await fiber.update({ nested: { rate: 2 }, cold: 'a' })
    expect(calls).toEqual(['init:default', 'hot:2'])
    await fiber.dispose()
  })

  it('restarts the fiber when a cold key changes', async () => {
    const { root, calls, plugin } = harness()
    const fiber = root.use(plugin, { nested: { rate: 1 }, cold: 'a' })
    expect(await waitForActive(root, [fiber])).toEqual({ success: true })
    await fiber.update({ nested: { rate: 2, name: 'changed' }, cold: 'a' })
    expect(calls).toEqual(['init:default', 'dispose', 'init:changed'])
    await fiber.update({ nested: { rate: 2, name: 'changed' }, cold: 'b' })
    expect(calls).toEqual(['init:default', 'dispose', 'init:changed', 'dispose', 'init:changed'])
    await fiber.dispose()
  })

  it('keeps the fiber ACTIVE and the old config when validation fails', async () => {
    const { root, calls, plugin } = harness()
    const fiber = root.use(plugin, { nested: { rate: 1 }, cold: 'a' })
    expect(await waitForActive(root, [fiber])).toEqual({ success: true })
    expect(() => fiber.update({ nested: { rate: 'nope' }, cold: 'a' })).toThrow(ValidationError)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(calls).toEqual(['init:default'])
    await fiber.update({ nested: { rate: 3 }, cold: 'a' })
    expect(calls).toEqual(['init:default', 'hot:3'])
    await fiber.dispose()
  })

  it('accepts a Zod 4 schema as static Config on a Service (defaults + validation)', async () => {
    const root = new Context()
    const seen: unknown[] = []
    class Configured extends Service {
      static Config = z.object({
        rate: z.number().int().positive().default(7),
        label: z.string().default('a'),
      })
      constructor(ctx: Context, config: z.output<typeof Configured.Config>) {
        super(ctx, 'k5configured')
        seen.push(config)
      }
    }
    const good = root.use(Configured, { label: 'b' })
    await expect.poll(() => good.state).toBe(FiberState.ACTIVE)
    expect(seen[0]).toEqual({ rate: 7, label: 'b' })
    await good.update({ rate: 9, label: 'c' })
    await expect.poll(() => seen.length).toBe(2)
    expect(seen[1]).toEqual({ rate: 9, label: 'c' })
    await expect(async () => good.update({ rate: -1, label: 'c' })).rejects.toBeInstanceOf(ValidationError)
    expect(good.state).toBe(FiberState.ACTIVE)
    await good.dispose()
  })

  it('turns a failing re-init into FAILED without touching siblings', async () => {
    const root = new Context()
    let fail = false
    const calls: string[] = []
    const plugin = {
      name: 'k5-flaky',
      Config,
      apply(ctx: Context, config: z.input<typeof Config>) {
        calls.push('init:' + config.cold)
        ctx.effect(() => () => { calls.push('dispose') })
        if (fail) throw new Error('cold reload failed')
      },
    }
    const flaky = root.use(plugin, { nested: { rate: 1 }, cold: 'a' })
    const sibling = root.use(() => { calls.push('sibling') })
    expect(await waitForActive(root, [flaky, sibling])).toEqual({ success: true })
    fail = true
    await flaky.update({ nested: { rate: 1 }, cold: 'b' }).catch(() => undefined)
    await expect.poll(() => flaky.state).toBe(FiberState.FAILED)
    expect(sibling.state).toBe(FiberState.ACTIVE)
    expect(calls).toContain('dispose')
    await flaky.dispose()
    await sibling.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-6 故障隔离
// ---------------------------------------------------------------------------

describe('K-6 故障隔离', () => {
  it('fails only the broken fiber, keeps siblings ACTIVE and dependents PENDING', async () => {
    const root = new Context()
    class Broken extends Service {
      constructor(ctx: Context) { super(ctx, 'k6') }
      [Service.init]() { throw new Error('k6 init failure') }
    }
    const broken = root.use(Broken)
    const sibling = root.use(() => undefined)
    const dependent = root.inject(['k6'], () => undefined)
    const report = await waitForActive(root, [broken, sibling, dependent])
    expect(report).toMatchObject({
      success: false,
      failed: [expect.objectContaining({ state: FiberState.FAILED })],
      pending: [expect.objectContaining({ state: FiberState.PENDING })],
    })
    await sibling
    expect(sibling.state).toBe(FiberState.ACTIVE)
    expect(broken.state).toBe(FiberState.FAILED)
    expect(dependent.state).toBe(FiberState.PENDING)
    expect(root.get('k6')).toBeUndefined()
    await dependent.dispose()
    await sibling.dispose()
    await broken.dispose()
  })
})

// ---------------------------------------------------------------------------
// K-7 waitForActive
// ---------------------------------------------------------------------------

describe('K-7 waitForActive', () => {
  it('resolves success once every critical fiber is ACTIVE', async () => {
    const root = new Context()
    const fibers = [root.use(() => undefined), root.use(() => undefined)]
    expect(await waitForActive(root, fibers)).toEqual({ success: true })
    for (const fiber of fibers) await fiber.dispose()
  })

  it('returns the failure list immediately instead of waiting for the timeout', async () => {
    const root = new Context()
    class Broken extends Service {
      constructor(ctx: Context) { super(ctx, 'k7broken') }
      [Service.init]() { throw new Error('nope') }
    }
    const broken = root.use(Broken)
    await broken.await().catch(() => undefined)
    const start = Date.now()
    const report = await waitForActive(root, [broken], { timeoutMs: 10_000 })
    expect(Date.now() - start).toBeLessThan(1_000)
    expect(report).toMatchObject({ success: false, failed: [expect.objectContaining({ state: FiberState.FAILED })] })
    await broken.dispose()
  })

  it('returns pending names on timeout', async () => {
    const root = new Context()
    const start = Date.now()
    const report = await waitForActive(root, ['absent-plugin'], { timeoutMs: 40 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(30)
    expect(report).toEqual({ success: false, failed: [], pending: [{ name: 'absent-plugin', state: FiberState.PENDING }] })
  })

  it('resolves string names through the fiber registry', async () => {
    const root = new Context()
    const seen: string[] = []
    const plugin = {
      name: 'k7named',
      async apply() { await Promise.resolve(); seen.push('ready') },
    }
    const named = root.use(plugin)
    expect(await waitForActive(root, ['k7named'])).toEqual({ success: true })
    expect(seen).toEqual(['ready'])
    const report = await waitForActive(root, ['k7missing', 'k7named'], { timeoutMs: 20 })
    expect(report).toMatchObject({ success: false, pending: [expect.objectContaining({ name: 'k7missing' })] })
    await named.dispose()
    // 注销后同名再次等待必须超时而不是误报成功
    expect(await waitForActive(root, ['k7named'], { timeoutMs: 20 }))
      .toEqual({ success: false, failed: [], pending: [{ name: 'k7named', state: FiberState.PENDING }] })
  })
})

// ---------------------------------------------------------------------------
// K-8 safeOn 隔离
// ---------------------------------------------------------------------------

describe('K-8 safeOn 隔离', () => {
  const event = 'hub/config-rejected'

  it('keeps delivering to later listeners and never rethrows to the publisher', async () => {
    const root = new Context()
    const calls: string[] = []
    const fiber = root.use((ctx) => {
      safeOn(ctx, event, () => { throw new Error('sync listener failure') })
      safeOn(ctx, event, async () => { throw new Error('async listener failure') })
      safeOn(ctx, event, (section) => { calls.push('third:' + section) })
      safeOn(ctx, event, () => { calls.push('fourth') })
    })
    await fiber
    expect(() => root.emit(event, 'test', 'boom')).not.toThrow()
    await expect.poll(() => listenerFailureCount(fiber.ctx)).toBe(2)
    expect(calls).toEqual(['third:test', 'fourth'])
    expect(() => root.emit(event, 'again', 'boom')).not.toThrow()
    expect(calls).toEqual(['third:test', 'fourth', 'third:again', 'fourth'])
    await expect.poll(() => listenerFailureCount(fiber.ctx)).toBe(4)
    await fiber.dispose()
  })

  it('unbinds listeners on dispose', async () => {
    const root = new Context()
    const calls: string[] = []
    const fiber = root.use((ctx) => { safeOn(ctx, event, (section) => { calls.push(section) }) })
    await fiber
    root.emit(event, 'before', 'x')
    await fiber.dispose()
    root.emit(event, 'after', 'x')
    expect(calls).toEqual(['before'])
  })

  it('counts guarded async failures without leaking unhandled rejections', async () => {
    const root = new Context()
    const fiber = root.use(() => undefined)
    await fiber
    await expect(guardAsync(fiber.ctx, Promise.reject(new Error('task failed')), 'task')).resolves.toBeUndefined()
    expect(listenerFailureCount(fiber.ctx)).toBe(1)
    await expect(guardAsync(fiber.ctx, Promise.resolve(7), 'ok')).resolves.toBe(7)
    expect(listenerFailureCount(fiber.ctx)).toBe(1)
    await fiber.dispose()
  })
})

// ---------------------------------------------------------------------------
// supervisor（01 §8 非关键插件退避重启）
// ---------------------------------------------------------------------------

describe('supervisor 退避重启', () => {
  it('restarts a FAILED fiber, reports degraded then recovered, and stops when disposed', async () => {
    const root = new Context()
    let attempts = 0
    class Flaky extends Service {
      constructor(ctx: Context) { super(ctx, 'supervised') }
      [Service.init]() {
        attempts++
        if (attempts <= 2) throw new Error('attempt ' + attempts)
      }
    }
    const flaky = root.use(Flaky)
    await flaky.await().catch(() => undefined)
    expect(flaky.state).toBe(FiberState.FAILED)

    const degraded: boolean[] = []
    const stop = supervise(root, [flaky], {
      baseMs: 5, maxMs: 20, onDegraded: (_fiber, value) => { degraded.push(value) },
    })
    try {
      await expect.poll(() => flaky.state, { timeout: 2_000 }).toBe(FiberState.ACTIVE)
      expect(attempts).toBe(3)
      expect(degraded[0]).toBe(true)
      expect(degraded.at(-1)).toBe(false)
    } finally {
      stop()
      await flaky.dispose()
    }
  })
})
