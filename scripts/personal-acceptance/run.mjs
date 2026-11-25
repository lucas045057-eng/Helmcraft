import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { createHub } from '../../packages/hub/dist/app.js'
import { startWorker } from '../../packages/worker/dist/app.js'
import { readWorkerConfig, resolveWorkspaces } from '../../packages/worker/dist/config/load.js'
import { WorkspaceHarnessConfig } from '../../packages/worker/dist/config/schema.js'
import { loadIdentity } from '../../packages/worker/dist/identity.js'
import { AdapterRegistry } from '../../packages/worker/dist/adapters/registry.js'
import { preflight } from '../../packages/worker/dist/personal/preflight.js'
import { verifyStoppedDelivery } from './stopped.mjs'

const { values } = parseArgs({ options: {
  config: { type: 'string' }, workspace: { type: 'string' }, output: { type: 'string' }, 'reject-push': { type: 'boolean' },
} })
assert.ok(values.config && values.workspace && values.output, 'Supply --config, --workspace and --output (an existing directory outside Git)')
const configPath = realpathSync(values.config)
const config = readWorkerConfig(configPath)
const workspace = config.workspaces.find(ws => ws.id === values.workspace)
assert.ok(workspace, 'Workspace missing from the supplied Worker configuration')
const output = realpathSync(values.output)
const probe = spawnSync('git', ['-C', output, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
if (probe.error || probe.status !== 128) throw new Error('Choose an output directory outside a Git repository')
const rejectPush = !!values['reject-push']
const dir = mkdtempSync(join(output, rejectPush ? 'rejected-' : 'delivered-'))
console.log(JSON.stringify({ directory: dir, scenario: rejectPush ? 'reject-push' : 'deliver' }))
const project = join(dir, 'project'), remote = join(dir, 'remote.git')
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
const local = (...args) => git('-C', project, ...args)
const upstream = () => local('ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/main').split(/\s+/u)[0]
const fixedFiles = ['REQUIREMENTS.md', 'history.check.mjs', 'markdown.check.mjs']
git('init', '--bare', '-q', '-b', 'main', remote)
git('init', '-q', '-b', 'main', project)
local('config', 'user.name', 'Personal Acceptance')
local('config', 'user.email', 'acceptance@localhost')
for (const name of fixedFiles) copyFileSync(new URL(name, import.meta.url), join(project, name))
local('add', 'REQUIREMENTS.md')
local('commit', '-qm', 'Specify the personal Git delivery checklist')
local('add', '--', ...fixedFiles.slice(1))
local('commit', '-qm', 'Define history and Markdown acceptance checks')
const baseline = local('rev-parse', 'HEAD')
local('remote', 'add', 'origin', remote)
local('push', '-qu', 'origin', 'main')
assert.equal(upstream(), baseline)
if (rejectPush) writeFileSync(join(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755, flag: 'wx' })

const checks = ['history', 'markdown']
workspace.path = project
workspace.harness = WorkspaceHarnessConfig.parse({ verify: { commands: checks.map(id => ({ id, argv: ['node', '--test', id + '.check.mjs'] })) } })
config.workspaces = [workspace]
config.localLogs.dir = join(dir, 'logs')
const hub = await createHub({ server: { port: 0, host: '127.0.0.1', allowInsecureWorker: true }, storage: { path: join(dir, 'hub.sqlite') } })
let worker
const projectId = 'git-deliveries'
const db = hub.ctx.store.repos
const until = async (read, deadline) => {
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await wait(250)
  }
  throw new Error('Acceptance deadline reached. Evidence retained in ' + dir)
}
try {
  const stateDir = join(dir, 'state')
  const identityPath = join(dir, 'identity.key')
  config.hub = { url: new URL('/ws/worker', hub.address).href.replace('http:', 'ws:'), identityPath }
  const cfg = resolveWorkspaces(config, configPath, stateDir)
  const binding = await preflight(cfg, workspace.id, new AdapterRegistry(cfg))
  const identity = loadIdentity(identityPath, true)
  const { token } = hub.ctx.auth.createEnrollToken({ type: 'owner', id: 'owner', channel: 'dashboard' }, cfg.workerId)
  hub.ctx.auth.enroll({ token, workerId: cfg.workerId, publicKey: identity.publicKey, hostname: 'acceptance', os: 'linux' }, '127.0.0.1')
  worker = await startWorker(cfg, { stateDir, identity })
  await until(() => hub.ctx.workers.get(cfg.workerId)?.connection === 'online', Date.now() + 30000)
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + hub.ctx.auth.createApiToken('acceptance', ['operate','read']) }
  const submit = await fetch(new URL('/api/v1/personal/plans', hub.address), { method: 'POST', headers,
    body: JSON.stringify({ projectId, binding, sources: ['REQUIREMENTS.md'] }) })
  assert.equal(submit.status, 201)
  const view = () => db.prepare('SELECT phase,control,reason,last_commit FROM personal_projects WHERE id=?').get(projectId)
  const terminal = await until(() => { const p = view(); return ['done','blocked','stopped'].includes(p.phase) && p }, Date.now() + 24 * 3600000)
  const url = new URL('/api/v1/personal/projects/' + projectId, hub.address).href
  if (rejectPush && terminal.phase === 'blocked') {
    assert.equal((await fetch(url + '/stop', { method:'POST', headers, body:'{}' })).status, 204)
    await until(() => ['inspect','closed'].includes(view().control), Date.now() + 30000)
  }
  const response = await fetch(url + '/reports', { headers })
  assert.equal(response.status, 200)
  const reports = await response.json()
  for (const name of ['ACCEPTANCE.md','ADVISOR_FINAL.md','UNRESOLVED.md']) {
    assert.equal(typeof reports[name], 'string')
    writeFileSync(join(dir, name), reports[name], { flag:'wx' })
  }
  const items = db.prepare('SELECT item_id,status,commit_sha,remote_sha FROM personal_items WHERE project_id=? ORDER BY ordinal').all(projectId)
  const steps = db.prepare('SELECT item_id,kind,task_id,run_id,result_json FROM personal_steps WHERE project_id=? ORDER BY created_at,rowid').all(projectId)
  const readResult = step => JSON.parse(JSON.parse(step.result_json).summary)
  const tip = local('rev-parse', 'HEAD'), remoteSha = upstream()
  const snapshot = { baseline, tip, remoteSha, ...view(), items, steps: steps.map(({result_json, ...step}) => ({...step, result:JSON.parse(result_json)})) }
  writeFileSync(join(dir, 'execution.json'), JSON.stringify(snapshot, null, 2) + '\n', {flag:'wx'})
  console.log(JSON.stringify({ directory:dir, phase:snapshot.phase, control:snapshot.control, reason:snapshot.reason, tip, remoteSha }))
  assert.equal(items.length, 2, 'The requirement calls for two ordered items')
  assert.equal(local('diff', baseline, '--', ...fixedFiles), '', 'Input requirements and independent oracle changed')
  if (rejectPush) {
    verifyStoppedDelivery(dir)
  } else {
    assert.equal(snapshot.phase, 'done')
    assert.equal(snapshot.control, 'closed')
    assert.equal(remoteSha, tip)
    assert.equal(local('status', '--porcelain'), '')
    assert.equal(steps[0].kind, 'PLAN_READY')
    let parent = baseline, previousPush = -1
    for (const item of items) {
      const runSteps = steps.filter(s => s.item_id === item.item_id)
      const implement = runSteps.find(s => s.kind === 'implement')
      const tested = JSON.parse(runSteps.filter(s => ['implement','repair'].includes(s.kind)).at(-1).result_json)
      const review = readResult(runSteps.filter(s => s.kind === 'review').at(-1))
      const commit = readResult(runSteps.find(s => s.kind === 'commit'))
      const push = runSteps.find(s => s.kind === 'push')
      assert.ok(steps.indexOf(implement) > previousPush)
      assert.ok(tested.verification.status === 'passed' && review.judgment.decision === 'PASS')
      assert.equal(review.tree, tested.candidate.tree)
      assert.equal(commit.tree, review.tree)
      assert.equal(commit.parent, parent)
      assert.equal(local('show','-s','--format=%P %T',commit.commit), parent + ' ' + commit.tree)
      assert.equal(readResult(push).remoteSha, commit.commit)
      assert.equal(item.remote_sha, commit.commit)
      parent = commit.commit
      previousPush = steps.indexOf(push)
    }
    assert.equal(parent, tip)
    assert.deepEqual(steps.slice(-2).map(s=>s.kind), ['verify_final','FINAL_READY'])
    const checked = db.runs.get(steps.at(-2).run_id).verificationJson.attempts[0].results
    assert.deepEqual(checked.map(r=>[r.id,r.status,r.exitCode]).sort(), checks.map(id=>[id,'passed',0]))
    assert.equal(readResult(steps.at(-1)).head, tip)
    assert.equal(readResult(steps.at(-1)).judgment.assessment, 'ok')
    assert.ok(reports['ACCEPTANCE.md'].includes('已具备人工验收条件') && reports['ACCEPTANCE.md'].includes(tip))
    assert.equal(reports['ACCEPTANCE.md'].split('\n').filter(line=>line.startsWith('- [x]')).length, 2)
    assert.deepEqual(await (await fetch(url + '/reports', { headers })).json(), reports)
    console.log(local('log', '-2', '--format=%h %s'))
    console.log(execFileSync(process.execPath, ['checklist.mjs','2'], {cwd:project, encoding:'utf8'}))
  }
  console.log('Verified ' + (rejectPush ? 'stopped delivery' : 'two delivered tasks') + ' in ' + dir)
} finally {
  try { await worker?.close() } finally { await hub.close() }
}
