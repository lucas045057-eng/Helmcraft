import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { RunEvent } from '@agent-hub/protocol'
import type { BoardSnapshot } from '@agent-hub/protocol'
import { it, expect } from 'vitest'
import { downgradeEvent } from '../src/harness/downgrade.js'
import { RunOutbox } from '../src/tunnel/outbox.js'
import { Journal } from '../src/runner/journal.js'
import type { NewRunEvent, SendRunFrame } from '../src/tunnel/outbox.js'

const frame=JSON.parse(readFileSync(new URL('../../protocol/fixtures/harness/valid/worker__run.events__pre-post-verify.json',import.meta.url),'utf8'))
const events: RunEvent[]=frame.payload.events.map((e:unknown)=>RunEvent.parse(e))
const limits={runBufferBytes:64*1024,totalBufferBytes:1024*1024}
it('downgrades every verification field only on the outgoing connection', () => {
  for (const event of events) {
    const e = event.kind === 'harness' ? {...event,manifest:{files:0,bytes:0,hashed:0,links:0,truncated:false,durationMs:0}}
      : event.kind === 'workspace' ? {...event,tamper:{total:1,paths:['scripts'],links:0},changes:{added:0,modified:1,deleted:0,links:0,total:1,boardOnly:false,sample:[],truncated:false}} : event
    const full = structuredClone(e)
    const boardOnly=downgradeEvent(e,['blackboard.v1']), legacy=downgradeEvent(e,[])
    for (const downgraded of [boardOnly,legacy]) {
      expect(downgraded).toMatchObject({seq:e.seq,ts:e.ts})
      expect(RunEvent.safeParse(downgraded).success).toBe(true)
      for (const key of ['verification','changes','tamper','manifest']) expect(downgraded).not.toHaveProperty(key)
    }
    if (e.kind==='verify') expect(boardOnly).toMatchObject({kind:'progress',phase:'verify'})
    if (e.kind==='harness'||e.kind==='workspace') expect(legacy.kind).toBe('progress')
    expect(downgradeEvent(e,['blackboard.v1','verify.v1'])).toEqual(full)
    expect(e).toEqual(full)
  }
})
it('replays the same sequence with the capabilities of the new connection', () => {
  const outbox=new RunOutbox(new FakeClock(1000),limits,()=>{})
  const id=runId()
  outbox.register(id,taskId())
  const read:RunEvent[]=[]
  const send:SendRunFrame = frame=>{ if (frame.type==='run.events') read.push(...frame.payload.events);return true }
  outbox.attach(send,1<<20,4<<20,[])
  for(const e of events) outbox.push(id,e)
  expect(read.map(e=>e.kind)).toEqual(['started','progress','progress','progress','progress','finished'])
  outbox.detach()
  read.length=0
  outbox.attach(send,1<<20,4<<20,['blackboard.v1','verify.v1'])
  outbox.flush()
  expect(read.map(e=>e.kind)).toEqual(events.map(e=>e.kind))
  expect(read.map(e=>e.seq)).toEqual([1,2,3,4,5,6])
})
it('fits the largest board content first and sends the high-priority event immediately', () => {
  const outbox=new RunOutbox(new FakeClock(0),limits,()=>{})
  const read:RunEvent[]=[]
  const id=runId()
  outbox.register(id,taskId())
  outbox.attach(frame=>{if(frame.type==='run.events') read.push(...frame.payload.events);return true},3200,9000,['blackboard.v1'])
  const board:BoardSnapshot=structuredClone(events.find(e=>e.kind==='harness')!.board!)
  board.files[0]!.content='a'.repeat(4000)
  board.files[1]!.content='short'
  outbox.push(id,{kind:'workspace',round:0,board})
  const received=read.find(e=>e.kind==='workspace')!
  expect(received.board!.files[0]).not.toHaveProperty('content')
  expect(received.board!.files[1]!.content).toBe('short')
  outbox.detach()
  read.length = 0
  outbox.attach(frame => { if (frame.type === 'run.events') read.push(...frame.payload.events); return true }, 1 << 20, 4 << 20, ['blackboard.v1'])
  outbox.flush()
  expect(read.find(e => e.kind === 'workspace')?.board?.files[0]?.content).toBe(board.files[0]!.content)
})
it.each(['succeeded','failed'] as const)('recovers the %s CLI outcome from a compacted journal',async status=>{
  const dir=mkdtempSync(join(tmpdir(),'journal-harness-'))
  try {
    const path=join(dir,'journal'),clock=new FakeClock(17),id=runId(),journal=new Journal(path,clock)
    journal.accepted({runId:id,taskId:taskId(),workspaceId:'sandbox'})
    journal.progress(id,8)
    const outcome: Extract<NewRunEvent,{kind:'finished'}> = {kind:'finished',status,exitCode:status==='succeeded'?0:1,
      signal:null,summary:'result',durationMs:100,cliSessionId:'test'}
    journal.cliExited(id,{round:0,verifyRequested:true,verifyAttempts:1,outcome})
    journal.compact()
    const recovered=await new Journal(path,clock).recover()
    expect(recovered[0]!.finished).toMatchObject({...outcome,seq:9,ts:17,verification:status==='succeeded'
      ? {status:'unverified',reason:'WORKER_RESTARTED',attempts:1} : {status:'skipped',reason:'CLI_NOT_SUCCEEDED'}})
    expect((await new Journal(path,clock).recover())[0]!.finished).toEqual(recovered[0]!.finished)
  } finally {rmSync(dir,{recursive:true,force:true})}
})
