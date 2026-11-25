import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocketServer } from 'ws'
import { expect,it } from 'vitest'
import { startWorker } from '../src/app.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { generateKeyPairSync } from 'node:crypto'

it.each([true,false])('advertises only the implemented capability when enabled=%s', async enabled => {
  const ws=new WebSocketServer({host:'127.0.0.1',port:0})
  const dir=mkdtempSync(join(tmpdir(),'phase7-upgrade-'))
  let worker:Awaited<ReturnType<typeof startWorker>>|undefined
  try {
    await once(ws,'listening')
    const connected=once(ws,'connection')
    const {privateKey,publicKey}=generateKeyPairSync('ed25519')
    const config=WorkerConfigSchema.parse({workerId:'worker-1',hub:{url:'ws://127.0.0.1:'+(ws.address() as AddressInfo).port},
      workspaces:[],harness:{enabled}})
    worker=await startWorker(config,{stateDir:dir,identity:{privateKey,publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),fingerprint:'test'}})
    const [,request]=await connected
    expect((request as IncomingMessage).headers['x-agent-hub-capabilities']).toBe(enabled?'blackboard.v1,verify.v1':undefined)
  } finally {
    await worker?.close()
    for(const client of ws.clients) client.terminate()
    await new Promise<void>(resolve=>ws.close(()=>resolve()))
    rmSync(dir,{recursive:true,force:true})
  }
})
