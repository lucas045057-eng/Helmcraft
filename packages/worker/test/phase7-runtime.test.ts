import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { BOARD_TEMPLATES, RunDispatch, RunEvent } from '@agent-hub/protocol'
import type { HarnessDirective } from '@agent-hub/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'

let base: string, root: string, manager: RunManager
const clock = new FakeClock(1000)
const harness: HarnessDirective = { v:1,trust:'owner',board:'write',inject:'fresh',bootstrap:true }
let events: Map<string,RunEvent[]>
function config(enabled = true, blackboard = true) {
  return WorkerConfigSchema.parse({workerId:'test-worker',hub:{url:'ws://localhost:9999'},adapters:{mock:{enabled:true}},harness:{enabled},
    workspaces:[{id:'repo',path:root,label:'Repo',maxProfile:'full',allowedAdapters:['mock'],harness:{blackboard}}]})
}
function command(prompt:string, options: Partial<RunDispatch> = {}): RunDispatch {
  return RunDispatch.parse({runId:runId(),taskId:taskId(),taskNo:1,attempt:1,workspaceId:'repo',adapter:'mock',profile:'edit',prompt,
    timeoutMs:30000,idleTimeoutMs:20000,notAfter:50000,origin:{source:'dashboard',actorType:'owner'},harness,...options})
}
function launch(command: RunDispatch) {
  const accepted=manager.accept(command,1000)
  const stream: RunEvent[]=[]
  events.set(command.runId,stream)
  accepted()
  return stream
}
beforeEach(async () => {
  base=mkdtempSync(join(tmpdir(),'harness-run-')); root=join(base,'workspace')
  mkdirSync(root)
  const c=config(), registry=new AdapterRegistry(c)
  await registry.probe(['mock'])
  manager=new RunManager(c,registry,clock,new Journal(join(base,'journal'),clock),join(base,'logs'),()=>{})
  events=new Map()
  manager.outbox.attach(frame=>{
    if(frame.type==='run.events') events.get(frame.payload.runId)!.push(...frame.payload.events.map(e=>RunEvent.parse(e)))
    return true
  },1<<20,4<<20,['blackboard.v1'])
})
afterEach(async () => { manager.cancelAll(); await manager.awaitRuns(); rmSync(base,{recursive:true,force:true}) })
it('emits ordered snapshots, hashes the bytes observed by the child, and captures CLI-created files',async () => {
  const ops=[{op:'mkdir',path:'.board'},...Object.entries(BOARD_TEMPLATES).map(([name,content])=>({op:'write',path:'.board/'+name,content}))]
  const creation=launch(command('#scenario:fs harness=1 ops='+Buffer.from(JSON.stringify(ops)).toString('base64url')))
  await manager.awaitRuns()
  expect(creation.slice(0,2).map(e=>e.kind)).toEqual(['started','harness'])
  expect(creation.slice(-2).map(e=>e.kind)).toEqual(['workspace','finished'])
  expect(creation.find(e=>e.kind==='harness')?.board?.dir).toBe('absent')
  expect(creation.find(e=>e.kind==='workspace')?.board?.files.every(f=>f.schemaOk)).toBe(true)
  const stream=launch(command('#scenario:echo-harness harness=1\n中文任务',{profile:'readonly'}))
  await manager.awaitRuns()
  const pre=stream.find(e=>e.kind==='harness')!, post=stream.find(e=>e.kind==='workspace')!, end=stream.find(e=>e.kind==='finished')!
  expect(pre.applied).toMatchObject({board:'read',bootstrap:false})
  expect(post.readonlyCheck).toBe('clean')
  expect(JSON.parse(end.summary)).toMatchObject({sha256:pre.prompt!.sha256, bytes:pre.prompt!.bytes, mode:'fresh',task:'中文任务',
    blocks:{board:Object.keys(BOARD_TEMPLATES)}})
  const records=readFileSync(join(base,'journal'),'utf8').trim().split('\n').map(l=>JSON.parse(l).type)
  expect(records.indexOf('run.cli_exited')).toBeLessThan(records.indexOf('run.finished'))
})
it('reports a readonly modification and inconclusive attribution across a concurrent writer',async () => {
  const ops=[{op:'mkdir',path:'.board'},{op:'write',path:'.board/HANDOFF.md',content:'new'}]
  const stream=launch(command('#scenario:fs harness=1 ops='+Buffer.from(JSON.stringify(ops)).toString('base64url'),{profile:'readonly'}))
  await manager.awaitRuns()
  expect(stream.find(e=>e.kind==='workspace')).toMatchObject({readonlyCheck:'violation',readonlyPaths:['.board/HANDOFF.md']})
  const c=command('#scenario:need-input harness=1',{profile:'readonly'})
  const live=launch(c)
  await vi.waitFor(()=>expect(live.some(e=>e.kind==='input_request')).toBe(true),{timeout:5000})
  launch(command('#scenario:success harness=1'))
  const request=live.find(e=>e.kind==='input_request')!
  manager.provide({runId:c.runId,requestId:request.requestId,answer:'actual answer'})
  await manager.awaitRuns()
  expect(live.find(e=>e.kind==='workspace')?.readonlyCheck).toBe('inconclusive')
  expect(live.at(-1)).toMatchObject({kind:'finished',summary:'actual answer'})
})
it('retains the resume stdin and respects both local configuration ceilings',async () => {
  const stream=launch(command('#scenario:echo-harness harness=1',{harness:{...harness,inject:'resume',bootstrap:false}}))
  await manager.awaitRuns()
  expect(stream.find(e=>e.kind==='harness')).not.toHaveProperty('prompt')
  expect(JSON.parse(stream.find(e=>e.kind==='finished')!.summary).hx).toBe(false)
  manager.update(config(true,false))
  const local=launch(command('#scenario:echo-harness harness=1'))
  await manager.awaitRuns()
  expect(local.find(e=>e.kind==='harness')?.applied.board).toBe('off')
  expect(local.find(e=>e.kind==='harness')).not.toHaveProperty('board')
  manager.update(config(false))
  const disabled=launch(command('#scenario:echo-harness harness=1'))
  await manager.awaitRuns()
  expect(disabled.filter(e=>e.kind==='harness'||e.kind==='workspace')).toHaveLength(0)
  expect(JSON.parse(disabled.find(e=>e.kind==='finished')!.summary).hx).toBe(false)
})
it('cancels during preparation without emitting started or touching the workspace',async () => {
  const c=command('#scenario:echo-harness harness=1')
  const stream=launch(c)
  manager.cancel({runId:c.runId,force:true,graceMs:0,reason:'user'})
  await manager.awaitRuns()
  expect(stream).toHaveLength(1)
  expect(stream[0]).toMatchObject({kind:'finished',status:'cancelled'})
})

it('reserves an in-process run without creating a journal record or starting capture',async () => {
  const c = command('#scenario:success harness=1')
  const before = existsSync(join(base,'journal'))
  const start = manager.reserve(c,1000)
  expect(existsSync(join(base,'journal'))).toBe(before)
  expect(manager.seen(c.runId)).toBe('starting')
  events.set(c.runId,[])
  start()
  await manager.awaitRuns()
  expect(events.get(c.runId)?.at(-1)?.kind).toBe('finished')
})
