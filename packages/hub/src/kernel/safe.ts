import type { Context, EventOptions, Events, Fiber } from 'cordis'
import { redact } from '@agent-hub/common/redact'

const failures = new WeakMap<Fiber, number>()

export function listenerFailureCount(ctx: Context): number {
  return failures.get(ctx.fiber) ?? 0
}

function report(ctx: Context, label: string, error: unknown): void {
  failures.set(ctx.fiber, listenerFailureCount(ctx) + 1)
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Non-Error rejection'
  ctx.logger.error('%s: %s', label, redact(message))
}

export async function guardAsync<T>(ctx: Context, promise: PromiseLike<T>, label: string): Promise<T | undefined> {
  try {
    return await promise
  } catch (error) {
    report(ctx, label, error)
    return undefined
  }
}

export function safeOn<K extends keyof Events>(
  ctx: Context, event: K, listener: Events[K], options?: boolean | EventOptions,
): () => boolean {
  const label = String(event)
  const wrapped = function (this: unknown, ...args: Parameters<Events[K]>): unknown {
    try {
      const result: unknown = Reflect.apply(listener, this, args)
      if ((typeof result === 'object' && result !== null || typeof result === 'function') && 'then' in result) {
        return guardAsync(ctx, Promise.resolve(result), label)
      }
      return result
    } catch (error) {
      report(ctx, label, error)
      return undefined
    }
  }
  return ctx.on(event, wrapped as Events[K], options)
}
