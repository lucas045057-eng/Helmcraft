import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { BOARD_HARD_CAP_BYTES, BOARD_TEMPLATES } from '@agent-hub/protocol'
import { readAgentsMd,readBoard } from '../src/harness/board-reader.js'

let root: string, dir: string
beforeEach(async () => { root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'harness-board-'))); dir=join(root,'.board') })
afterEach(async () => { await fs.rm(root,{recursive:true,force:true}) })
it('reports missing or unsafe directory without creating files or following a junction',async () => {
  const mockOpen=vi.fn(fs.open)
  const io={open:mockOpen, lstat:fs.lstat, realpath:fs.realpath}
  expect(await readBoard(root)).toMatchObject({dir:'absent'})
  expect(await fs.readdir(root)).toEqual([])
  await fs.writeFile(dir,'file')
  expect(await readBoard(root)).toMatchObject({dir:'unsafe',dirReason:'NOT_DIR'})
  await fs.unlink(dir)
  await fs.mkdir(join(root,'other'))
  await fs.symlink(join(root,'other'),dir,process.platform==='win32'?'junction':'dir')
  expect(await readBoard(root,{},[],io)).toMatchObject({dir:'unsafe',dirReason:'LINK'})
  expect(mockOpen).not.toHaveBeenCalled()
})
it('checks single-link identity before reading and rejects an identity mismatch',async () => {
  await fs.mkdir(dir)
  const path=join(dir,'HANDOFF.md'), other=join(root,'other')
  await fs.writeFile(other,'sample')
  await fs.link(other,path)
  expect((await readBoard(root)).files[0]).toMatchObject({status:'unsafe',reason:'HARDLINK'})
  await fs.unlink(path)
  await fs.writeFile(path,'board')
  const io={lstat:fs.lstat,realpath:fs.realpath,open:vi.fn(() => fs.open(other,'r'))}
  const result=(await readBoard(root,{},[],io)).files[0]
  expect(result).toMatchObject({status:'unsafe',reason:'RACE'})
  expect(result).not.toHaveProperty('content')
})
it('bounds reads at the last LF, rejects NUL, and gives each file its own redactor',async () => {
  await fs.mkdir(dir)
  await fs.writeFile(join(dir,'HANDOFF.md'),'short\n'+'x'.repeat(BOARD_HARD_CAP_BYTES))
  await fs.writeFile(join(dir,'PROJECT_STATE.md'),'\x00')
  await fs.writeFile(join(dir,'DECISIONS.md'),'-----BEGIN PRIVATE KEY-----\nprivate')
  await fs.writeFile(join(dir,'LESSONS.md'),BOARD_TEMPLATES['LESSONS.md']+'\nsecret-value')
  const [handoff,state,decisions,lessons]=(await readBoard(root,{API_KEY:'secret-value'})).files
  expect(handoff).toMatchObject({status:'oversize',truncated:true,overBudget:true,content:'short\n',sha256:createHash('sha256').update('short\n').digest('hex')})
  expect(state).toMatchObject({status:'invalid',reason:'BINARY'})
  expect(decisions?.content).not.toContain('private')
  expect(lessons?.content).toContain('## Rules')
  expect(lessons?.content).not.toContain('secret-value')
  expect(lessons?.schemaOk).toBe(true)
})
it('returns only metadata for AGENTS.md and avoids hashing oversized instructions',async () => {
  const path=join(root,'AGENTS.md')
  await fs.writeFile(path,'guidance')
  expect(await readAgentsMd(root)).toEqual({status:'present',bytes:8,sha256:createHash('sha256').update('guidance').digest('hex')})
  await fs.writeFile(path,Buffer.alloc(256*1024+1))
  expect(await readAgentsMd(root)).toEqual({status:'present',bytes:256*1024+1})
})

it('distinguishes disappearance after lookup from a missing board file', async () => {
  await fs.mkdir(dir)
  await fs.writeFile(join(dir, 'HANDOFF.md'), 'sample')
  const open = vi.fn(async () => { throw Object.assign(new Error('removed'), { code: 'ENOENT' }) })
  const board = await readBoard(root, {}, [], { lstat: fs.lstat, realpath: fs.realpath, open })
  expect(board.files[0]).toMatchObject({ status: 'unsafe', reason: 'RACE' })
  expect(board.files[1]).toMatchObject({ status: 'absent' })
})
