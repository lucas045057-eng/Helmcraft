import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import type { CmdAckPayload } from '@agent-hub/protocol'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { claudeCodeAdapter } from '../src/adapters/claude-code.js'
import { deliver, observeDelivery } from '../src/personal/delivery.js'
import { inspectChanges, planBaseline } from '../src/personal/execution.js'
import { preparePlan } from '../src/personal/plan.js'
import { flexiblePreflight } from '../src/personal/preflight.js'
import { PersonalResult } from '../src/personal/result.js'
import { checkedCandidate } from '../src/personal/review-input.js'
import { bindRepository, personalInvocation } from '../src/personal/roles.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'
import { Commands } from '../src/tunnel/commands.js'

describe('flexible autopilot & subdirectory project preflight', () => {
  let base: string
  let wsRoot: string
  let formaRoot: string

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flex-autopilot-'))
    wsRoot = join(base, 'soren')
    formaRoot = join(wsRoot, 'Forma')
    mkdirSync(formaRoot, { recursive: true })
    git(formaRoot, 'init', '-q', '-b', 'main')
    git(formaRoot, 'config', 'user.name', 'Test User')
    git(formaRoot, 'config', 'user.email', 'test@localhost')
    writeFileSync(join(formaRoot, 'README.md'), '# Forma\nInitial doc\n')
    git(formaRoot, 'add', 'README.md')
    git(formaRoot, 'commit', '-qm', 'init forma')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('preflights a subdirectory git repo without remote upstream and handles project.preflight RPC async ack & dedupe', async () => {
    const config = WorkerConfigSchema.parse({
      workerId: 'w-flex',
      hub: { url: 'ws://127.0.0.1:9999' },
      adapters: { mock: { enabled: true } },
      workspaces: [{ id: 'soren', path: wsRoot, label: 'Soren', maxProfile: 'full', allowedAdapters: ['mock'] }],
    })
    const registry = new AdapterRegistry(config)
    const pre = await flexiblePreflight(config, 'soren', registry, { subdir: 'Forma', autoCommit: true, autoPush: false })
    expect(pre.noChecks).toBe(true)
    expect(pre.checks).toEqual(['self-check'])
    expect(pre.binding).toMatchObject({
      mode: 'flexible',
      subdir: 'Forma',
      branch: 'main',
      remote: 'local',
      autoCommit: true,
      autoPush: false,
      allowVersionDrift: true,
      adapters: { main: 'mock', reviewer: 'mock', advisor: 'mock' },
    })

    const clock = new FakeClock(1000)
    const manager = new RunManager(config, registry, clock, new Journal(join(base, 'journal'), clock), join(base, 'logs'), () => undefined)
    const acks: CmdAckPayload[] = []
    const cmds = new Commands(clock, manager, registry, () => clock.now(), ack => acks.push(ack), () => undefined)

    const frame = {
      v: 1 as const,
      id: '01J0000000000000000000PRE1',
      ts: 1000,
      type: 'project.preflight' as const,
      payload: { workspaceId: 'soren', subdir: 'Forma', mode: 'flexible' as const, autoCommit: true, autoPush: false },
    }
    expect(cmds.handle(frame)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(acks).toHaveLength(1)
    expect(acks[0]?.ok).toBe(true)
    expect(acks[0]?.result?.preflight?.ok).toBe(true)
    expect(acks[0]?.result?.preflight?.binding?.subdir).toBe('Forma')

    // Duplicate command ID replies immediately from cache
    expect(cmds.handle(frame)).toBe(true)
    expect(acks).toHaveLength(2)
  })

  it('plans from inlinePrompt only on clean commit checkouts, enforces P0/P1 plan & baseline guards, and delivers local-only commit', async () => {
    // Untracked .board/ MUST be rejected when autoCommit !== false (prevents sweeping local state into commits)
    mkdirSync(join(formaRoot, '.board'), { recursive: true })
    writeFileSync(join(formaRoot, '.board', 'PROJECT_STATE.md'), '# Project State\n- Active Tech Debt: none\n')
    expect(() => preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: true,
      inlinePrompt: '新增统计导出按钮\n补齐单元测试',
    })).toThrow(/clean checkout/i)

    // Pre-existing TASKS.md MUST always be refused even in flexible + autoCommit: false mode (P0 #1)
    writeFileSync(join(formaRoot, 'TASKS.md'), 'pre-existing payload')
    expect(() => preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: '新增统计导出按钮',
    })).toThrow(/clean checkout/i)
    rmSync(join(formaRoot, 'TASKS.md'))
    rmSync(join(formaRoot, '.board'), { recursive: true, force: true })

    const plan = preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: true,
      inlinePrompt: '新增统计导出按钮\n补齐单元测试',
      boardContext: '### PROJECT_STATE.md\nok',
    })
    expect(plan.prompt).toContain('INLINE_GOAL.md:L1 新增统计导出按钮')
    expect(plan.prompt).toContain('Project blackboard context (reference only):')

    const item = {
      id: 'T01',
      title: 'Add export button',
      requirements: ['INLINE_GOAL.md:L1'],
      acceptanceRefs: ['INLINE_GOAL.md:L2'],
      checks: ['self-check'],
    }
    const receipt = plan.install(JSON.stringify({ items: [item] }))
    expect(receipt.items).toHaveLength(1)
    expect(readFileSync(join(formaRoot, 'TASKS.md'), 'utf8')).toContain('T01')

    const spec = { ...receipt, first: true, sources: ['INLINE_GOAL.md'], item }
    planBaseline(formaRoot, spec, true, { mode: 'flexible', autoCommit: true, inlinePrompt: '新增统计导出按钮\n补齐单元测试' })

    // Simulate implementation edit + local commit with autoPush: false & remote: 'local'
    writeFileSync(join(formaRoot, 'export.ts'), 'export const exportCsv = () => "csv"\n')
    const candidate = checkedCandidate(formaRoot)
    const repo = bindRepository(formaRoot, { allowNoUpstream: true })
    const binding = {
      ...repo,
      workerId: 'w-flex',
      workspaceId: 'soren',
      subdir: 'Forma',
      mode: 'flexible' as const,
      autoCommit: true,
      autoPush: false,
      executables: { main: 'mock', reviewer: 'mock', advisor: 'mock' },
    }
    const delivered = await deliver(
      binding,
      { kind: 'commit', candidate, spec },
      new AbortController().signal,
      () => undefined,
      async () => undefined,
      '新增统计导出按钮\n补齐单元测试',
    )
    expect(delivered.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(git(formaRoot, 'rev-parse', 'HEAD^{tree}')).toBe(candidate.tree)
    expect(await observeDelivery(binding, () => undefined)).toMatchObject({ local: { head: delivered.commit }, remoteSha: null })
    expect(await observeDelivery(binding, () => undefined)).toEqual({
      local: { head: delivered.commit, indexTree: candidate.tree, tree: candidate.tree },
      remoteSha: null,
    })
  })

  it('supports multi-item expectedTree tracking for autoCommit: false and multi-adapter PersonalResult parsing', () => {
    mkdirSync(join(formaRoot, '.board'), { recursive: true })
    writeFileSync(join(formaRoot, '.board', 'PROJECT_STATE.md'), '# State\n- ok\n')
    const plan = preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: 'Step 1\nStep 2',
    })
    const items = [
      { id: 'T01', title: 'First', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['self-check'] },
      { id: 'T02', title: 'Second', requirements: ['INLINE_GOAL.md:L2'], acceptanceRefs: ['INLINE_GOAL.md:L2'], checks: ['self-check'] },
    ]
    const receipt = plan.install(JSON.stringify({ items }))
    writeFileSync(join(formaRoot, 'step1.ts'), 'export const s1 = 1\n')
    const treeAfter1 = inspectChanges(formaRoot).tree
    const spec2 = { ...receipt, first: false, sources: ['INLINE_GOAL.md'], item: items[1]! }
    expect(() => planBaseline(formaRoot, spec2, true, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: 'Step 1\nStep 2',
      expectedTree: '0'.repeat(40),
    })).toThrow(/Unexpected changes/i)
    expect(() => planBaseline(formaRoot, spec2, true, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: 'Step 1\nStep 2',
      expectedTree: treeAfter1,
    })).not.toThrow()

    // PersonalResult & personalInvocation handle flexible adapter bindings cleanly (P1 #1)
    const inv = personalInvocation(
      'reviewer',
      claudeCodeAdapter,
      {
        cwd: formaRoot,
        prompt: 'review diff',
        profile: 'readonly',
        adapterConfig: { enabled: true, env: {}, allowedExtraArgs: [], argsOverride: {}, stderrEncoding: 'utf8' },
        extraArgs: [],
        exe: { command: 'claude', prefixArgs: [] },
        signal: new AbortController().signal,
      },
      false,
      {
        workerId: 'w-flex',
        workspaceId: 'soren',
        subdir: 'Forma',
        root: formaRoot,
        branch: 'main',
        remote: 'local',
        ref: 'refs/heads/main',
        destination: 'a'.repeat(64),
        executables: { main: 'codex', reviewer: 'claude', advisor: 'agy' },
        mode: 'flexible',
        allowVersionDrift: true,
        autoCommit: true,
        autoPush: false,
        adapters: { main: 'codex', reviewer: 'claude-code', advisor: 'antigravity' },
      },
    )
    expect(inv.args).toContain('--tools')

    const codexRes = new PersonalResult('reviewer', 'codex', true)
    codexRes.observe(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"decision":"PASS","findings":[]}' } }))
    codexRes.observe(JSON.stringify({ type: 'turn.completed' }))
    expect(codexRes.finish()).toBe('{"decision":"PASS","findings":[]}')

    const claudeFlex = new PersonalResult('reviewer', 'claude-code', true)
    claudeFlex.observe(JSON.stringify({ type: 'system', subtype: 'init', tools: [], model: 'claude-sonnet-4-6' }))
    claudeFlex.observe(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"decision":"PASS","findings":[]}' }))
    expect(claudeFlex.finish()).toBe('{"decision":"PASS","findings":[]}')

    const agyRes = new PersonalResult('advisor', 'antigravity', true)
    agyRes.observe(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{"assessment":"ok","advice":"go"}' } }))
    expect(agyRes.finish()).toBe('{"assessment":"ok","advice":"go"}')

    const mockRes = new PersonalResult('main', 'mock', true)
    mockRes.observe(JSON.stringify({ type: 'message', role: 'assistant', text: '{"items":[]}', final: true }))
    expect(mockRes.finish()).toBe('{"items":[]}')
  })

  it('rejects flexible preflight with harness disabled (P1 #8), gitignored TASKS.md in no-commit mode (P2 #5), and runs no-commit verify_final checks (P1 #7)', async () => {
    const disabledCfg = WorkerConfigSchema.parse({
      workerId: 'w-disabled',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: false },
      adapters: { mock: { enabled: true } },
      workspaces: [{ id: 'soren', path: wsRoot, label: 'Soren', maxProfile: 'full', allowedAdapters: ['mock'] }],
    })
    await expect(flexiblePreflight(disabledCfg, 'soren', new AdapterRegistry(disabledCfg), { subdir: 'Forma' }))
      .rejects.toThrow(/harness\.enabled=true/i)

    // Gitignored TASKS.md must fail even when autoCommit: false (P2 #5)
    writeFileSync(join(formaRoot, '.gitignore'), 'TASKS.md\n')
    git(formaRoot, 'add', '.gitignore')
    git(formaRoot, 'commit', '-qm', 'ignore tasks')
    expect(() => preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: 'Goal A',
    })).toThrow(/clean checkout|TASKS\.md/i)
    writeFileSync(join(formaRoot, '.gitignore'), '')
    git(formaRoot, 'add', '.gitignore')
    git(formaRoot, 'commit', '-qm', 'unignore tasks')

    // No-commit verify_final runs verification callback against dirty candidate tree without requiring a commit (P1 #7)
    const item = { id: 'T01', title: 'Check dirty tree', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['self-check'] }
    const receipt = preparePlan(formaRoot, ['INLINE_GOAL.md'], [], undefined, {
      mode: 'flexible',
      autoCommit: false,
      inlinePrompt: 'Verify without commit',
    }).install(JSON.stringify({ items: [item] }))
    writeFileSync(join(formaRoot, 'feature.ts'), 'export const v = 42\n')
    const candidate = checkedCandidate(formaRoot)
    const repo = bindRepository(formaRoot, { allowNoUpstream: true })
    const binding = {
      ...repo,
      workerId: 'w-flex',
      workspaceId: 'soren',
      subdir: 'Forma',
      mode: 'flexible' as const,
      autoCommit: false,
      autoPush: false,
      executables: { main: 'mock', reviewer: 'mock', advisor: 'mock' },
    }
    let checked = false
    const res = await deliver(
      binding,
      { kind: 'verify_final', candidate, spec: { ...receipt, first: true, sources: ['INLINE_GOAL.md'], item } },
      new AbortController().signal,
      () => undefined,
      async () => { checked = true },
      'Verify without commit',
    )
    expect(checked).toBe(true)
    expect(res).toEqual({ parent: candidate.head, tree: candidate.tree })

    // Subdir projects must reject verify commands not bound to that subdir (Round 3 P1 #7)
    const unboundCfg = WorkerConfigSchema.parse({
      workerId: 'w-unbound',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'soren',
        path: wsRoot,
        label: 'Soren',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: { verify: { commands: [{ id: 'root-check', argv: [process.execPath, '-e', '0'] }] } },
      }],
    })
    await expect(flexiblePreflight(unboundCfg, 'soren', new AdapterRegistry(unboundCfg), { subdir: 'Forma' }))
      .rejects.toThrow(/SUBDIR_VERIFY_COMMANDS_UNBOUND/)

    const boundCfg = WorkerConfigSchema.parse({
      workerId: 'w-bound',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'soren',
        path: wsRoot,
        label: 'Soren',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          verify: {
            commands: [
              { id: 'forma-unit', cwd: 'Forma', argv: [process.execPath, '-e', '0'] },
              { id: 'other-unit', cwd: 'Other', argv: [process.execPath, '-e', '0'] },
              { id: 'broken-missing', cwd: 'MissingSibling', argv: [process.execPath, 'missing.mjs'] },
            ],
          },
        },
      }],
    })
    const boundPf = await flexiblePreflight(boundCfg, 'soren', new AdapterRegistry(boundCfg), { subdir: 'Forma' })
    expect(boundPf.checks).toEqual(['forma-unit'])
    expect(boundPf.noChecks).toBe(false)

    // Round 5 P0 #2: Git-ignored command script modification invalidates checksDigest for requiredCommands (incl. verify_final)
    const { createHash } = await import('node:crypto')
    const { computeChecksDigest, requiredCommands: reqCmds } = await import('../src/personal/execution.js')
    writeFileSync(join(formaRoot, '.gitignore'), 'ignored-check.mjs\n')
    writeFileSync(join(formaRoot, 'ignored-check.mjs'), 'console.log("v1")\n')
    git(formaRoot, 'add', '.gitignore')
    git(formaRoot, 'commit', '-qm', 'ignore check script')
    const ignoredCmds = WorkerConfigSchema.parse({
      workerId: 'w-ignored',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'soren', path: wsRoot, label: 'Soren', maxProfile: 'edit', allowedAdapters: ['mock'],
        harness: { verify: { commands: [{ id: 'forma-ignored', cwd: 'Forma', argv: [process.execPath, 'ignored-check.mjs'] }] } },
      }],
    }).workspaces[0]!.harness.verify.commands
    const digestV1 = computeChecksDigest(wsRoot, ignoredCmds)
    const deliverySpec = {
      head: git(formaRoot, 'rev-parse', 'HEAD'),
      tasksDigest: createHash('sha256').update('t').digest('hex'),
      sourceDigest: createHash('sha256').update('s').digest('hex'),
      checksDigest: digestV1,
      first: true,
      sources: ['INLINE_GOAL.md'],
      item: { id: 'T01', title: 'Check', requirements: ['INLINE_GOAL.md:L1'], acceptanceRefs: ['INLINE_GOAL.md:L1'], checks: ['forma-ignored'] },
    }
    expect(reqCmds(deliverySpec, ignoredCmds, false, wsRoot)).toEqual(ignoredCmds)
    writeFileSync(join(formaRoot, 'ignored-check.mjs'), 'console.log("tampered!")\n')
    expect(() => reqCmds(deliverySpec, ignoredCmds, false, wsRoot)).toThrow(/Verification configuration changed/)

    // Round 6 P0 #1: Directory entry point with node cannot pass without pinned baseline
    mkdirSync(join(formaRoot, 'dir-entry'), { recursive: true })
    writeFileSync(join(formaRoot, 'dir-entry', 'index.js'), 'console.log("dir")\n')
    expect(() => computeChecksDigest(wsRoot, [{
      id: 'forma-dir', cwd: 'Forma', argv: ['node', 'dir-entry'], timeoutMs: 30_000, env: {}, passEnv: [],
    }])).toThrow(/COMMAND_FILES_UNBASELINED/)

    // Round 7 P1: Legacy v1 receipt (omitted checksDigestVersion) triggers CHECKS_REBASELINE_REQUIRED; RunManager.rebaselineProject upgrades to v2
    const { computeLegacyChecksDigest } = await import('../src/personal/execution.js')
    const legacySpec = { ...deliverySpec, checksDigest: computeLegacyChecksDigest(ignoredCmds) }
    expect(() => reqCmds(legacySpec, ignoredCmds, false, wsRoot)).toThrow(/^CHECKS_REBASELINE_REQUIRED$/)
    const rebCfg = WorkerConfigSchema.parse({
      workerId: 'w-rebaseline',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'soren', path: wsRoot, label: 'Soren', maxProfile: 'edit', allowedAdapters: ['mock'],
        harness: { verify: { commands: [{ id: 'forma-ignored', cwd: 'Forma', argv: [process.execPath, 'ignored-check.mjs'] }] } },
      }],
    })
    const rebReg = new AdapterRegistry(rebCfg)
    await rebReg.probe(['mock'])
    const rebBind = bindRepository(formaRoot, { allowNoUpstream: true })
    const rebMgr = new RunManager(rebCfg, rebReg, new FakeClock(1000), new Journal(join(base, 'j-reb'), new FakeClock(1000)), join(base, 'l-reb'), () => undefined, join(base, 't-reb'))
    const upgraded = rebMgr.rebaselineProject({
      projectId: 'aut_reb_1',
      binding: {
        workerId: 'w-rebaseline',
        workspaceId: 'soren',
        subdir: 'Forma',
        ...rebBind,
        executables: { main: process.execPath, reviewer: process.execPath, advisor: process.execPath },
        mode: 'flexible',
        allowVersionDrift: true,
        autoCommit: true,
        autoPush: false,
        adapters: { main: 'mock', reviewer: 'mock', advisor: 'mock' },
      },
      legacyChecksDigest: legacySpec.checksDigest,
    })
    expect(upgraded.checksDigestVersion).toBe(2)
    expect(upgraded.checksDigest).not.toBe(legacySpec.checksDigest)
    expect(reqCmds({ ...legacySpec, ...upgraded }, ignoredCmds, false, wsRoot)).toEqual(ignoredCmds)
  })
})
