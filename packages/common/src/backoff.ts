export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  jitterMin?: number
  random?: () => number
}

export function backoff(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 1_000, maxMs = 30_000, jitterMin = 0.5, random = Math.random } = options
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RangeError('invalid backoff attempt')
  if (!(baseMs > 0 && Number.isFinite(baseMs) && maxMs > 0 && Number.isFinite(maxMs) && jitterMin >= 0 && jitterMin <= 1)) {
    throw new RangeError('invalid backoff options')
  }
  return Math.floor(Math.min(maxMs, baseMs * 2 ** attempt) * (jitterMin + random() * (1 - jitterMin)))
}
