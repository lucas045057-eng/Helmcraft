import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadIdentity } from '../../worker/src/identity.js'
import { eventually, openHarness, wsUrl } from './pi/harness.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { assertPhase6Event } from './pi/frozen.js'
import { owner } from './pi/phase7.js'

const write = (path: string, content: string) => ({ op: 'write', path, content })
const encode = (ops: unknown[]) => Buffer.from(JSON.stringify(ops)).toString('base64url')
const scenario = (ops: unknown[], fixes: unknown[] = []) => '#scenario:fs harness=1 ops=' + encode(ops) + ' fixOps=' + encode(fixes)
const caps = ['blackboard.v1', 'verify.v1']
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup(js: string, retries = 0, exposed = false) {
  const transport = new PiFeishuTransport()
  const { hub, dir, cleanup: close } = await openHarness({ harness: { defaults: { autoFixMaxRetries: retries } },
    feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'], allowedChatIds: ['oc_group'], defaultWorkspaceId: 'sandbox' }
  }, { feishuTransport: transport })
  cleanup.push(close)
  const api = hub.ctx.orchestrator, db = hub.ctx.store.repos
  const path = join(dir, 'workspace')
  mkdirSync(path)
  const identity = loadIdentity(join(dir, 'identity.key'), true)
  const workerId = 'phase7b'
  const { token } = hub.ctx.auth.createEnrollToken(owner, workerId)
  hub.ctx.auth.enroll({ token, workerId, publicKey: identity.publicKey, hostname: 'vf', os: process.platform as 'win32' | 'linux' | 'darwin' }, '127.0.0.1')
  const config = { workerId, hub: { url: wsUrl(hub.address!) }, adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path, allowedAdapters: ['mock'], maxProfile: 'edit',
      harness: { verify: { commands: [{ id: 'check', argv: [process.execPath, '-e', js] }] } } }] }
  if (exposed) { mkdirSync(join(dir, 'settings')); Object.assign(config.hub, { identityPath: join(dir, 'identity.key') })
    config.workspaces.push({ ...config.workspaces[0]!, id: 'settings', path: join(dir, 'settings') }) }
  const configPath = join(exposed ? join(dir, 'settings') : dir, 'worker.yaml')
  const save = () => writeFileSync(configPath, JSON.stringify(config))
  save()
  const start = async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../worker/bin/agent-worker.mjs'), 'run', '--config', configPath], {
      env: { ...process.env, LOCALAPPDATA: dir, APPDATA: dir }, stdio: 'ignore', windowsHide: true, shell: false })
    const done = once(child, 'close')
    const kill = async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await done }
    cleanup.push(kill)
    await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 20000 })
    return kill
  }
  const kill = await start()
  expect(hub.ctx.workers.capabilities(workerId)).toEqual(caps)
  const create = (prompt: string) => api.createTask({ adapter: 'mock', profile: 'edit', workspaceId: 'sandbox', prompt }, owner)
  const settle = (id: string) => eventually(() => {
    const task = api.getTask(id)
    return task?.status === 'succeeded' && task
  }, { timeoutMs: 20000 })
  return { hub, dir, db, api, transport, path, workerId, create, settle, start, kill, config, save }
}
const check = "const fs=require('fs');if(fs.readFileSync('src.txt','utf8')!=='fixed'){console.error('expected fixed');process.exit(2)}"

it('E2E-19 routes a failed check through the Owner repair card and accepts the passing child', async () => {
  const s = await setup(check)
  await s.transport.emit({ text: '/run --profile=edit --cli=mock ' + scenario([write('src.txt', 'broken')]), user: 'ou_owner', chatType: 'p2p' })
  const id = s.db.tasks.getByNo(1)!.id, task = await s.settle(id)
  const run = task.runs[0]!
  expect(task.verification).toBe('failed')
  const card = s.db.feishu.messages(id).find(m => m.role === 'progress_card')!
  await eventually(() => s.transport.json(card.messageId).includes('带报错修复'), { timeoutMs: 10000 })
  expect(s.transport.json(card.messageId)).toContain('换 CLI 修复')
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBeNull()
  const click = await s.transport.click(card.messageId, 'ou_owner', { v: 1, a: 'fix', t: id, r: run.id, ver: task.version },
    { form: { prompt: scenario([write('src.txt', 'fixed')]) } })
  expect(click.toast.type).toBe('success')
  const child = await s.settle(s.db.tasks.getByNo(2)!.id)
  const view = s.api.runHarness(child.id, child.runs[0]!.id)
  expect(view.facts?.handoff?.from).toMatchObject({ verification: 'failed', changes: { source: 'manifest', paths: ['src.txt'] },
    verificationDetail: { failed: [{ id: 'check', exitCode: 2, tail: 'expected fixed' }] } })
  expect(child.verification).toBe('passed')
  expect(view.pointer?.lastAccepted?.runId).toBe(child.runs[0]!.id)
}, 60000)
it('E2E-20/21 persists cumulative rounds and requires manual acceptance after sensitive changes', async () => {
  const s = await setup(check, 1)
  const task = await s.create(scenario([write('src.txt', 'broken')], [write('src.txt', 'fixed')]))
  const done = await s.settle(task.id)
  const view = s.api.runHarness(task.id, done.runs[0]!.id)
  expect(view.verification?.attempts.map(a => a.status)).toEqual(['failed', 'passed'])
  expect(view.verification?.outcome).toMatchObject({ attempts: 2, autoFix: { attempts: 1, stoppedBy: 'PASSED' } })
  expect(view.board.postRound).toBe(1)
  const changed = await s.create(scenario([write('package.json', '{}')]))
  const gated = await s.settle(changed.id), id = gated.runs[0]!.id
  expect(s.api.runHarness(gated.id, id)).toMatchObject({ tamper: { paths: ['package.json'] }, verification: { attempts: [], outcome: { reason: 'TAMPER_RISK' } } })
  const pointer = await s.api.acceptRun(s.workerId, 'sandbox', owner, { runId: id, expectedAcceptedRunId: done.runs[0]!.id })
  expect(pointer.lastAccepted?.acceptedBy).toBe(owner.id)
  expect(s.api.metrics().verificationOutcomes).toMatchObject({ passed: 1, skipped: 1 })
}, 60000)
it('CR-1/2 E2E-22 recovers a killed Worker during a check and cleans its process tree', async () => {
  const s = await setup("const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.txt',[process.pid,child.pid].join(','));setInterval(()=>{},1000)")
  const task = await s.create(scenario([write('src.txt', 'new')]))
  await eventually(() => s.api.getTask(task.id)?.verification === 'running' && existsSync(join(s.path, 'pids.txt')), { timeoutMs: 20000 })
  const pids = readFileSync(join(s.path, 'pids.txt'), 'utf8').split(',').map(Number)
  const journal = join(s.dir, 'agent-worker', 'state', 'journal.jsonl')
  await eventually(() => readFileSync(journal, 'utf8').includes('"role":"verify"'))
  await s.kill()
  await eventually(() => s.hub.ctx.workers.get(s.workerId)?.connection !== 'online')
  await s.start()
  const done = await s.settle(task.id)
  expect(done.runs[0]!.harness?.verification).toMatchObject({ state: 'unverified', reason: 'WORKER_RESTARTED', attempts: 1 })
  const terminal = readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(record => record.type === 'run.finished')
  expect(() => assertPhase6Event(terminal.finishedEvent)).toThrow(/verification/)
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBeNull()
  await eventually(() => pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } }))
}, 60000)
it('RT-11 blocks verification reload across every workspace and still applies labels', async () => {
  const s = await setup('process.exit(0)', 0, true)
  for (const ws of s.config.workspaces) {
    ws.label = 'Updated'
    ws.harness.verify.commands[0]!.argv = [process.execPath, '-e', 'process.exit(3)']
  }
  s.save()
  await eventually(() => s.hub.ctx.workers.get(s.workerId)?.workspaces.every(w => w.label === 'Updated'), { timeoutMs: 20000 })
  const task = await s.create(scenario([write('src.txt', 'one')]))
  expect((await s.settle(task.id)).verification).toBe('passed')
  const exposed = await s.api.createTask({ adapter: 'mock', profile: 'edit', workspaceId: 'settings', prompt: scenario([]) }, owner)
  expect((await s.settle(exposed.id)).runs[0]?.harness?.verification?.reason).toBe('CONFIG_EXPOSED')
}, 60000)
