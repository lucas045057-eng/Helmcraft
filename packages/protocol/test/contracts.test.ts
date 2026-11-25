import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as protocol from '../src/index.js'

const worker = z.union([protocol.HubToWorkerFrame, protocol.WorkerToHubFrame])
const exportsByName = protocol as Record<string, unknown>

for (const domain of ['worker', 'dashboard', 'feishu']) {
  describe(domain + ' JSON fixtures', () => {
    for (const valid of [true, false]) {
      const directory = new URL('../fixtures/' + domain + '/' + (valid ? 'valid' : 'invalid') + '/', import.meta.url)
      const files = readdirSync(directory).filter((file) => file.endsWith('.json'))
      for (const file of files) {
        it((valid ? 'accepts ' : 'rejects ') + file, () => {
          const payload: unknown = JSON.parse(readFileSync(new URL(file, directory), 'utf8'))
          if (domain === 'feishu' && file.startsWith('command-')) {
            expect(protocol.parseCommand(payload as string).ok).toBe(valid)
            return
          }
          let schema: z.ZodType
          if (domain === 'worker') schema = worker
          else if (domain === 'feishu') schema = protocol.CardActionValue
          else if (file.startsWith('client-')) schema = protocol.DashClientFrame
          else if (file.startsWith('server-')) schema = protocol.DashServerFrame
          else schema = exportsByName[file.slice(0, -5)] as z.ZodType
          const result = schema.safeParse(payload)
          expect(result.success, result.success ? '' : result.error.message).toBe(valid)
          if (result.success) expect(schema.parse(JSON.parse(JSON.stringify(result.data)))).toEqual(result.data)
        })
      }
    }
  })
}

it('preserves the raw prompt, Chinese whitespace and quoted options', () => {
  expect(protocol.parseCommand('/run　--cli=“codex” --priority "-2"  "需求"\n下一行 ')).toEqual({
    ok: true, cmd: { name: 'run', flags: { cli: 'codex', priority: -2 }, prompt: '"需求"\n下一行 ' },
  })
  expect(protocol.parseCommand('/approve "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV"')).toMatchObject({ ok: true })
  expect(protocol.parseCommand('/tasks all --status="queued,running"')).toEqual({
    ok: true, cmd: { name: 'tasks', scope: 'all', status: ['queued', 'running'] },
  })
})

it('rejects Owner-only commands and flags for Requesters', () => {
  for (const input of ['/workers', '/tasks all', '/run --worker win-desktop test', '/run --profile full test', '/run --priority 1 test']) {
    const result = protocol.parseCommand(input)
    if (!result.ok) throw new Error(result.error)
    expect(protocol.canUseCommand(result.cmd, 'requester', 'p2p')).toBe(false)
    expect(protocol.canUseCommand(result.cmd, 'owner', 'group')).toBe(true)
  }
  expect(protocol.canUseCommand({ name: 'whoami' }, 'unauthorized', 'p2p')).toBe(true)
  expect(protocol.canUseCommand({ name: 'whoami' }, 'owner', 'group')).toBe(false)
})
