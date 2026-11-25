// 真实 CLI 跨接力端到端：claude-code（第一棒）→ codex（第二棒），两者都经包装脚本走 ~/.proxy.env 专属出口；
// Worker 跑 node --test 验真。可用 RELAY_FIRST / RELAY_SECOND 交换顺序。
// 用法（在已登录 codex / claude 的 Linux/WSL 账户下）：pnpm build && node scripts/relay-e2e.mjs [--keep]
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../packages/hub/dist/app.js'
import { WorkerConfigSchema } from '../packages/worker/dist/config/schema.js'
import { loadIdentity } from '../packages/worker/dist/identity.js'
import { startWorker } from '../packages/worker/dist/app.js'

const keep = process.argv.includes('--keep')
const first = process.env.RELAY_FIRST ?? 'claude-code'
const second = process.env.RELAY_SECOND ?? 'codex'
const TASK_TIMEOUT = Number(process.env.RELAY_TIMEOUT_MS ?? 20 * 60_000)
const dir = mkdtempSync(join(tmpdir(), 'helmcraft-relay-'))
const workspace = join(dir, 'sandbox')
mkdirSync(workspace)

// 1. 一个最小 Node 项目作为工作区
writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'sandbox', private: true, type: 'module' }, null, 2) + '\n')
writeFileSync(join(workspace, 'math.js'), 'export function add(a, b) {\n  return a + b\n}\n')
writeFileSync(join(workspace, 'math.test.js'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './math.js'\n\ntest('add', () => assert.equal(add(2, 3), 5))\n")
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('-c', 'user.name=relay-e2e', '-c', 'user.email=relay-e2e@localhost', 'add', '-A')
git('-c', 'user.name=relay-e2e', '-c', 'user.email=relay-e2e@localhost', 'commit', '-q', '-m', 'baseline')

// 2. 进程内 Hub + Worker（仅回环地址）
const token = randomBytes(32).toString('base64url')
process.env.HUB_ADMIN_TOKEN_SHA256 = createHash('sha256').update(token).digest('hex')
const port = Number(process.env.RELAY_PORT ?? 8080)
const origin = 'http://127.0.0.1:' + port
const hub = await createHub({ server: { host: '127.0.0.1', port, publicUrl: origin, allowInsecureWorker: true },
  storage: { path: join(dir, 'hub.sqlite') }, dashboard: { allowedOrigins: [origin, 'http://localhost:' + port] }, feishu: { enabled: false } })
const owner = { type: 'owner', id: 'relay-e2e', channel: 'dashboard' }
const workerId = 'wsl-relay'
const identity = loadIdentity(join(dir, 'identity.key'), true)
const enrollment = hub.ctx.auth.createEnrollToken(owner, workerId)
hub.ctx.auth.enroll({ workerId, publicKey: identity.publicKey, token: enrollment.token, hostname: 'localhost', os: process.platform }, '127.0.0.1')
// claude 必须走专属出口：固定调用 egress-guard 包装脚本（Fail-Closed 加载 ~/.proxy.env），不走 PATH 解析
const claudeCommand = process.env.RELAY_CLAUDE_COMMAND ?? join(process.env.HOME ?? '', '.local/bin/claude')
if ([first, second].includes('claude-code')) {
  if (!existsSync(claudeCommand) || !readFileSync(claudeCommand, 'utf8').includes('egress-guard')) {
    throw new Error('claude 包装脚本缺失或不是 egress-guard：' + claudeCommand + '（拒绝以直连出口运行）')
  }
  if (!existsSync(join(process.env.HOME ?? '', '.proxy.env'))) throw new Error('~/.proxy.env 不存在，拒绝运行 claude')
}
// codex 同样走专属出口：固定调用 codex-egress 包装脚本（deploy/wsl/codex-egress.sh，Fail-Closed 加载 ~/.proxy.env）
const codexCommand = process.env.RELAY_CODEX_COMMAND ?? join(process.env.HOME ?? '', '.local/bin/codex-egress')
if ([first, second].includes('codex') && (!existsSync(codexCommand) || !readFileSync(codexCommand, 'utf8').includes('codex-egress'))) {
  throw new Error('codex 包装脚本缺失：' + codexCommand + '（先 install -m 755 deploy/wsl/codex-egress.sh ~/.local/bin/codex-egress）')
}
// agy 同样走专属出口：deploy/wsl/agy-egress.sh
const agyCommand = process.env.RELAY_AGY_COMMAND ?? join(process.env.HOME ?? '', '.local/bin/agy-egress')
if ([first, second].includes('antigravity') && (!existsSync(agyCommand) || !readFileSync(agyCommand, 'utf8').includes('agy-egress'))) {
  throw new Error('agy 包装脚本缺失：' + agyCommand + '（先 install -m 755 deploy/wsl/agy-egress.sh ~/.local/bin/agy-egress）')
}
const adapterConfig = id => id === 'claude-code' ? { enabled: true, command: claudeCommand }
  : id === 'codex' ? { enabled: true, command: codexCommand }
  : id === 'antigravity' ? { enabled: true, command: agyCommand } : { enabled: true }
const config = WorkerConfigSchema.parse({ workerId, hub: { url: 'ws://127.0.0.1:' + port + '/ws/worker' },
  adapters: { [first]: adapterConfig(first), [second]: adapterConfig(second) },
  workspaces: [{ id: 'sandbox', label: 'Relay E2E', path: workspace, allowedAdapters: [first, second], maxProfile: 'edit',
    harness: { verify: { commands: [{ id: 'unit', argv: [process.execPath, '--test'], timeoutMs: 120000 }] } } }] })
const worker = await startWorker(config, { identity, stateDir: join(dir, 'worker') })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// 运行期取证：扫描 /proc 中真实 CLI 进程的环境变量，确认带 HTTPS_PROXY（不打印代理值）
const egressPatterns = { 'claude-code': /claude-code\/bin\/claude(\.exe)?$/, codex: /@openai\/codex.*\/bin\/codex(\.js)?$|^\/usr\/local\/bin\/codex$/, antigravity: /\/\.local\/bin\/agy$/ }
const egressBy = Object.fromEntries(Object.keys(egressPatterns).map(id => [id, { seen: 0, proxied: 0, direct: 0 }]))
const egressPids = new Set()
const egressTimer = setInterval(() => {
  if (!existsSync('/proc')) return
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    if (egressPids.has(pid)) continue
    try {
      const cmd = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0')
      const id = Object.keys(egressPatterns).find(key => cmd.some(part => egressPatterns[key].test(part)))
      if (!id) continue
      const env = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0')
      egressPids.add(pid)
      egressBy[id].seen++
      if (env.some(entry => /^HTTPS_PROXY=.+/.test(entry))) egressBy[id].proxied++
      else egressBy[id].direct++
    } catch {}
  }
}, 300)
egressTimer.unref()
async function settle(id) {
  const deadline = Date.now() + TASK_TIMEOUT
  let last = ''
  while (Date.now() < deadline) {
    const task = hub.ctx.orchestrator.getTask(id, owner)
    if (task && task.status + ':' + (task.lastProgress ?? '') !== last) {
      last = task.status + ':' + (task.lastProgress ?? '')
      console.log('  [' + new Date().toISOString().slice(11, 19) + '] #' + task.taskNo + ' ' + last)
    }
    if (task && ['succeeded', 'failed', 'rejected', 'cancelled', 'timed_out'].includes(task.status)) return task
    await sleep(2000)
  }
  throw new Error('Task ' + id + ' did not finish in time')
}
function report(label, task) {
  const run = task.runs[0]
  const harness = hub.ctx.orchestrator.runHarness(task.id, run.id)
  console.log('\n== ' + label + ' ==')
  console.log({ taskNo: task.taskNo, status: task.status, adapter: run.adapter, runStatus: run.status,
    cliSession: run.cliSessionId ?? null, resumeSessionId: task.resumeSessionId ?? null,
    inject: harness.directive?.inject, board: harness.directive?.board,
    handoffFrom: harness.facts?.handoff?.from?.runId ?? null,
    verification: harness.verification?.outcome ?? null, canAccept: harness.canAccept })
  console.log('summary:', (task.resultSummary ?? run.summary ?? '').slice(0, 600))
  return { run, harness }
}

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')) }
let exitCode = 1
try {
  await sleep(1500)
  const adapters = hub.ctx.orchestrator.listWorkers().find(w => w.id === workerId)?.adapters ?? []
  console.log('Worker adapters:', adapters.map(a => a.id + ':' + a.status).join(', '))
  console.log('Workspace:', workspace)

  console.log('\n-> 第一棒 ' + first)
  const t1 = await hub.ctx.orchestrator.createTask({ adapter: first, workspaceId: 'sandbox', profile: 'edit', prompt:
    '在 math.js 中新增并导出 multiply(a, b)，在 math.test.js 中为它补充测试，确保 `node --test` 通过。' +
    '完成后按黑板规范更新 .board/ 下的交接文件，写明做了什么以及下一棒可以接着实现 divide(a, b)（除数为 0 时抛错）。' }, owner)
  const done1 = await settle(t1.id)
  const r1 = report('第一棒 ' + first, done1)

  console.log('\n-> 交接给第二棒 ' + second)
  const preview = hub.ctx.orchestrator.handoffPreview(done1.id, owner, { intent: 'relay', adapter: second })
  console.log('handoff warnings:', preview.warnings, '| resume:', preview.resume)
  const t2 = await hub.ctx.orchestrator.handoff(done1.id, owner, { intent: 'relay', adapter: second, prompt:
    '阅读上一棒的交接信息，按建议在 math.js 中实现并导出 divide(a, b)（除数为 0 时抛出 Error），补充测试并确保 `node --test` 通过，然后更新 .board/ 交接文件。' })
  const done2 = await settle(t2.id)
  const r2 = report('第二棒 ' + second, done2)

  const pointer = hub.ctx.store.repos.pointers.get(workerId, 'sandbox')
  const source = readFileSync(join(workspace, 'math.js'), 'utf8')
  console.log('\n== 工作区 ==')
  console.log(git('status', '--short'))
  console.log(source)
  if (existsSync(join(workspace, '.board'))) console.log('.board:', readdirSync(join(workspace, '.board')))
  let testsPass = false
  try { execFileSync(process.execPath, ['--test'], { cwd: workspace, stdio: 'pipe' }); testsPass = true } catch {}

  console.log('\n== 判定 ==')
  check('第一棒成功', done1.status === 'succeeded' && r1.run.adapter === first)
  check('第一棒验真通过', r1.harness.verification?.outcome?.status === 'passed', r1.harness.verification?.outcome?.status)
  for (const id of [...new Set([first, second])].filter(id => egressBy[id])) {
    const e = egressBy[id]
    check(id + ' 进程带代理环境运行', e.seen > 0 && e.direct === 0, 'observed=' + e.seen + ' withProxy=' + e.proxied + ' direct=' + e.direct)
  }
  check('第二棒成功', done2.status === 'succeeded' && r2.run.adapter === second)
  check('第二棒验真通过', r2.harness.verification?.outcome?.status === 'passed', r2.harness.verification?.outcome?.status)
  check('跨 CLI 不复用会话', !done2.resumeSessionId)
  check('接力注入了交接', r2.harness.directive?.inject === 'handoff' && r2.harness.facts?.handoff?.from?.runId === r1.run.id)
  check('接力绑定同一 Worker', hub.ctx.store.repos.tasks.get(done2.id)?.requiredWorkerId === workerId)
  check('multiply 与 divide 都已实现', /export\s+(function|const)\s+multiply/.test(source) && /export\s+(function|const)\s+divide/.test(source))
  check('工作区测试通过', testsPass)
  check('lastAccepted 指向第二棒', pointer?.lastAcceptedRunId === r2.run.id, pointer?.lastAcceptedRunId ?? 'null')
  exitCode = checks.every(c => c.ok) ? 0 : 1
  console.log('\n' + checks.filter(c => c.ok).length + '/' + checks.length + ' 通过；数据目录 ' + dir)
} catch (error) {
  console.error(error)
} finally {
  if (keep) {
    console.log('\nDashboard:', origin, '\nLogin token:', token, '\nCtrl+C 退出')
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
  await worker.close().catch(() => {})
  await hub.close().catch(() => {})
  process.exit(exitCode)
}
