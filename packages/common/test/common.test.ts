import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { backoff, createRedactor, createUlidGenerator, FakeClock, KeyedMutex, Lru, NdjsonLineSplitter, redact, stableHash, TokenBucket } from '../src/index.js'

it('masks documented credentials while preserving surrounding structure', () => {
  const a = 'a'.repeat(60)
  const keys = [
    'sk-ant-' + a, 'sk-proj-' + a, 'AIza' + a.slice(0, 35), 'ghp_' + a,
    'github_pat_' + a, 'xoxb-' + a, 'AKIA' + 'A'.repeat(16),
    'eyJ' + a + '.eyJ' + a + '.' + a,
  ]
  for (const key of keys) expect(redact(key)).toBe('[REDACTED]')
  expect(redact('aws_secret_access_key: "x"')).toBe('aws_secret_access_key: "[REDACTED]"')
  expect(redact('app_secret=' + a)).toBe('app_secret=[REDACTED]')
  expect(redact('tenant_access_token=' + a)).toBe('tenant_access_token=[REDACTED]')
  expect(redact('postgres://name:example@localhost password=12345678')).toBe('postgres://name:[REDACTED]@localhost password=[REDACTED]')
  expect(redact('token=local.se-cret', { TEST_KEY: 'local.se-cret' })).toBe('token=[REDACTED:TEST_KEY]')
  expect(redact('0f44cb17-d588-4f75-80bc-cb74a6dd76e6')).toBe('0f44cb17-d588-4f75-80bc-cb74a6dd76e6')
})

it('masks private keys across newlines and across per-stream calls', () => {
  const start = '-----BEGIN OPENSSH PRIVATE KEY-----'
  const end = '-----END OPENSSH PRIVATE KEY-----'
  expect(redact(`before ${start}\npart\n${end} after`)).toBe('before [REDACTED] after')
  const line = createRedactor()
  expect(line(start)).toBe('[REDACTED]')
  expect(line('key body')).toBe('')
  expect(line(end + ' after')).toBe(' after')
  expect(redact(start)).toBe('[REDACTED]')
  expect(redact('other source')).toBe('other source')
})

it('redacts pathological strings without quadratic backtracking', () => {
  const samples = [
    'postgres://user:'.repeat(6400), 'sk-proj-' + 'a'.repeat(100 * 1024),
    '-----BEGIN ' + ' '.repeat(100 * 1024), 'password' + ' '.repeat(100 * 1024),
    'eyJ'.repeat(34_000), 'eyJ' + 'a'.repeat(100 * 1024) + '.', 'github_pat_' + '_'.repeat(100 * 1024),
  ]
  for (const text of samples) {
    const now = performance.now()
    redact(text)
    expect(performance.now() - now).toBeLessThan(50)
  }
})

it('splits UTF-8 and CRLF across chunks and caps each line by bytes', () => {
  const splitter = new NdjsonLineSplitter(6)
  const first = Buffer.from('中😀\r\nsecond-long\r\n尾')
  const result = [...first].flatMap((byte) => splitter.push(Uint8Array.of(byte))).concat(splitter.finish())
  expect(result).toEqual([
    { text: '中…[truncated 4 bytes]', truncatedBytes: 4 },
    { text: 'second…[truncated 5 bytes]', truncatedBytes: 5 },
    { text: '尾' },
  ])
})

it('provides deterministic time, safe lock release, LRU, token refill and stable hashes', async () => {
  const clock = new FakeClock(100)
  const callTimes: number[] = []
  const stop = clock.setInterval(() => callTimes.push(clock.now()), 5)
  const bucket = new TokenBucket(100, 1, clock)
  const cache = new Lru<string, number>(2, 15, clock)
  cache.set('a', 1).set('b', 2)
  expect(cache.get('a')).toBe(1)
  cache.set('c', 3)
  expect(cache.has('b')).toBe(false)
  expect(bucket.take()).toBe(true)
  expect(bucket.take()).toBe(false)
  clock.advance(10)
  expect(bucket.take()).toBe(true)
  expect(callTimes).toEqual([105, 110])
  stop()
  clock.advance(5)
  expect(cache.size).toBe(0)
  const mutex = new KeyedMutex()
  const first = mutex.runExclusive('k', async () => { throw new Error('fail') })
  const second = mutex.runExclusive('k', () => 'next')
  await expect(first).rejects.toThrow('fail')
  await expect(second).resolves.toBe('next')
  expect(mutex.size).toBe(0)
  expect(backoff(10, { random: () => 0 })).toBe(15_000)
  expect(stableHash({ b: [1, 2], a: 1 })).toBe(stableHash({ a: 1, b: [1, 2] }))
  const ulid = createUlidGenerator()
  expect(ulid(50) < ulid(49)).toBe(true)
})
