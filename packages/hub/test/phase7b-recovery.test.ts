import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createTestHub } from '../src/app.js'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { ChaosProxy, enrollWorker, eventually, tmpDir } from './pi/harness.js'
import { owner } from './pi/phase7.js'

it('CR-7/8 replays verification exactly once across a severed connection and Hub restart', async () => {
  const dir = tmpDir(), path = join(dir, 'repo')
  mkdirSync(path)
  const config = { storage: { path: join(dir, 'hub.sqlite') }, server: { port: 0, allowInsecureWorker: true } }
  let hub = await createTestHub(config)
  config.server.port = Number(new URL(hub.address!).port)
  const proxy = await ChaosProxy.start(hub.address!)
  const workerId = 'vf-replay', identity = await enrollWorker(hub, workerId)
  const worker = await startWorker(WorkerConfigSchema.parse({ workerId, hub: { url: proxy.url }, adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', maxProfile: 'edit', path, allowedAdapters: ['mock'], harness: {
      verify: { commands: [{ id: 'wait', argv: [process.execPath, '-e',
        "setInterval(()=>{if(require('fs').existsSync('release'))process.exit(0)},50)"] }] } } }] }),
  { stateDir: join(dir, 'state'), identity, random: () => 0 })
  try {
    await eventually(() => hub.ctx.workers.isOnline(workerId))
    const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'src', content: 'test' }])).toString('base64url')
    const task = await hub.ctx.orchestrator.createTask({ adapter: 'mock', workspaceId: 'sandbox', profile: 'edit', prompt: '#scenario:fs harness=1 ops=' + ops }, owner)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)?.verification === 'running', { timeoutMs: 15000 })
    proxy.down()
    await hub.close()
    writeFileSync(join(path, 'release'), '')
    await worker.runner.awaitRuns()
    expect(readFileSync(join(dir, 'state', 'state', 'journal.jsonl'), 'utf8')).toContain('"status":"passed"')
    hub = await createTestHub(config)
    proxy.up()
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)?.verification === 'passed', { timeoutMs: 20000 })
    const done = hub.ctx.orchestrator.getTask(task.id)!
    expect(done.runs).toHaveLength(1)
    expect(done.timeline.filter(t => t.event === 'task.harness.verification')).toHaveLength(1)
    const view = hub.ctx.orchestrator.runHarness(task.id, done.runs[0]!.id)
    expect(view.verification?.attempts.map(a => a.status)).toEqual(['passed'])
  } finally { proxy.up(); await worker.close(); await proxy.close(); await hub.close(); rmSync(dir, { recursive: true, force: true }) }
}, 60000)
