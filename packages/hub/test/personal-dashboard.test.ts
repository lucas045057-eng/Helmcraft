import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import { expect, it } from 'vitest'
import { RunDispatch } from '@agent-hub/protocol'
import { defaultAdapters, enrollWorker, FakeWorker, openHarness, seedRun } from './pi/harness.js'
import { blockUnconfirmedDelivery, closeProject } from '../src/plugins/orchestrator/personal-controls.js'
import { projectReports } from '../src/plugins/orchestrator/personal-status.js'
import { ADMIN_TOKEN, useAdminToken } from './pi/rest.js'

it('starts and pauses a personal project, stops an active run, and exports its confirmed stopped snapshot',async()=>{
  useAdminToken()
  const socket=createServer()
  await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve))
  const port=(socket.address() as AddressInfo).port
  await new Promise<void>(resolve=>socket.close(()=>resolve()))
  const origin='http://127.0.0.1:'+port, id='personal-ui'
  const {hub,cleanup}=await openHarness({server:{port},dashboard:{allowedOrigins:[origin],
    distDir:fileURLToPath(new URL('../../dashboard/dist/site/',import.meta.url))}})
  const browser=await chromium.launch({channel:'chrome'})
  const binding={root:'/personal/project',workerId:'personal-worker',workspaceId:'sandbox',branch:'main',
    remote:'origin',ref:'refs/heads/main',destination:'a'.repeat(64),executables:{main:'/codex',reviewer:'/claude',advisor:'/agy'}}
  let worker:FakeWorker|undefined
  try {
    const page=await browser.newPage()
    await page.goto(origin);await page.getByTestId('login-token').fill(ADMIN_TOKEN);await page.getByTestId('login-submit').click()
    const panel=page.getByRole('region',{name:'个人项目'})
    await panel.getByRole('button',{name:'启动项目'}).click()
    await panel.getByLabel('项目 ID').fill(id)
    await panel.getByLabel('Worker 预检文件').setInputFiles({name:'binding.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({ok:true,binding}))})
    await panel.getByRole('button',{name:'开始执行'}).click()
    await panel.getByRole('button',{name:'暂停派发'}).click()
    await pw(panel).toContainText('已暂停派发')
    worker=await FakeWorker.connect(hub,{workerId:binding.workerId,adapters:[{...defaultAdapters[0]!,id:'codex'}]})
    await new Promise(r=>setTimeout(r,1200))
    expect(worker.count('run.dispatch')).toBe(0)
    await panel.getByRole('button',{name:'继续派发'}).click()
    const frame=await worker.waitFor('run.dispatch',6000), d=RunDispatch.parse(frame.payload)
    await worker.ackCommand(frame)
    await panel.getByRole('button',{name:'任务与日志'}).click()
    await pw(page.getByTestId('mission-drawer')).toBeVisible()
    await page.keyboard.press('Escape')
    await panel.getByRole('button',{name:'停止项目'}).click()
    const cancel=await worker.waitFor('run.cancel',6000)
    await worker.ackCommand(cancel)
    const summary=JSON.stringify({items:[{id:'ONE',title:'late item',requirements:['PRD.md:L1'],acceptanceRefs:['PRD.md:L1'],checks:['core']}],
      head:'a'.repeat(40),sourceDigest:'b'.repeat(64),checksDigest:'c'.repeat(64),tasksDigest:'d'.repeat(64)})
    const terminal={kind:'finished',seq:1,ts:Date.now(),status:'succeeded',exitCode:0,signal:null,durationMs:5,summary,
      personalResultDigest:createHash('sha256').update(summary).digest('hex')}
    worker.events(d.runId,d.taskId,[terminal])
    const release=await worker.waitFor('project.release',8000)
    expect(release.payload).toMatchObject({projectId:id,root:binding.root})
    await worker.ackCommand(release,{result:{releasedProject:id}})
    await pw(panel).toContainText('已停止')
    worker.events(d.runId,d.taskId,[terminal])
    expect(hub.ctx.store.repos.prepare('SELECT count(*) FROM personal_items').pluck().get()).toBe(0)
    expect(worker.count('run.dispatch')).toBe(1)
    await panel.getByRole('button',{name:'生成报告快照'}).click()
    for(const name of ['ACCEPTANCE.md','ADVISOR_FINAL.md','UNRESOLVED.md']){
      const event=page.waitForEvent('download')
      await panel.getByRole('button',{name,exact:true}).click()
      const file=await event
      expect(file.suggestedFilename()).toBe(name)
      const contents=await readFile((await file.path())!,'utf8')
      expect(contents).toContain(id)
      if(name==='ACCEPTANCE.md')expect(contents).toContain('未完成')
      const saved=hub.ctx.store.repos.prepare('SELECT closed_reports FROM personal_projects WHERE id=?').pluck().get(id)
      expect(JSON.parse(String(saved))[name]).toBe(contents)
    }
  } finally {worker?.close();await browser.close();await cleanup()}
},45000)

it('retains an ambiguous push and includes its Worker observation in the incomplete report',async()=>{
  const {hub,cleanup}=await openHarness({},{listen:false})
  try {
    hub.ctx.orchestrator.pauseScheduling()
    const db=hub.ctx.store.repos
    const binding={workerId:'worker',workspaceId:'sandbox',root:'/repo',branch:'main',remote:'origin',ref:'refs/heads/main',
      destination:'a'.repeat(64),executables:{main:'codex',reviewer:'claude',advisor:'agy'}}
    await enrollWorker(hub,binding.workerId)
    const {taskId,runId}=seedRun(hub,{workerId:binding.workerId})
    db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(taskId)
    db.prepare("UPDATE task_runs SET status='failed' WHERE id=?").run(runId)
    db.prepare("INSERT INTO personal_projects(id,worker_id,root,binding_json,sources_json,plan_task_id,phase,updated_at,current_item) VALUES('p','worker','/repo',?,'[]','plan','pushing',0,'I')").run(JSON.stringify(binding))
    db.prepare("INSERT INTO personal_items(project_id,item_id,ordinal,definition_json) VALUES('p','I',0,'{}')").run()
    db.prepare("INSERT INTO personal_steps(task_id,project_id,item_id,kind,ordinal,run_id,result_json,created_at) VALUES(?,'p','I','push',1,?,?,0)").run(taskId,runId,JSON.stringify({status:'failed',summary:'REMOTE_COMMIT_UNCONFIRMED'}))
    const observation=JSON.stringify({step:'push',reason:'REMOTE_COMMIT_UNCONFIRMED',local:{head:'1'.repeat(40)},remoteSha:null})
    db.prepare("INSERT INTO task_logs(run_id,seq,ts,kind,stream,text,bytes) VALUES(?,1,0,'log','system',?,?)").run(runId,observation,observation.length)
    blockUnconfirmedDelivery(db,1)
    db.prepare("UPDATE personal_projects SET control='stop_requested' WHERE id='p'").run()
    await closeProject(hub.ctx,'p')
    expect(db.prepare("SELECT phase,control,reason FROM personal_projects WHERE id='p'").get()).toEqual({phase:'blocked',control:'inspect',reason:'DELIVERY_RECEIPT_UNCONFIRMED'})
    const reports=projectReports(db,'p',2)
    expect(reports['ACCEPTANCE.md']).toContain('未完成')
    expect(reports['UNRESOLVED.md']).toContain(observation)
  } finally {await cleanup()}
})
