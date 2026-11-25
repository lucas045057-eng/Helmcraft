import type { Context, Fiber } from 'cordis'
import { backoff } from '@agent-hub/common/backoff'
import { FiberState } from './fiber-state.js'
import { guardAsync, safeOn } from './safe.js'

interface RestartState {
  attempt: number
  timer?: ReturnType<typeof setTimeout>
  restarting: boolean
}

export function supervise(ctx: Context, fibers: Iterable<Fiber>, options: {
  baseMs?: number
  maxMs?: number
  onDegraded?: (fiber: Fiber, degraded: boolean) => void
} = {}): () => void {
  const { baseMs = 5_000, maxMs = 300_000, onDegraded } = options
  const states = new Map<Fiber, RestartState>()
  for (const fiber of fibers) states.set(fiber.ctx.fiber, { attempt: 0, restarting: false })
  let disposed = false

  function schedule(fiber: Fiber, state: RestartState): void {
    if (disposed || state.timer || state.restarting) return
    const delay = backoff(state.attempt++, { baseMs, maxMs, jitterMin: 1 })
    state.timer = setTimeout(() => {
      delete state.timer
      if (disposed || fiber.state !== FiberState.FAILED) return
      state.restarting = true
      // rc.13 restart() leaves the failure latched; update() clears it before restarting.
      void guardAsync(ctx, Promise.resolve().then(() => fiber.update(fiber.config, true)), 'restart ' + fiber.name)
        .finally(() => {
          state.restarting = false
          if (fiber.state === FiberState.FAILED) schedule(fiber, state)
        })
    }, delay)
  }

  const detach = safeOn(ctx, 'internal/status', (fiber) => {
    const state = states.get(fiber)
    if (!state) return
    if (fiber.state === FiberState.FAILED) {
      schedule(fiber, state)
      onDegraded?.(fiber, true)
    } else if (fiber.state === FiberState.ACTIVE || fiber.state === FiberState.DISPOSED) {
      clearTimeout(state.timer)
      delete state.timer
      state.attempt = 0
      if (fiber.state === FiberState.ACTIVE) onDegraded?.(fiber, false)
    }
  }, { global: true })
  for (const [fiber, state] of states) {
    if (fiber.state === FiberState.FAILED) {
      schedule(fiber, state)
      onDegraded?.(fiber, true)
    }
  }
  const stop = () => {
    disposed = true
    detach()
    for (const state of states.values()) clearTimeout(state.timer)
  }
  ctx.effect(() => stop, 'supervisor')
  return stop
}
