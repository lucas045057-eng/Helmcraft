import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const bin = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const run = (scenario: string) => spawnSync(process.execPath, [bin], {
  input: '#scenario: ' + scenario + '\n',
  windowsHide: true, shell: false, timeout: 4_000, maxBuffer: 2 * 1024 * 1024,
})

it('implements success, failure, slow output, flood and huge line', () => {
  const success = run('success n=3')
  expect(success.status).toBe(0)
  expect(success.stdout.toString()).toContain('"final":true')
  expect(run('fail code=42').status).toBe(42)
  expect(run('slow ms=5').stdout.toString()).toContain('"phase":"slow"')
  expect(run('flood mb=1 line=257').stdout.length).toBe(1024 * 1024)
  expect(run('huge-line bytes=17000').stdout.length).toBe(17001)
})

it('preserves malformed bytes, emits fake secrets and writes Unicode', () => {
  expect(run('malformed').stdout.includes(Buffer.from([0, 255, 254]))).toBe(true)
  expect(run('secrets').stdout.toString()).toContain('-----BEGIN PRIVATE KEY-----')
  expect(run('unicode').stdout.toString()).toBe('中文 😀\r\n再见 🌍\n')
})

it('supports live input, idle silence, and abnormal termination', async () => {
  const child = spawn(process.execPath, [bin], { shell: false, windowsHide: true })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  try {
    child.stdin.write('#scenario: need-input\n')
    expect(JSON.parse((await lines.next()).value).type).toBe('input_request')
    child.stdin.end('yes\n')
    expect(JSON.parse((await lines.next()).value).text).toBe('yes')
    expect(await exited).toEqual([0, null])
  } finally {
    if (child.exitCode === null) child.kill()
  }
  expect(run('idle ms=20').stdout.length).toBe(0)
  const crash = run('crash')
  expect(crash.stdout.toString()).toContain('Before abort')
  expect(crash.status).not.toBe(0)
}, 10_000)
