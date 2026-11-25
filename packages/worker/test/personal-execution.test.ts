import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { preparePlan } from '../src/personal/plan.js'
import { planBaseline, requiredCommands } from '../src/personal/execution.js'
import { ProjectOccupation } from '../src/personal/occupation.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

it('persists the physical project occupation across role gaps and restarts and blocks overlapping writers', () => {
  const dir = mkdtempSync(join(tmpdir(),'occupy-')), path = join(dir,'state.json'), repo = join(dir,'repo'), sub = join(repo,'src')
  mkdirSync(sub,{recursive:true})
  try {
    const first = new ProjectOccupation(path)
    first.claim(repo,'p')
    const restored = new ProjectOccupation(path)
    expect(restored.permits(repo,'p')).toBe(true)
    for (const root of [repo,sub,dir]) expect(restored.permits(root)).toBe(false)
    expect(restored.permits(repo,'other')).toBe(false)
    expect(() => restored.release(repo,'other')).toThrow()
    restored.release(repo,'p')
    expect(first.permits(repo)).toBe(true)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})

it('pins the plan and sources, selects only required local commands and rejects a changed verification config', () => {
  const dir = mkdtempSync(join(tmpdir(),'execute-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd:dir,stdio:'pipe' })
  try {
    git('init','-q')
    writeFileSync(join(dir,'REQ.md'),'Build the report.\n')
    git('add','REQ.md')
    git('-c','user.name=Owner','-c','user.email=owner@localhost','commit','-qm','requirement')
    const checks = WorkerConfigSchema.parse({workerId:'test-worker',hub:{url:'ws://127.0.0.1/ws'},workspaces:[{
      id:'ws',label:'workspace',path:dir,allowedAdapters:['codex'],maxProfile:'edit',harness:{verify:{
        commands:[{id:'unit',argv:['node','--test']},{id:'lint',argv:['node','lint.js']}]}}}]}).workspaces[0]!.harness.verify.commands
    const ref = ['REQ.md:L1'], item = {id:'FIRST',title:'Implement report',requirements:ref,acceptanceRefs:ref,checks:['lint']}
    const receipt = preparePlan(dir,['REQ.md'],checks.map(c=>c.id),createHash('sha256').update(JSON.stringify(checks)).digest('hex')).install(JSON.stringify({items:[item]}))
    const spec = {...receipt,item,sources:['REQ.md'],first:true}
    expect(requiredCommands(spec,checks)).toEqual([checks[1]])
    expect(() => requiredCommands(spec,[...checks].reverse())).toThrow()
    planBaseline(dir,spec,true)
    writeFileSync(join(dir,'new.txt'),'work')
    expect(() => planBaseline(dir,spec,true)).toThrow()
    planBaseline(dir,spec,false)
    writeFileSync(join(dir,'TASKS.md'),'drift')
    expect(() => planBaseline(dir,spec,false)).toThrow()
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
