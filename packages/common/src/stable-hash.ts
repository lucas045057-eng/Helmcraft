import { createHash } from 'node:crypto'

function canonical(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new TypeError('cannot hash circular JSON')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry: unknown) => canonical(entry, ancestors))
    const record = value as Record<string, unknown>
    if (typeof record.toJSON === 'function') return canonical(record.toJSON(), ancestors)
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key], ancestors)]))
  } finally {
    ancestors.delete(value)
  }
}

export function stableHash(value: unknown): string {
  const json = JSON.stringify(canonical(value, new Set()))
  if (json === undefined) throw new TypeError('value has no JSON representation')
  return createHash('sha256').update(json).digest('hex')
}
