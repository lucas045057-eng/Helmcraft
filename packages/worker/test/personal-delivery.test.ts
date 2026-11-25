import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonalDelivery } from '@agent-hub/protocol'
import { expect, it, vi } from 'vitest'
import { deliver, observeDelivery } from '../src/personal/delivery.js'
import { preparePlan } from '../src/personal/plan.js'
import { checkedCandidate } from '../src/personal/review-input.js'
import { bindRepository } from '../src/personal/roles.js'

it.each(['normal','late-file','commit-hook','reject-push','core-drift'])('checks Git delivery and retains the scene for %s', async mode=>{
  const dir=mkdtempSync(join(tmpdir(),'delivery-')), root=join(dir,'project'), remote=join(dir,'remote.git')
  const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'}).trimEnd()
  const local=(...args:string[])=>git('-C',root,...args)
  const hook=(path:string,body:string)=>{writeFileSync(path,'#!/bin/sh\n'+body+'\n');chmodSync(path,0o755)}
  try {
    git('init','--bare','-q','-b','main',remote)
    git('init','-q','-b','main',root)
    local('config','user.name','Delivery Test');local('config','user.email','test@localhost')
    writeFileSync(join(root,'README.md'),'Export a count.\n')
    local('add','README.md');local('commit','-qm','Requirement')
    local('remote','add','origin',remote);local('push','-qu','origin','main')
    const binding={...bindRepository(root),workerId:'worker',workspaceId:'workspace',executables:{main:'codex',reviewer:'claude',advisor:'agy'}}
    const item={id:'ONE',title:'Count entries',checks:['core'],requirements:['README.md:L1'],acceptanceRefs:['README.md:L1']}
    const receipt=preparePlan(root,['README.md'],['core']).install(JSON.stringify({items:[item]}))
    writeFileSync(join(root,'count.mjs'),'export const count = 1\n')
    const candidate=checkedCandidate(root)
    const core=vi.fn(async()=>{if(mode==='core-drift')writeFileSync(join(root,'late'),'changed during final test')})
    const execute=(kind:PersonalDelivery['kind'],commit?:string)=>deliver(binding,{kind,candidate,...(commit && {commit}),
      spec:{...receipt,first:true,sources:['README.md'],item}},new AbortController().signal,()=>{expect(bindRepository(root).branch).toBe('main')},core)
    if(mode==='late-file'){
      writeFileSync(join(root,'late'),'unreviewed')
      await expect(execute('commit')).rejects.toThrow('CANDIDATE_CHANGED')
      expect(local('rev-parse','HEAD')).toBe(candidate.head)
      return
    }
    if(mode==='commit-hook'){
      hook(join(root,'.git/hooks/pre-commit'),'echo changed > hook-change && git add hook-change')
      await expect(execute('commit')).rejects.toThrow('COMMIT_CONTENT_CHANGED')
      expect(readFileSync(join(root,'hook-change'),'utf8')).toContain('changed')
      expect((await observeDelivery(binding,()=>{})).remoteSha).toBe(candidate.head)
      return
    }
    const {commit}=await execute('commit')
    expect(local('rev-parse','HEAD^{tree}')).toBe(candidate.tree)
    expect(git('--git-dir',remote,'rev-parse','refs/heads/main')).toBe(candidate.head)
    if(mode==='reject-push'){
      hook(join(remote,'hooks/pre-receive'),'exit 1')
      await expect(execute('push',commit)).rejects.toThrow()
      expect(await observeDelivery(binding,()=>{})).toMatchObject({local:{head:commit},remoteSha:candidate.head})
      return
    }
    expect(await execute('push',commit)).toMatchObject({commit,remoteSha:commit})
    // A duplicate write request observes a changed remote parent and stops.
    await expect(execute('push',commit)).rejects.toThrow('REMOTE_PARENT_CHANGED')
    if(mode==='core-drift') await expect(execute('verify_final',commit)).rejects.toThrow('COMMIT_CONTENT_CHANGED')
    else expect(await execute('verify_final',commit)).toMatchObject({remoteSha:commit})
    expect(core).toHaveBeenCalledOnce()
  } finally {rmSync(dir,{recursive:true,force:true})}
})
