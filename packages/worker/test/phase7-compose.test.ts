import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { RunDispatch } from '@agent-hub/protocol'
import type { HarnessSession } from '../src/harness/session.js'
import { computeApplied } from '../src/harness/session.js'
import { composeRun } from '../src/harness/compose-run.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

const command = RunDispatch.parse(JSON.parse(readFileSync(new URL('../../protocol/fixtures/harness/valid/worker__run.dispatch__handoff.json', import.meta.url), 'utf8')).payload)
const agents = {status: 'present' as const, bytes: 3}
const root = process.cwd()
const collision = '1234567890123456789012'
const dispatch = {...command, prompt: '#scenario:echo-harness harness=1\n' + collision}
function session(): HarnessSession {
  return { applied: computeApplied(command.harness!, {blackboard:true}, 'edit'), epochPre:0,writerActive:false,round:0 }
}
it('resamples collisions and renders cwd-relative POSIX paths and measured facts', () => {
  const s=session(), cwd=join(root,'src','pkg')
  const next=vi.fn().mockReturnValueOnce(collision).mockReturnValue('A'.repeat(22))
  const text=composeRun(dispatch,s,root,cwd,agents,1,next)!
  expect(next).toHaveBeenCalledTimes(2)
  expect(text).toContain('../../AGENTS.md')
  expect(text).toContain('../../.board')
  expect(text).toContain('"cwd": "src/pkg"')
  expect(text).not.toContain(root)
  expect(s.prompt?.sha256).toBe(createHash('sha256').update(text).digest('hex'))
})
it('leaves the original input in place after three nonce collisions', () => {
  const s=session(),next=vi.fn(()=>collision)
  expect(composeRun(dispatch,s,root,root,agents,0,next)).toBeUndefined()
  expect(next).toHaveBeenCalledTimes(3)
  expect(s.applied).toMatchObject({inject:'none',downgrades:[{field:'inject',reason:'NONCE_COLLISION'}]})
  expect(s.prompt).toBeUndefined()
})
it('accepts local verification defaults while retaining strict workspace configuration', () => {
  const workspace={id:'repo',path:root,label:'Repo',maxProfile:'edit',allowedAdapters:['mock']}
  const cfg={workerId:'worker-1',hub:{url:'ws://localhost:1'},workspaces:[workspace]}
  expect(WorkerConfigSchema.parse(cfg)).toMatchObject({harness:{enabled:true},workspaces:[{harness:{blackboard:true}}]})
  for (const name of ['verify','tamper','manifest']) {
    expect(WorkerConfigSchema.safeParse({...cfg,workspaces:[{...workspace,harness:{[name]:{}}}]}).success).toBe(true)
    expect(WorkerConfigSchema.safeParse({...cfg,workspaces:[{...workspace,harness:{[name]:{unknown:true}}}]}).success).toBe(false)
  }
})
