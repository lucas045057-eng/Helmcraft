import { Context, Service, ValidationError } from 'cordis'
import { describe, expect, it } from 'vitest'
import { FiberState, guardAsync, listenerFailureCount, onHotUpdate, safeOn, supervise, waitForActive } from '../src/index.js'
import { z } from 'zod'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Cordis rc.13 kernel contracts', () => {
  it('K-1, K-2, K-3: awaits a provider init before activating dependents and observes every state', async () => {
    const ctx = new Context()
    const init = deferred()
    const stopped = deferred()
    const consumer = ctx.inject(['spikeProvider'], () => undefined)
    class Provider extends Service {
      constructor(context: Context) { super(context, 'spikeProvider') }
      async [Service.init]() {
        await init.promise
        this.ctx.effect(() => () => stopped.promise)
      }
    }
    await consumer
    expect(consumer.state).toBe(FiberState.PENDING)
    const provider = ctx.use(Provider)
    expect(provider.state).toBe(FiberState.LOADING)
    const ready = waitForActive(ctx, [provider, consumer])
    expect(consumer.state).toBe(FiberState.PENDING)
    init.resolve()
    expect(await ready).toEqual({ success: true })
    expect(consumer.state).toBe(FiberState.ACTIVE)
    const disposing = provider.dispose()
    expect(provider.state).toBe(FiberState.UNLOADING)
    stopped.resolve()
    await disposing
    expect(provider.state).toBe(FiberState.DISPOSED)
    expect(consumer.state).toBe(FiberState.PENDING)
    await consumer.dispose()
  })

  it('K-4: awaits dependent disposal and runs disposers within a generator in LIFO order', async () => {
    const root = new Context()
    const order: string[] = []
    const pending = deferred()
    class Provider extends Service {
      constructor(ctx: Context) { super(ctx, 'teardown') }
      [Service.init]() {
        this.ctx.effect(function* () {
          yield () => { order.push('provider:first') }
          yield () => { order.push('provider:last') }
        })
      }
    }
    const provider = root.use(Provider)
    const consumer = root.inject(['teardown'], (ctx) => {
      ctx.effect(() => async () => {
        order.push('consumer:start')
        await pending.promise
        order.push('consumer:end')
      })
    })
    await waitForActive(root, [provider, consumer])
    const disposal = provider.dispose()
    await expect.poll(() => order).toEqual(['consumer:start'])
    pending.resolve()
    await disposal
    expect(order).toEqual(['consumer:start', 'consumer:end', 'provider:last', 'provider:first'])
    await consumer.dispose()
  })

  it('observes separately registered asynchronous effects starting in reverse order and running concurrently', async () => {
    const root = new Context()
    const order: string[] = []
    const pending = deferred()
    const fiber = root.use((ctx) => {
      ctx.effect(() => () => { order.push('first') })
      ctx.effect(() => async () => {
        order.push('last:start')
        await pending.promise
        order.push('last:end')
      })
    })
    await fiber
    const disposal = fiber.dispose()
    await expect.poll(() => order).toEqual(['last:start', 'first'])
    pending.resolve()
    await disposal
    expect(order).toEqual(['last:start', 'first', 'last:end'])
  })

  it('K-5: uses Zod 4 Standard Schema defaults; hot updates stay in place, cold updates reload', async () => {
    const root = new Context()
    const calls: string[] = []
    const Config = z.object({ nested: z.object({ rate: z.number(), name: z.string().default('default') }), cold: z.string() })
    type Config = z.output<typeof Config>
    const plugin = {
      name: 'spike-config',
      Config,
      apply(ctx: Context, config: z.input<typeof Config>) {
        calls.push('init:' + config.nested.name)
        ctx.effect(() => () => { calls.push('dispose') })
        onHotUpdate<Config>(ctx, ['nested.rate'], (next) => { calls.push('hot:' + next.nested.rate) })
      },
    }
    const fiber = root.use(plugin, { nested: { rate: 1 }, cold: 'a' })
    await fiber.update({ nested: { rate: 1 }, cold: 'a' })
    expect(await waitForActive(root, [fiber])).toEqual({ success: true })
    await fiber.update({ nested: { rate: 2 }, cold: 'a' })
    expect(calls).toEqual(['init:default', 'hot:2'])
    expect(() => fiber.update({ nested: { rate: 'no' }, cold: 'a' })).toThrow(ValidationError)
    expect(fiber.state).toBe(FiberState.ACTIVE)
    await fiber.update({ nested: { rate: 2, name: 'new' }, cold: 'b' })
    expect(calls).toEqual(['init:default', 'hot:2', 'dispose', 'init:new'])
    await fiber.dispose()

    const invalid = root.use(plugin, { nested: { rate: Number.NaN }, cold: 'a' })
    await expect(invalid.await()).rejects.toBeInstanceOf(ValidationError)
    expect(invalid.state).toBe(FiberState.FAILED)
    await invalid.dispose()
  })

  it('K-6, K-7: isolates a failed init, reports pending and recovers through supervisor', async () => {
    const root = new Context()
    let attempts = 0
    class Provider extends Service {
      constructor(ctx: Context) { super(ctx, 'flaky') }
      [Service.init]() {
        if (++attempts <= 2) throw new Error('first two runs fail')
      }
    }
    const bad = root.use(Provider)
    const good = root.use(() => undefined)
    const dependent = root.inject(['flaky'], () => undefined)
    const report = await waitForActive(root, [bad, good, dependent])
    expect(report).toMatchObject({ success: false, failed: [{ state: FiberState.FAILED }] })
    await good
    expect(good.state).toBe(FiberState.ACTIVE)
    expect(dependent.state).toBe(FiberState.PENDING)
    await expect(bad.restart()).rejects.toThrow('first two runs fail')
    expect(attempts).toBe(1)
    expect(await waitForActive(root, ['missing'], { timeoutMs: 5 })).toEqual({
      success: false, failed: [], pending: [{ name: 'missing', state: FiberState.PENDING }],
    })
    const stop = supervise(root, [bad], { baseMs: 5, maxMs: 20 })
    try {
      expect(await waitForActive(root, [dependent], { timeoutMs: 2_000 })).toEqual({ success: true })
      expect(attempts).toBe(3)
    } finally {
      stop()
      await dependent.dispose()
      await bad.dispose()
      await good.dispose()
    }
  })

  it('K-8: isolates sync and async listener failures and unregisters upon disposal', async () => {
    const root = new Context()
    const event = 'hub/config-rejected'
    const calls: string[] = []
    const fiber = root.use((ctx) => {
      safeOn(ctx, event, () => { throw new Error('sync') })
      safeOn(ctx, event, async () => { throw new Error('async') })
      safeOn(ctx, event, (section) => { calls.push(section) })
    })
    await fiber
    expect(() => root.emit(event, 'test', 'error')).not.toThrow()
    await expect.poll(() => listenerFailureCount(fiber.ctx)).toBe(2)
    expect(await guardAsync(fiber.ctx, Promise.reject(new Error('task')), 'task')).toBeUndefined()
    expect(listenerFailureCount(fiber.ctx)).toBe(3)
    await fiber.dispose()
    root.emit(event, 'ignored', 'error')
    expect(calls).toEqual(['test'])
  })
})
