import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import * as protocol from '../src/index.js'

const schemas: Record<string, unknown> = { ...protocol, worker: z.union([protocol.HubToWorkerFrame, protocol.WorkerToHubFrame]) }
for (const category of ['valid', 'invalid']) {
  const dir = new URL('../fixtures/harness/' + category + '/', import.meta.url)
  for (const filename of readdirSync(dir)) {
    it(category + ' ' + filename, () => {
      const schema = schemas[filename.split('__')[0]!] as z.ZodType
      const payload = JSON.parse(readFileSync(new URL(filename, dir), 'utf8'))
      const result = schema.safeParse(payload)
      expect(result.success, result.success ? '' : result.error.message).toBe(category === 'valid')
      if (result.success) expect(schema.parse(JSON.parse(JSON.stringify(result.data)))).toEqual(payload)
    })
  }
}
it('negotiates capabilities within the header budget', () => {
  const parse = protocol.parseCapabilityHeader
  expect(parse(undefined)).toBeUndefined()
  expect(parse('')).toEqual([])
  expect(parse(['verify.v1, INVALID', ' blackboard.v1,verify.v1'])).toEqual(['blackboard.v1', 'verify.v1'])
  expect(parse('a.v1,' + 'x'.repeat(256) + ',b.v1')).toEqual(['a.v1'])
  expect(parse(Array.from({length: 17}, (_, i) => 'x' + i + '.v1'))).toHaveLength(16)
  expect(protocol.negotiateCapabilities(['verify.v1'], protocol.KNOWN_CAPABILITIES)).toEqual([])
  expect(protocol.negotiateCapabilities(protocol.KNOWN_CAPABILITIES, ['blackboard.v1'])).toEqual(['blackboard.v1'])
})
it('permits handoff only in an owner private chat', () => {
  for (const text of ['/handoff --cli=mock', '/run --from=#1 task']) {
    const parsed = protocol.parseCommand(text)
    if (!parsed.ok) throw Error(parsed.error)
    expect(protocol.canUseCommand(parsed.cmd, 'owner', 'p2p')).toBe(true)
    expect(protocol.canUseCommand(parsed.cmd, 'owner', 'group')).toBe(false)
    expect(protocol.canUseCommand(parsed.cmd, 'requester', 'p2p')).toBe(false)
  }
  expect(protocol.parseCommand('/run --ws=sandbox --from=#1 task')).toMatchObject({ok:false,error:'--from 与 --ws 不能同时使用'})
})
