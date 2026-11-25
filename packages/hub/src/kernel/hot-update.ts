import { isDeepStrictEqual } from 'node:util'
import type { Context } from 'cordis'

function withoutHotKeys(config: object, hotKeys: readonly string[]): unknown {
  const cold = structuredClone(config) as Record<string, unknown>
  for (const key of hotKeys) {
    const parts = key.split('.')
    const leaf = parts.pop()!
    let parent: Record<string, unknown> | undefined = cold
    for (const part of parts) {
      const child: unknown = parent && Object.hasOwn(parent, part) ? parent[part] : undefined
      if (child === null || typeof child !== 'object' || Array.isArray(child)) {
        parent = undefined
        break
      }
      parent = child as Record<string, unknown>
    }
    if (parent) delete parent[leaf]
  }
  return cold
}

export function onHotUpdate<C extends object>(
  ctx: Context, hotKeys: readonly (keyof C | string)[], apply: (config: C) => void,
): void {
  const fiber = ctx.fiber
  let previous = ctx.waterfall('internal/config', fiber, () => fiber.config) as C
  const keys = hotKeys.map(String)
  ctx.on('internal/update', (value: C, next) => {
    if (isDeepStrictEqual(previous, value)) return
    if (!isDeepStrictEqual(withoutHotKeys(previous, keys), withoutHotKeys(value, keys))) return next()
    apply(value)
    previous = value
  })
}
