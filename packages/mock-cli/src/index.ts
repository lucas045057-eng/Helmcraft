#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath, rm, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, win32 } from 'node:path'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const mib = 1024 * 1024
const treeLifetimeMs = 60_000

async function output(data: string | Uint8Array): Promise<void> {
  if (!process.stdout.write(data)) await once(process.stdout, 'drain')
}

function event(data: object): Promise<void> {
  return output(JSON.stringify(data) + '\n')
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError('Expected integer between ' + min + ' and ' + max)
  }
  return number
}

function launch(args: string[]) {
  return spawn(process.execPath, [script, ...args], {
    shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  })
}

async function tree(depth: number, width: number): Promise<void> {
  await event({ type: 'pid', pid: process.pid, ppid: process.ppid })
  const children = depth <= 1 ? [] : Array.from({ length: width }, () =>
    launch(['--tree-child', String(depth - 1), String(width)]))
  if (!children.length) {
    await sleep(treeLifetimeMs)
    return
  }
  await Promise.all(children.map((child) => once(child, 'exit')))
}

async function orphanParent(): Promise<void> {
  const child = spawn(process.execPath, [script, '--orphan-leaf'], {
    detached: true, shell: false, windowsHide: true, stdio: 'ignore',
  })
  await once(child, 'spawn')
  process.send?.({ type: 'pid', pid: child.pid, ppid: process.pid })
  child.unref()
  process.disconnect?.()
}

function parse(line: string | undefined) {
  const marker = /^#scenario:\s*(\S+)(.*)$/u.exec(line ?? '')
  const name = marker?.[1] ?? 'success'
  const params = new Map<string, string>()
  for (const setting of (marker?.[2] ?? '').trim().split(/\s+/u).filter(Boolean)) {
    const split = setting.indexOf('=')
    if (split < 1) throw new Error('Expected scenario parameter k=v')
    params.set(setting.slice(0, split), setting.slice(split + 1))
  }
  return { name, params }
}

async function run(name: string, params: Map<string, string>, readInput: () => Promise<string | undefined>): Promise<void> {
  const option = (key: string, fallback: number, min: number, max: number) =>
    integer(params.get(key), fallback, min, max)
  switch (name) {
    case 'success': {
      const count = option('n', option('lines', 5, 1, 100_000), 1, 100_000)
      await event({ type: 'init', model: 'mock' })
      await event({ type: 'session', cliSessionId: params.get('session') ?? 'mock-session' })
      for (let i = 1; i <= count; i++) {
        await event({ type: 'message', role: 'assistant', text: 'Mock response ' + i, final: i === count })
      }
      return
    }
    case 'fail':
      await event({ type: 'error', message: 'Mock failure', fatal: true })
      process.exitCode = option('code', 1, 1, 255)
      return
    case 'slow': {
      const ms = option('ms', 5_000, 0, 3_600_000)
      for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
        await event({ type: 'progress', phase: 'slow', detail: String(elapsed) })
        await sleep(Math.min(1_000, ms - elapsed))
      }
      return
    }
    case 'flood': {
      const bytes = option('mb', 8, 1, 1_024) * mib
      const lineSize = option('line', 1_024, 2, 64 * mib)
      const line = 'x'.repeat(lineSize - 1) + '\n'
      for (let remaining = bytes; remaining > 0; remaining -= lineSize) {
        await output(remaining >= lineSize ? line : line.slice(0, remaining - 1) + '\n')
      }
      return
    }
    case 'huge-line':
      await output('x'.repeat(option('bytes', mib, 1, 100 * mib)) + '\n')
      return
    case 'malformed':
      await event({ type: 'init', model: 'mock' })
      await output('not JSON\n{"unterminated":\n')
      await output(Buffer.from([0x00, 0xff, 0xfe, 0x0a]))
      await event({ type: 'future_event' })
      return
    case 'need-input': {
      await event({ type: 'input_request', requestId: 'mock-input', question: 'Continue?', options: ['yes', 'no'] })
      const answer = await readInput()
      if (answer === undefined) {
        await event({ type: 'error', message: 'Input ended before an answer arrived', fatal: true })
        process.exitCode = 1
      } else {
        await event({ type: 'message', role: 'assistant', text: answer.startsWith('\x1e') ? Buffer.from(answer.slice(1), 'base64url').toString('utf8') : answer, final: true })
      }
      return
    }
    case 'ignore-sigterm':
      for (const signal of ['SIGTERM', 'SIGINT', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])]) {
        process.on(signal as NodeJS.Signals, () => undefined)
      }
      await event({ type: 'pid', pid: process.pid, ppid: process.ppid })
      await sleep(option('ms', treeLifetimeMs, 1, 3_600_000))
      return
    case 'spawn-tree': {
      const depth = option('depth', 3, 1, 8)
      const width = option('width', 2, 1, 8)
      const count = width === 1 ? depth : (width ** depth - 1) / (width - 1)
      if (count > 128) throw new RangeError('Mock tree may contain at most 128 processes')
      await tree(depth, width)
      return
    }
    case 'orphan': {
      const child = spawn(process.execPath, [script, '--orphan-parent'], {
        detached: true, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
      const [pidEvent] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error('Mock orphan launcher exited before reporting its child') }),
      ])
      await event(pidEvent as object)
      return
    }
    case 'secrets': {
      const fake = 'A'.repeat(60)
      await output([
        'sk-ant-' + fake, 'sk-proj-' + fake, 'AIza' + fake.slice(0, 35),
        'ghp_' + fake, 'github_pat_' + fake, 'xoxb-' + fake,
        'AKIA' + fake.slice(0, 16), 'aws_secret_access_key=' + fake,
        'app_secret: ' + fake, 'tenant_access_token=' + fake,
        'eyJ' + fake + '.eyJ' + fake + '.' + fake,
        '-----BEGIN PRIVATE KEY-----', fake, '-----END PRIVATE KEY-----',
        'password=mock-fake-value', 'postgres://mock:fake-db-pass@localhost/db',
      ].join('\n') + '\n')
      return
    }
    case 'unicode': {
      const bytes = Buffer.from('中文 😀\r\n再见 🌍\n')
      for (const byte of bytes) {
        await output(Uint8Array.of(byte))
        await sleep(2)
      }
      return
    }
    case 'crash':
      await event({ type: 'message', role: 'assistant', text: 'Before abort', final: false })
      // The write callback confirms the pipe write before abort, including on Windows.
      await new Promise<void>((resolve, reject) => {
        process.stdout.write('', (error) => error ? reject(error) : resolve())
      })
      process.abort()
      return
    case 'idle':
      await sleep(option('ms', 30_000, 0, 3_600_000))
      return
    default:
      throw new Error('Unknown mock scenario: ' + name)
  }
}

async function sandboxPath(root: string, value: unknown, allowLeafLink = false) {
  if (typeof value !== 'string' || win32.isAbsolute(value) || /[<>:"|?*]/u.test(value) || Array.from(value).some(c => c.charCodeAt(0) < 32)) throw new Error('Invalid fs path')
  const parts = value.split(/[\\/]/u).filter(part => part && part !== '.')
  if (!parts.length) throw new Error('Expected a path below cwd')
  let path = root
  for (const [index, part] of parts.entries()) {
    if (part === '..' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]*\.|$)/iu.test(part)) throw new Error('Invalid fs path')
    path = join(path, part)
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (stat?.isSymbolicLink() && !(allowLeafLink && index === parts.length - 1)) throw new Error('Link in fs path')
  }
  return path
}

async function fsScenario(encoded: string) {
  const ops: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (!Array.isArray(ops)) throw new Error('Expected fs operations')
  const root = await realpath(process.cwd())
  for (const op of ops) {
    const path = await sandboxPath(root, op.path, op.op === 'delete')
    switch (op.op) {
      case 'mkdir': await mkdir(path, { recursive: true }); break
      case 'delete': await rm(path, { recursive: true, force: true }); break
      case 'write': {
        if (typeof op.content !== 'string') throw new Error('Expected fs write content')
        const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0))
        try {
          const stat = await fd.stat({ bigint: true })
          const current = await lstat(await sandboxPath(root, op.path), { bigint: true })
          if (!stat.isFile() || stat.nlink !== 1n || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Unsafe fs write')
          await fd.truncate(0)
          await fd.writeFile(op.content)
        } finally { await fd.close() }
        break
      }
      case 'symlink': {
        const target = await sandboxPath(root, op.target)
        const directory = (await lstat(target)).isDirectory()
        await symlink(target, path, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
        break
      }
      default: throw new Error('Unknown fs operation')
    }
  }
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case '--version':
      console.log('0.1.0')
      return
    case '--tree-child':
      return tree(Number(process.argv[3]), Number(process.argv[4]))
    case '--orphan-parent':
      return orphanParent()
    case '--orphan-leaf':
      return sleep(treeLifetimeMs)
  }

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const lines = reader[Symbol.asyncIterator]()
  const first = await lines.next()
  try {
    const { name, params } = parse(first.value)
    if (process.argv[2] === '--resume' && process.argv[3]) params.set('session', process.argv[3])
    const hx = params.get('hx')
    const harness = !!hx && /^[A-Za-z0-9_-]{22}$/u.test(hx)
    const block: string[] = []
    if (harness) {
      for (;;) {
        const next = await lines.next()
        if (next.done) throw new Error('harness block not terminated')
        block.push(next.value)
        if (next.value === '</task id="' + hx + '">') break
      }
    }
    const mode = /^<agent_hub_harness version="1" mode="([^"]+)"/u.exec(block[0] ?? '')?.[1] ?? null
    if (name === 'echo-harness') {
      const bytes = Buffer.from([first.value ?? '', ...block, ''].join('\n'))
      const taskStart = block.indexOf('<task id="' + hx + '">')
      const summary = { hx: harness, mode, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        blocks: { preamble: mode !== null, facts: block.includes('<verified_facts id="' + hx + '">'),
          board: block.flatMap(line => /^<blackboard file="\.board\/([^"]+)"/u.exec(line)?.slice(1) ?? []),
          bootstrap: block.includes('<blackboard_bootstrap id="' + hx + '">') },
        task: taskStart < 0 ? '' : block.slice(taskStart + 1, -1).join('\n').slice(0, 200) }
      await event({ type: 'session', cliSessionId: params.get('session') ?? 'mock-session' })
      await event({ type: 'message', role: 'assistant', text: JSON.stringify(summary), final: true })
      return
    }
    if (name === 'fs') {
      await fsScenario(params.get(mode === 'autofix' ? 'fixOps' : 'ops') ?? 'W10')
      await event({ type: 'message', role: 'assistant', text: 'fs operations complete', final: true })
      return
    }
    if (name !== 'need-input') {
      reader.close()
      process.stdin.destroy()
    }
    await run(name, params, async () => (await lines.next()).value)
  } finally {
    reader.close()
    process.stdin.destroy()
  }
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
