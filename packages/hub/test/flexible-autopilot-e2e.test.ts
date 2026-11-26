import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadIdentity } from '../../worker/src/identity.js'
import { PiFeishuTransport } from './pi/feishu.js'
import { eventually, openHarness, wsUrl } from './pi/harness.js'
import { owner } from './pi/phase7.js'
import { login, ORIGIN, rest, settings, useAdminToken } from './pi/rest.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()

it('executes full flexible autopilot lifecycle across real Hub and spawned Worker with local-only commit and no verify commands', async () => {
  useAdminToken()
  const transport = new PiFeishuTransport()
  const { hub, dir, cleanup: closeHub } = await openHarness(
    {
      ...settings,
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
      },
    },
    { feishuTransport: transport },
  )
  cleanup.push(closeHub)

  const wsRoot = join(dir, 'soren')
  const formaRoot = join(wsRoot, 'Forma')
  mkdirSync(formaRoot, { recursive: true })
  git(formaRoot, 'init', '-q', '-b', 'main')
  git(formaRoot, 'config', 'user.name', 'Test User')
  git(formaRoot, 'config', 'user.email', 'test@localhost')
  writeFileSync(join(formaRoot, 'README.md'), '# Forma\nInitial readme\n')
  git(formaRoot, 'add', 'README.md')
  git(formaRoot, 'commit', '-qm', 'init')

  // Cross-platform fake Codex executable script recognized by resolveExe
  const fakeScript = join(dir, 'fake-codex.mjs')
  writeFileSync(
    fakeScript,
    [
      "import { writeFileSync } from 'node:fs'",
      "if (process.argv.includes('--version')) { console.log('codex-cli 0.99.0'); process.exit(0) }",
      "let prompt = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', c => { prompt += c })",
      "process.stdin.on('end', () => {",
      '  const emit = text => process.stdout.write(',
      "    JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } }) + '\\n' +",
      "    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }) + '\\n'",
      '  )',
      "  if (prompt.includes('Produce an ordered implementation plan')) {",
      "    emit(JSON.stringify({ items: [{ id: 'T01', title: 'Add export helper', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['self-check'] }] }))",
      "  } else if (prompt.includes('Trigger: PLAN_READY')) {",
      "    emit(JSON.stringify({ assessment: 'ok', advice: 'proceed' }))",
      "  } else if (prompt.includes('Trigger: review')) {",
      "    emit(JSON.stringify({ decision: 'PASS', findings: [] }))",
      "  } else if (prompt.includes('Trigger: FINAL_READY')) {",
      "    emit(JSON.stringify({ assessment: 'ok', advice: 'ready for review' }))",
      '  } else {',
      "    writeFileSync('export.ts', 'export const exportCsv = () => \"csv\"\\n')",
      "    emit('Implemented exportCsv helper')",
      '  }',
      '})',
      '',
    ].join('\n'),
  )
  let fakeCommand: string
  if (process.platform === 'win32') {
    fakeCommand = join(dir, 'fake-codex.cmd')
    writeFileSync(fakeCommand, `@echo off\r\nnode "%dp0%\\fake-codex.mjs" %*\r\n`)
  } else {
    fakeCommand = join(dir, 'fake-codex')
    writeFileSync(fakeCommand, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`)
    chmodSync(fakeCommand, 0o755)
  }

  const workerId = 'w-e2e-flex'
  const identity = loadIdentity(join(dir, 'identity.key'), true)
  const { token } = hub.ctx.auth.createEnrollToken(owner, workerId)
  hub.ctx.auth.enroll(
    {
      token,
      workerId,
      publicKey: identity.publicKey,
      hostname: 'flex-e2e',
      os: process.platform as 'win32' | 'linux' | 'darwin',
    },
    '127.0.0.1',
  )

  const configPath = join(dir, 'worker.yaml')
  writeFileSync(
    configPath,
    JSON.stringify({
      workerId,
      hub: { url: wsUrl(hub.address!) },
      adapters: {
        codex: { enabled: true, command: fakeCommand, env: { OPENAI_API_KEY: 'sk-test-e2e' } },
      },
      workspaces: [
        {
          id: 'soren',
          label: 'Soren',
          path: wsRoot,
          allowedAdapters: ['codex'],
          maxProfile: 'edit',
        },
      ],
    }),
  )

  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../worker/bin/agent-worker.mjs'), 'run', '--config', configPath],
    {
      env: { ...process.env, LOCALAPPDATA: dir, APPDATA: dir },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    },
  )
  const closed = once(child, 'close')
  cleanup.push(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
    await closed
  })

  await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 20_000 })

  const { cookie, csrfToken } = await login(rest(hub))
  const api = rest(hub)

  const preflight = await api('POST', '/api/v1/personal/preflight', {
    cookie,
    csrf: csrfToken,
    origin: ORIGIN,
    payload: { workerId, workspaceId: 'soren', subdir: 'Forma', mode: 'flexible', autoCommit: true, autoPush: false },
  })
  expect(preflight.status).toBe(200)
  expect(preflight.json()).toMatchObject({ ok: true, noChecks: true, checks: ['self-check'] })

  const projectId = 'aut_e2e_flex_01'
  const started = await api('POST', '/api/v1/personal/autopilot', {
    cookie,
    csrf: csrfToken,
    origin: ORIGIN,
    payload: {
      projectId,
      workerId,
      workspaceId: 'soren',
      subdir: 'Forma',
      inlinePrompt: '新增 exportCsv 导出函数',
      autoCommit: true,
      autoPush: false,
    },
  })
  expect(started.status).toBe(201)

  let doneView: { phase: string; last_commit: string | null }
  try {
    doneView = await eventually(
      () => {
        const rows = hub.ctx.store.repos.prepare('SELECT phase, last_commit FROM personal_projects WHERE id=?').get(projectId) as
          | { phase: string; last_commit: string | null }
          | undefined
        return rows?.phase === 'done' ? rows : false
      },
      { timeoutMs: 25_000 },
    )
  } catch (err) {
    const db = hub.ctx.store.repos
    const proj = db.prepare('SELECT id, phase, control, reason, current_item, plan_task_id, plan_run_id, last_commit FROM personal_projects WHERE id=?').get(projectId)
    const items = db.prepare('SELECT * FROM personal_items WHERE project_id=?').all(projectId)
    const steps = db.prepare('SELECT task_id, item_id, kind, ordinal, run_id, result_json FROM personal_steps WHERE project_id=?').all(projectId)
    const tasks = db.prepare('SELECT id, task_no, status, profile, adapter, title FROM tasks').all()
    const runs = db.prepare('SELECT id, task_id, status, error_code, verification_status, summary FROM task_runs').all()
    throw new Error(`${String(err)}\nDEBUG proj=${JSON.stringify(proj)}\nitems=${JSON.stringify(items)}\nsteps=${JSON.stringify(steps)}\ntasks=${JSON.stringify(tasks)}\nruns=${JSON.stringify(runs)}`)
  }
  expect(doneView.last_commit).toMatch(/^[0-9a-f]{40}$/u)
  expect(existsSync(join(formaRoot, 'export.ts'))).toBe(true)
  expect(readFileSync(join(formaRoot, 'TASKS.md'), 'utf8')).toContain('T01')
  expect(git(formaRoot, 'rev-parse', 'HEAD')).toBe(doneView.last_commit)

  const report = await api('GET', `/api/v1/personal/projects/${projectId}/reports`, {
    cookie,
    origin: ORIGIN,
  })
  expect(report.status).toBe(200)
  const reportText = JSON.stringify(report.json())
  expect(reportText).toContain('结论：已具备人工验收条件。')
  expect(reportText).toContain('未推送（本地提交模式）')
}, 60_000)

it('executes full flexible autopilot lifecycle with subdir-bound verify_final check and autoCommit: false (Round 3 P1 #7)', async () => {
  useAdminToken()
  const transport = new PiFeishuTransport()
  const { hub, dir, cleanup: closeHub } = await openHarness(
    {
      ...settings,
      feishu: {
        enabled: true,
        ownerOpenIds: ['ou_owner'],
        defaultWorkspaceId: 'soren',
      },
    },
    { feishuTransport: transport },
  )
  cleanup.push(closeHub)

  const wsRoot = join(dir, 'soren')
  const formaRoot = join(wsRoot, 'Forma')
  mkdirSync(formaRoot, { recursive: true })
  git(formaRoot, 'init', '-q', '-b', 'main')
  git(formaRoot, 'config', 'user.name', 'Test User')
  git(formaRoot, 'config', 'user.email', 'test@localhost')
  writeFileSync(join(formaRoot, 'README.md'), '# Forma\nInitial readme\n')
  writeFileSync(
    join(formaRoot, 'check-forma.mjs'),
    "import { basename } from 'node:path'\nif (basename(process.cwd()) !== 'Forma') process.exit(2)\nconsole.log('forma-verified')\n",
  )
  git(formaRoot, 'add', 'README.md', 'check-forma.mjs')
  git(formaRoot, 'commit', '-qm', 'init')

  const fakeScript = join(dir, 'fake-codex-nc.mjs')
  writeFileSync(
    fakeScript,
    [
      "import { writeFileSync } from 'node:fs'",
      "if (process.argv.includes('--version')) { console.log('codex-cli 0.99.0'); process.exit(0) }",
      "let prompt = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', c => { prompt += c })",
      "process.stdin.on('end', () => {",
      '  const emit = text => process.stdout.write(',
      "    JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text } }) + '\\n' +",
      "    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }) + '\\n'",
      '  )',
      "  if (prompt.includes('Produce an ordered implementation plan')) {",
      "    emit(JSON.stringify({ items: [{ id: 'T01', title: 'Add export helper', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['forma-unit'] }] }))",
      "  } else if (prompt.includes('Trigger: PLAN_READY')) {",
      "    emit(JSON.stringify({ assessment: 'ok', advice: 'proceed' }))",
      "  } else if (prompt.includes('Trigger: review')) {",
      "    emit(JSON.stringify({ decision: 'PASS', findings: [] }))",
      "  } else if (prompt.includes('Trigger: FINAL_READY')) {",
      "    emit(JSON.stringify({ assessment: 'ok', advice: 'ready for review' }))",
      '  } else {',
      "    writeFileSync('export.ts', 'export const exportCsv = () => \"csv\"\\n')",
      "    emit('Implemented exportCsv helper')",
      '  }',
      '})',
      '',
    ].join('\n'),
  )
  let fakeCommand: string
  if (process.platform === 'win32') {
    fakeCommand = join(dir, 'fake-codex-nc.cmd')
    writeFileSync(fakeCommand, `@echo off\r\nnode "%~dp0\\fake-codex-nc.mjs" %*\r\n`)
  } else {
    fakeCommand = join(dir, 'fake-codex-nc')
    writeFileSync(fakeCommand, `#!/usr/bin/env sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeScript)} "$@"\n`)
    chmodSync(fakeCommand, 0o755)
  }

  const workerId = 'w-e2e-nc'
  const identity = loadIdentity(join(dir, 'identity.key'), true)
  const { token } = hub.ctx.auth.createEnrollToken(owner, workerId)
  hub.ctx.auth.enroll(
    {
      token,
      workerId,
      publicKey: identity.publicKey,
      hostname: 'flex-nc',
      os: process.platform as 'win32' | 'linux' | 'darwin',
    },
    '127.0.0.1',
  )

  const configPath = join(dir, 'worker-nc.yaml')
  writeFileSync(
    configPath,
    JSON.stringify({
      workerId,
      hub: { url: wsUrl(hub.address!) },
      harness: { enabled: true },
      adapters: {
        codex: { enabled: true, command: fakeCommand, env: { OPENAI_API_KEY: 'sk-test-nc' } },
      },
      workspaces: [
        {
          id: 'soren',
          label: 'Soren',
          path: wsRoot,
          allowedAdapters: ['codex'],
          maxProfile: 'edit',
          harness: {
            verify: {
              commands: [{ id: 'forma-unit', cwd: 'Forma', argv: [process.execPath, 'check-forma.mjs'] }],
            },
          },
        },
      ],
    }),
  )

  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../worker/bin/agent-worker.mjs'), 'run', '--config', configPath],
    {
      env: { ...process.env, LOCALAPPDATA: dir, APPDATA: dir },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    },
  )
  const closed = once(child, 'close')
  cleanup.push(async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
    await closed
  })

  await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online', { timeoutMs: 20_000 })
  const { cookie, csrfToken } = await login(rest(hub))
  const api = rest(hub)

  const preflight = await api('POST', '/api/v1/personal/preflight', {
    cookie,
    csrf: csrfToken,
    origin: ORIGIN,
    payload: { workerId, workspaceId: 'soren', subdir: 'Forma', mode: 'flexible', autoCommit: false, autoPush: false },
  })
  expect(preflight.status).toBe(200)
  expect(preflight.json(), JSON.stringify(preflight.json())).toMatchObject({ ok: true, checks: ['forma-unit'] })
  expect(preflight.json().noChecks).toBeUndefined()

  const projectId = 'aut_e2e_nc_01'
  const started = await api('POST', '/api/v1/personal/autopilot', {
    cookie,
    csrf: csrfToken,
    origin: ORIGIN,
    payload: {
      projectId,
      workerId,
      workspaceId: 'soren',
      subdir: 'Forma',
      inlinePrompt: '新增 exportCsv 并通过 forma-unit 检查',
      autoCommit: false,
      autoPush: false,
    },
  })
  expect(started.status).toBe(201)

  const doneView = await eventually(
    () => {
      const row = hub.ctx.store.repos.prepare('SELECT phase, last_commit FROM personal_projects WHERE id=?').get(projectId) as
        | { phase: string; last_commit: string | null }
        | undefined
      return row?.phase === 'done' ? row : false
    },
    { timeoutMs: 25_000 },
  )
  expect(doneView.last_commit).toBeNull()
  expect(existsSync(join(formaRoot, 'export.ts'))).toBe(true)

  const report = await api('GET', `/api/v1/personal/projects/${projectId}/reports`, {
    cookie,
    origin: ORIGIN,
  })
  expect(report.status).toBe(200)
  const reportText = JSON.stringify(report.json())
  expect(reportText).toContain('结论：已具备人工验收条件。')
  expect(reportText).toContain('forma-unit · passed · exit 0')
  expect(reportText).toContain('verify_final')
}, 60_000)
