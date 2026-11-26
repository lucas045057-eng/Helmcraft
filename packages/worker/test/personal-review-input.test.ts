import { execFileSync } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import type { RunDispatch } from '@agent-hub/protocol'
import { preparePlan } from '../src/personal/plan.js'
import { inspectChanges,roleInput } from '../src/personal/review-input.js'

it('packages the full proposed change and refuses a drifted read-only reply while preserving the real index',()=>{
  const root=mkdtempSync(join(tmpdir(),'role-input-'))
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trimEnd()
  try{
    git('init','-q')
    writeFileSync(join(root,'README.md'),'Emit a count.\n')
    writeFileSync(join(root,'old.txt'),'old line\n')
    git('add','-A');git('-c','user.name=Owner','-c','user.email=owner@localhost','commit','-qm','baseline')
    const item={id:'ITEM',title:'count',requirements:['README.md:L1'],acceptanceRefs:['README.md:L1'],checks:['core']}
    const receipt=preparePlan(root,['README.md'],['core']).install(JSON.stringify({items:[item]}))
    rmSync(join(root,'old.txt'))
    writeFileSync(join(root,'new.txt'),'new line\n')
    const index=readFileSync(join(root,'.git/index'))
    const command={taskId:'task',runId:'run',prompt:'core passed',personal:{gate:{kind:'review',ordinal:1,spec:{...receipt,first:true,sources:['README.md'],item}}}} as RunDispatch
    command.personal!.gate!.candidate = inspectChanges(root)
    const tested=command.personal!.gate!.candidate!
    command.personal!.gate!.candidate={...tested,tree:'0'.repeat(40)}
    expect(()=>roleInput(root,command)).toThrow('CANDIDATE_CHANGED')
    command.personal!.gate!.candidate=tested
    const review=roleInput(root,command)
    for(const expected of ['-old line','+new line','TASKS.md','core passed','Emit a count.']) expect(review.prompt).toContain(expected)
    const reply=JSON.stringify({decision:'PASS',findings:[]})
    expect(review.finish(reply)).toMatchObject({tree:inspectChanges(root).tree,taskId:'task',runId:'run',ordinal:1})
    const fenced = ['```json', reply, '```'].join('\n')
    expect(review.finish(fenced)).toEqual(review.finish(reply))
    for (const ambiguous of ['preface\n' + fenced, fenced + '\nmore', fenced + '\n' + fenced, fenced.replace('PASS', 'MAYBE')]) {
      expect(() => review.finish(ambiguous)).toThrow()
    }
    expect(readFileSync(join(root,'.git/index'))).toEqual(index)
    writeFileSync(join(root,'late.txt'),'late')
    expect(()=>review.finish(reply)).toThrow(/changed/)
  }finally{rmSync(root,{recursive:true,force:true})}
}, 30_000) // 一连串 git 命令在 Windows CI 上常超过默认 5 秒
