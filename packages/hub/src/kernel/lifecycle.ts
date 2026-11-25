import type { Context, Fiber } from 'cordis'
import { FiberState } from './fiber-state.js'

interface FiberStatus {
  name: string
  state: number
}

export type Readiness =
  | { success: true }
  | { success: false; failed: FiberStatus[]; pending: FiberStatus[] }

function below(fiber: Fiber, ancestor: Fiber): boolean {
  for (let current = fiber; ; current = current.parent.fiber) {
    if (current === ancestor) return true
    if (current === current.parent.fiber) return false
  }
}

export function waitForActive(
  ctx: Context, critical: Iterable<string | Fiber>, { timeoutMs = 30_000 } = {},
): Promise<Readiness> {
  const targets = [...critical]
  return new Promise((resolve) => {
    const inspect = () => {
      const candidates = [...ctx.registry.values()].flatMap((runtime) => [...runtime.fibers])
        .filter((fiber) => below(fiber, ctx.fiber))
      const failed: FiberStatus[] = []
      const pending: FiberStatus[] = []
      for (const target of targets) {
        const name = typeof target === 'string' ? target : target.name
        const fibers = typeof target === 'string' ? candidates.filter((fiber) => fiber.name === name) : [target]
        if (!fibers.length) pending.push({ name, state: FiberState.PENDING })
        for (const { state } of fibers) {
          if (state === FiberState.FAILED || state === FiberState.DISPOSED) failed.push({ name, state })
          else if (state !== FiberState.ACTIVE) pending.push({ name, state })
        }
      }
      return { failed, pending }
    }
    const finish = (readiness: Readiness) => {
      clearTimeout(timer)
      detach()
      resolve(readiness)
    }
    const check = () => {
      const { failed, pending } = inspect()
      if (failed.length) finish({ success: false, failed, pending })
      else if (!pending.length) finish({ success: true })
    }
    const detach = ctx.on('internal/status', check, { global: true })
    const timer = setTimeout(() => finish({ success: false, ...inspect() }), timeoutMs)
    check()
  })
}

export function describeFibers(ctx: Context) {
  return [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).map(fiber => ({
    name: fiber.name,
    state: Object.keys(FiberState).find(key => FiberState[key as keyof typeof FiberState] === fiber.state) ?? 'UNKNOWN',
  }))
}

