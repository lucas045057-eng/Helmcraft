/**
 * Pi 独立验收 · Phase 7b 端到端（E2E-19 ~ E2E-22、RT-12）
 *
 * 真实 Hub 进程内 + 真实 Worker 子进程 + mock-cli。所有用例结束时校验 INV-1 ~ INV-8
 * 与 INV-9 ~ INV-14（修正版复核器，见 pi/verify-invariants.ts）。
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadIdentity } from '../../worker/src/identity.js'
import { assertInvariants, eventually, openHarness, wsUrl } from './pi/harness.js'
import { assertVerificationInvariants } from './pi/verify-invariants.js'
import { assertPhase6Event } from './pi/frozen.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { owner, requester } from './pi/phase7.js'

const write = (path: string, content: string) => ({ op: 'write', path, content })
const encode = (ops: unknown[]) => Buffer.from(JSON.stringify(ops)).toString('base64url')
const scenario = (ops: unknown[], fixes: unknown[] = []) =>
  '#scenario:fs harness=1 ops=' + encode(ops) + ' fixOps=' + encode(fixes)
const caps = ['attachments.v1', 'blackboard.v1', 'checks-digest.v2', 'preflight.v1', 'verify.v1', 'visual.v1']
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup(js: string, options: { retries?: number; feishu?: boolean; capabilities?: string[] } = {}) {
  const transport = new PiFeishuTransport()
  const opened = await openHarness({
    harness: { defaults: { autoFixMaxRetries: options.retries ?? 0 } },
    ...(options.capabilities ? { workers: { capabilities: options.capabilities } } : {}),
    ...(options.feishu === false ? {} : { feishu: { enabled: true, ownerOpenIds: ['ou_owner'], requesterAllowlist: ['ou_req'],
      allowedChatIds: ['oc_group'], defaultWorkspaceId: 'sandbox' } }),
  }, { feishuTransport: transport })
  cleanup.push(opened.cleanup)
  const api = opened.hub.ctx.orchestrator, db = opened.hub.ctx.store.repos
  const path = join(opened.dir, 'workspace')
  mkdirSync(path)
  const identity = loadIdentity(join(opened.dir, 'identity.key'), true)
  const workerId = 'pi7b'
  const { token } = opened.hub.ctx.auth.createEnrollToken(owner, workerId)
  opened.hub.ctx.auth.enroll({ token, workerId, publicKey: identity.publicKey, hostname: 'pi',
    os: process.platform as 'win32' | 'linux' | 'darwin' }, '127.0.0.1')
  const config = { workerId, hub: { url: wsUrl(opened.hub.address!) }, adapters: { mock: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Sandbox', path, allowedAdapters: ['mock'], maxProfile: 'edit',
      harness: { verify: { commands: [{ id: 'check', argv: [process.execPath, '-e', js] }] } } }] }
  const configPath = join(opened.dir, 'worker.yaml')
  writeFileSync(configPath, JSON.stringify(config))
  const journal = join(opened.dir, 'agent-worker', 'state', 'journal.jsonl')
  const verifyProcesses = () => existsSync(journal)
    ? readFileSync(journal, 'utf8').split(/\r?\n/u).filter(line => line.includes('"type":"run.process"'))
      .map(line => JSON.parse(line) as { role: string }).filter(record => record.role === 'verify').length
    : 0
  const start = async () => {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, '../../worker/bin/agent-worker.mjs'), 'run',
      '--config', configPath], { env: { ...process.env, LOCALAPPDATA: opened.dir, APPDATA: opened.dir },
      stdio: 'ignore', windowsHide: true, shell: false })
    const done = once(child, 'close')
    const kill = async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await done }
    cleanup.push(kill)
    await eventually(() => opened.hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 20_000 })
    return kill
  }
  const kill = await start()
  expect(opened.hub.ctx.workers.capabilities(workerId)).toEqual(options.capabilities ?? caps)
  const create = (prompt: string, actor = owner) => api.createTask({ adapter: 'mock', profile: 'edit', workspaceId: 'sandbox', prompt }, actor)
  const settle = (id: string) => eventually(() => {
    const task = api.getTask(id)
    return task?.status === 'succeeded' && task
  }, { timeoutMs: 30_000 })
  const invariant = () => { assertInvariants(db); assertVerificationInvariants(db) }
  return { hub: opened.hub, dir: opened.dir, db, api, transport, path, workerId, create, settle, start, kill,
    journal, verifyProcesses, invariant, cleanup: opened.cleanup }
}

const check = "const fs=require('fs');if(!fs.existsSync('src.txt')||fs.readFileSync('src.txt','utf8')!=='fixed')" +
  "{console.error('expected fixed');process.exit(2)}"

it('E2E-19 routes a failed check through the Owner repair card into an accepted passing child', async () => {
  const s = await setup(check)
  await s.transport.emit({ text: '/run --profile=edit --cli=mock ' + scenario([write('src.txt', 'broken')]),
    user: 'ou_owner', chatType: 'p2p' })
  const first = await s.settle(s.db.tasks.getByNo(1)!.id)
  const firstRun = first.runs[0]!
  expect(first.verification).toBe('failed')
  expect(s.api.runHarness(first.id, firstRun.id).verification?.outcome).toMatchObject({ status: 'failed', failed: ['check'] })
  const card = s.db.feishu.messages(first.id).find(message => message.role === 'progress_card')!
  await eventually(() => s.transport.json(card.messageId).includes('带报错修复'), { timeoutMs: 10_000 })
  expect(s.transport.json(card.messageId)).toContain('换 CLI 修复')
  // 失败结论不推进指针
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBeNull()
  const click = await s.transport.click(card.messageId, 'ou_owner',
    { v: 1, a: 'fix', t: first.id, r: firstRun.id, ver: first.version },
    { form: { prompt: scenario([write('src.txt', 'fixed')]) } })
  expect(click.toast.type).toBe('success')
  const child = await s.settle(s.db.tasks.getByNo(2)!.id)
  const childRun = child.runs[0]!
  expect(child.verification).toBe('passed')
  const view = s.api.runHarness(child.id, childRun.id)
  // 带报错修复：同 CLI（mock 的 fs 剧本不产生会话，因此这里断言完整注入的 handoff）
  expect(childRun.adapter).toBe('mock')
  expect(childRun.resume).toBeUndefined()
  expect(view.directive?.inject).toBe('handoff')
  expect(view.facts?.handoff).toMatchObject({ intent: 'fix', from: { verification: 'failed',
    changes: { source: 'manifest', paths: ['src.txt'] },
    verificationDetail: { failed: [{ id: 'check', exitCode: 2, tail: 'expected fixed' }] } } })
  expect(view.pointer?.lastAccepted?.runId).toBe(childRun.id)
  s.invariant()
}, 120_000)

it('E2E-20/21 repairs once in a single run and never verifies after a manifest tamper', async () => {
  const s = await setup(check, { retries: 1 })
  const task = await s.create(scenario([write('src.txt', 'broken')], [write('src.txt', 'fixed')]))
  const done = await s.settle(task.id)
  const run = done.runs[0]!
  const view = s.api.runHarness(task.id, run.id)
  expect(view.verification?.attempts.map(attempt => attempt.status)).toEqual(['failed', 'passed'])
  expect(view.verification?.outcome).toMatchObject({ status: 'passed', attempts: 2, autoFix: { attempts: 1, stoppedBy: 'PASSED' } })
  expect(view.board.postRound).toBe(1)
  expect(s.verifyProcesses()).toBe(2)
  expect(view.pointer?.lastAccepted?.runId).toBe(run.id)
  // E2E-21：改 package.json → TAMPER_RISK，且没有启动任何验证进程
  const before = s.verifyProcesses()
  const tampered = await s.create(scenario([{ op: 'mkdir', path: 'docs' }, write('package.json', '{"scripts":{}}')]))
  const gated = await s.settle(tampered.id)
  const tamperRun = gated.runs[0]!
  const tamperView = s.api.runHarness(gated.id, tamperRun.id)
  expect(tamperView.verification).toMatchObject({ attempts: [], outcome: { status: 'skipped', reason: 'TAMPER_RISK' } })
  expect(tamperView.tamper?.paths).toContain('package.json')
  expect(s.verifyProcesses()).toBe(before)
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBe(run.id)
  // Owner 手动采纳
  const pointer = await s.api.acceptRun(s.workerId, 'sandbox', owner, { runId: tamperRun.id, expectedAcceptedRunId: run.id })
  expect(pointer.lastAccepted).toMatchObject({ runId: tamperRun.id, acceptedBy: owner.id })
  s.invariant()
}, 120_000)

it('E2E-22 recovers a Worker killed mid-verification and cleans the orphan tree', async () => {
  const s = await setup("const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pids.txt',[process.pid,child.pid].join(','));setInterval(()=>{},1000)")
  const task = await s.create(scenario([write('src.txt', 'new')]))
  await eventually(() => s.api.getTask(task.id)?.verification === 'running' && existsSync(join(s.path, 'pids.txt')),
    { timeoutMs: 30_000 })
  const pids = readFileSync(join(s.path, 'pids.txt'), 'utf8').split(',').map(Number)
  await eventually(() => s.verifyProcesses() >= 1, { timeoutMs: 15_000 })
  await s.kill()
  await eventually(() => s.hub.ctx.workers.get(s.workerId)?.connection !== 'online')
  await s.start()
  const done = await s.settle(task.id)
  expect(done.runs[0]?.harness?.verification).toMatchObject({ state: 'unverified', reason: 'WORKER_RESTARTED', attempts: 1 })
  // CR-9：Phase 6 冻结的事件形态无法解析带 verification 的 journal finished
  const terminal = readFileSync(s.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as
    { type: string; finishedEvent?: Record<string, unknown> }).find(record => record.type === 'run.finished')!
  expect(() => assertPhase6Event(terminal.finishedEvent)).toThrow(/verification/u)
  // 未验证 → 不采纳；孤儿树被清理
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBeNull()
  await eventually(() => pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } }),
    { timeoutMs: 20_000 })
  s.invariant()
}, 180_000)

it('HP-12/BC-9 runs a real 7b Worker against a blackboard-only Hub without verifying or 4400', async () => {
  const s = await setup('process.exit(0)', { capabilities: ['blackboard.v1'], feishu: false })
  const task = await s.create(scenario([write('src.txt', 'work')]))
  const done = await s.settle(task.id)
  const run = done.runs[0]!
  // 未协商 verify.v1 → 不请求验证、不产生 verify 事件
  expect(run.harness?.verify).toBeUndefined()
  expect(done.verification).toBeUndefined()
  expect(s.db.runs.get(run.id)?.verificationStatus).toBeNull()
  expect(s.verifyProcesses()).toBe(0)
  expect(s.api.runHarness(task.id, run.id).verification).toBeNull()
  // 连接全程健康：没有 4400、也没有重连
  expect(s.hub.ctx.workers.get(s.workerId)?.connection).toBe('online')
  expect(s.hub.ctx.workers.capabilities(s.workerId)).toEqual(['blackboard.v1'])
  s.invariant()
}, 120_000)

it('RT-12 keeps Requester runs unverified with zero verification processes by default', async () => {
  const s = await setup('process.exit(0)', { feishu: false })
  const task = await s.create(scenario([write('src.txt', 'requester work')]), requester)
  await s.api.approve(task.id, owner)
  const done = await s.settle(task.id)
  const run = done.runs[0]!
  expect(done.verification).toBeUndefined()
  expect(run.harness?.verify).toBeUndefined()
  expect(s.verifyProcesses()).toBe(0)
  const view = s.api.runHarness(task.id, run.id)
  expect(view.verification).toBeNull()
  // Requester 运行永不自动采纳
  expect(s.db.pointers.get(s.workerId, 'sandbox')?.lastAcceptedRunId).toBeNull()
  s.invariant()
}, 120_000)
