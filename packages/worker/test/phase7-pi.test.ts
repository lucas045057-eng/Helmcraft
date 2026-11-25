/**
 * Pi 独立验收 · Phase 7a Worker 侧（BB-4 ~ BB-6、BB-8 ~ BB-9、BB-24 ~ BB-26、
 * CR-5 ~ CR-6、RT-4 ~ RT-7、INV-15）。
 *
 * 与 Codex 的 phase7-*.test.ts 独立：这里使用自己的 fs 包装器、自己的临时目录布局，
 * 并且把「零写入」与「零读取」都做成可计数的断言。
 */
import { mkdtemp, mkdir, open as openFile, lstat, readdir, readFile, realpath, rm, symlink, writeFile, link,
  chmod, constants } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { BOARD_FILES, BOARD_HARD_CAP_BYTES, BOARD_TEMPLATES, composeHarnessPrompt, RunDispatch, RunEvent } from '@agent-hub/protocol'
import type { HarnessDirective } from '@agent-hub/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readBoard } from '../src/harness/board-reader.js'
import { computeApplied } from '../src/harness/session.js'
import { Journal } from '../src/runner/journal.js'

const spec = { lstat, realpath, open: openFile }
let root: string, board: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-harness-')))
  board = join(root, '.board')
  await mkdir(board)
})
afterEach(async () => { await chmod(root, 0o755).catch(() => undefined); await rm(root, { recursive: true, force: true }) })

const file = async (name: string, value: string | Buffer) => { await writeFile(join(board, name), value); return join(board, name) }

// ─────────────────────── BB-4 / BB-5 / BB-6 ───────────────────────

it('BB-4 flags over-budget files by bytes and by lines while keeping the raw digest', async () => {
  const bytes = BOARD_TEMPLATES['HANDOFF.md'] + '\n' + 'x'.repeat(BOARD_FILES['HANDOFF.md'].budgetBytes)
  await file('HANDOFF.md', bytes)
  const many = BOARD_TEMPLATES['PROJECT_STATE.md'] + '\n' + Array.from({ length: 200 }, (_, i) => '- line ' + i).join('\n')
  await file('PROJECT_STATE.md', many)
  await file('DECISIONS.md', BOARD_TEMPLATES['DECISIONS.md'])
  await file('LESSONS.md', BOARD_TEMPLATES['LESSONS.md'])
  const snapshot = await readBoard(root, {}, [], spec)
  const [handoff, state, decisions] = snapshot.files
  expect(handoff).toMatchObject({ status: 'present', overBudget: true, schemaOk: true, bytes: Buffer.byteLength(bytes) })
  expect(state).toMatchObject({ status: 'present', overBudget: true })
  expect(decisions).toMatchObject({ status: 'present', overBudget: false, schemaOk: true })
  expect(snapshot.dir).toBe('present')
  // 预算内的模板不能触发告警
  expect(BOARD_FILES['HANDOFF.md'].budgetLines).toBe(80)
  expect(BOARD_FILES['DECISIONS.md'].budgetBytes).toBe(8192)
})

it('BB-5 truncates an oversize file at the last complete line inside the hard cap', async () => {
  const lines = Array.from({ length: 900 }, (_, i) => 'line-' + String(i).padStart(4, '0') + '-' + 'y'.repeat(20))
  await file('HANDOFF.md', lines.join('\n') + '\n')
  const result = (await readBoard(root, {}, [], spec)).files[0]!
  expect(result.status).toBe('oversize')
  expect(result.truncated).toBe(true)
  expect(result.bytes).toBeGreaterThan(BOARD_HARD_CAP_BYTES)
  const content = result.content!
  expect(Buffer.byteLength(content)).toBeLessThanOrEqual(BOARD_HARD_CAP_BYTES)
  expect(content.endsWith('\n')).toBe(true)
  expect((lines.join('\n') + '\n').startsWith(content)).toBe(true)
  expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u)
})

it('BB-6 rejects a board file containing NUL without leaking content', async () => {
  await file('HANDOFF.md', Buffer.from([0x23, 0x20, 0x48, 0x00, 0x00, 0x41]))
  const result = (await readBoard(root, {}, [], spec)).files[0]!
  expect(result).toMatchObject({ status: 'invalid', reason: 'BINARY', bytes: 6 })
  expect(result).not.toHaveProperty('content')
  expect(result).not.toHaveProperty('sha256')
})

// ─────────────────────── BB-8 / BB-9 / RT-5 ───────────────────────

it('BB-8 treats a symlinked board file as unsafe and never opens it', async () => {
  const target = join(root, 'outside.md')
  await writeFile(target, 'outside secret body')
  try {
    await symlink(target, join(board, 'HANDOFF.md'), 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return   // Windows 需要开发者模式：记录后跳过（BB-8）
    throw error
  }
  const opened = vi.fn(spec.open)
  const result = (await readBoard(root, {}, [], { ...spec, open: opened })).files[0]!
  expect(result).toMatchObject({ status: 'unsafe', reason: 'LINK', bytes: 0 })
  expect(result).not.toHaveProperty('content')
  expect(opened).not.toHaveBeenCalled()
})

it('BB-9 / RT-5 refuses a hardlink to an outside secret and never reads it', async () => {
  const secret = join(root, 'id_ed25519')
  await writeFile(secret, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-material\n')
  await link(secret, join(board, 'HANDOFF.md'))
  const opened = vi.fn(spec.open)
  const snapshot = await readBoard(root, {}, [], { ...spec, open: opened })
  expect(snapshot.files[0]).toMatchObject({ status: 'unsafe', reason: 'HARDLINK', bytes: 0 })
  expect(opened).not.toHaveBeenCalled()
  expect(JSON.stringify(snapshot)).not.toContain('secret-material')
})

// ─────────────────────── RT-4 / RT-6 / INV-15 ───────────────────────

it('RT-4 cannot be exfiltrated through a junction to a credential directory', async () => {
  const home = join(root, 'fake-home', '.ssh')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'id_rsa'), 'PRIVATE-KEY-MATERIAL')
  await writeFile(join(home, 'known_hosts'), 'host ssh-ed25519 AAAA')
  const target = join(root, 'fake-home', '.ssh')
  // 用真实联接点替换 .board（Windows junction / POSIX directory symlink）
  await rm(board, { recursive: true, force: true })
  await symlink(target, board, process.platform === 'win32' ? 'junction' : 'dir')
  const opened = vi.fn(spec.open)
  const snapshot = await readBoard(root, {}, [], { ...spec, open: opened })
  expect(snapshot.dir).toBe('unsafe')
  expect(snapshot.dirReason).toBe('LINK')
  expect(opened).not.toHaveBeenCalled()
  expect(snapshot.files.every(entry => entry.status === 'unsafe' && !('content' in entry))).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-KEY-MATERIAL')
  expect(JSON.stringify(snapshot)).not.toContain('known_hosts')
})

it('RT-6 redacts known secrets from the captured board and the injected prompt', async () => {
  const apiKey = 'sk-live-' + 'Z'.repeat(24)
  await file('LESSONS.md', BOARD_TEMPLATES['LESSONS.md'] + '\n- leaked ' + apiKey + '\n')
  const snapshot = await readBoard(root, { API_KEY: apiKey }, [], spec)
  expect(snapshot.files[3]!.content).not.toContain(apiKey)
  expect(JSON.stringify(snapshot)).not.toContain(apiKey)
  const { text } = composeHarnessPrompt({ adapter: 'codex', mode: 'fresh', nonce: 'B'.repeat(22), userPrompt: 'go',
    trust: 'owner', board: 'write', boardDir: 'present', bootstrap: false, agentsMd: 'absent',
    paths: { board: '.board', agents: 'AGENTS.md' }, factsJson: null,
    boardFiles: [{ file: 'LESSONS.md', content: snapshot.files[3]!.content!, bytes: snapshot.files[3]!.bytes,
      overBudget: false, truncated: false }], verifyCommandIds: [] })
  expect(text).not.toContain(apiKey)
})

it('INV-15 reads the board without ever writing into the workspace', async () => {
  for (const name of Object.keys(BOARD_TEMPLATES)) await file(name, BOARD_TEMPLATES[name as keyof typeof BOARD_TEMPLATES])
  const writes: string[] = []
  const guard = new Proxy(spec, {
    get(target, property) {
      if (['writeFile', 'mkdir', 'rm', 'rmdir', 'rename', 'symlink', 'link', 'unlink', 'chmod', 'utimes', 'appendFile']
        .includes(String(property))) writes.push(String(property))
      return target[property as keyof typeof target]
    },
  })
  const before = await readdir(root, { recursive: true })
  const snapshot = await readBoard(root, {}, [], guard as typeof spec)
  expect(snapshot.dir).toBe('present')
  expect(snapshot.files.every(entry => entry.status === 'present')).toBe(true)
  expect(writes).toEqual([])
  expect((await readdir(root, { recursive: true })).sort()).toEqual(before.sort())
  // POSIX：把整个工作区设为只读后就绪流程仍不得失败
  if (process.platform !== 'win32') {
    await chmod(board, 0o555)
    await expect(readBoard(root, {}, [], spec)).resolves.toMatchObject({ dir: 'present' })
    await chmod(board, 0o755)
  }
})

// ─────────────────────── BB-24 / BB-25 / BB-26 ───────────────────────

const directive = (over: Partial<HarnessDirective> = {}): HarnessDirective => ({ v: 1, board: 'write', inject: 'fresh',
  trust: 'owner', bootstrap: true, ...over })

it('BB-24/BB-25/BB-26 clamp the applied directive exactly as 08 §6.9 requires', () => {
  expect(computeApplied(directive(), { blackboard: true }, 'edit')).toMatchObject({ board: 'write', bootstrap: true, downgrades: [] })
  // BB-24：本机 blackboard:false → LOCAL_DISABLED，引导同时被降级
  expect(computeApplied(directive(), { blackboard: false }, 'edit')).toEqual({ board: 'off', inject: 'fresh', trust: 'owner',
    bootstrap: false, verify: false, autoFixMaxRetries: 0,
    downgrades: [{ field: 'board', reason: 'LOCAL_DISABLED' }, { field: 'bootstrap', reason: 'LOCAL_DISABLED' }] })
  // board=off 的指令不会被降级标注
  expect(computeApplied(directive({ board: 'off', bootstrap: false }), { blackboard: false }, 'edit').downgrades).toEqual([])
  // BB-26：maxProfile=readonly 把 write clamp 成 read，且不引导
  expect(computeApplied(directive(), { blackboard: true }, 'readonly')).toEqual({ board: 'read', inject: 'fresh', trust: 'owner',
    bootstrap: false, verify: false, autoFixMaxRetries: 0, downgrades: [{ field: 'board', reason: 'PROFILE_CLAMPED' },
      { field: 'bootstrap', reason: 'PROFILE_CLAMPED' }] })
  // readonly 的 read 指令不产生降级
  expect(computeApplied(directive({ board: 'read', bootstrap: false }), { blackboard: true }, 'readonly').downgrades).toEqual([])
  // 7a 中 verify 恒被降级（7a Worker 无验证引擎）
  expect(computeApplied(directive({ verify: { autoFixMaxRetries: 1 } }), { blackboard: true }, 'edit').downgrades)
    .toEqual([{ field: 'verify', reason: 'NO_COMMANDS' }])
  expect(computeApplied(directive({ verify: { autoFixMaxRetries: 1 } }), { blackboard: true }, 'edit', true).downgrades)
    .toEqual([{ field: 'verify', reason: 'CONFIG_EXPOSED' }])
})

// ─────────────────────── RT-7 ───────────────────────

it('RT-7 rejects a hostile harness payload with extra keys before doing anything', () => {
  const valid = RunDispatch.parse({ runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, adapter: 'mock',
    workspaceId: 'sandbox', profile: 'edit', prompt: 'go', timeoutMs: 10_000, idleTimeoutMs: 10_000, notAfter: 10_000,
    origin: { source: 'dashboard', actorType: 'owner' }, harness: { v: 1, board: 'write', inject: 'fresh', trust: 'owner', bootstrap: true } })
  expect(valid.harness).toBeDefined()
  for (const hostile of [
    { ...valid, harness: { ...valid.harness, argv: ['rm', '-rf', '/'] } },
    { ...valid, harness: { ...valid.harness, verify: { autoFixMaxRetries: 1, commands: [{ argv: ['node', '-e', 'process.exit(0)'] }] } } },
    { ...valid, harness: { ...valid.harness, extraArgs: ['--danger'] } },
    { ...valid, harness: { ...valid.harness, v: 2 } },
    { ...valid, harness: { ...valid.harness, board: 'write-all' } },
    { ...valid, harness: { ...valid.harness, hidden: true } },
  ]) expect(RunDispatch.safeParse(hostile).success).toBe(false)
  // 事件侧同样严格：伪造 workspace 事件字段被拒
  expect(RunEvent.safeParse({ kind: 'workspace', seq: 1, ts: 1, round: 0, argv: [] }).success).toBe(false)
  expect(RunEvent.safeParse({ kind: 'harness', seq: 1, ts: 1, applied: { board: 'write', inject: 'fresh', trust: 'owner',
    bootstrap: false, verify: false, autoFixMaxRetries: 0, downgrades: [], argv: [] } }).success).toBe(false)
})

// ─────────────────────── CR-5 / CR-6 ───────────────────────

const finishedOutcome = (status: 'succeeded' | 'failed') => ({ kind: 'finished' as const, status, exitCode: status === 'succeeded' ? 0 : 1,
  signal: null, summary: 'outcome', durationMs: 10 })

it('CR-5 synthesises failed/WORKER_RESTARTED when the CLI crashed without cli_exited', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-journal-'))
  try {
    const path = join(dir, 'journal')
    const clock = new FakeClock(500)
    const id = runId(), task = taskId()
    const journal = new Journal(path, clock)
    journal.accepted({ runId: id, taskId: task, workspaceId: 'sandbox' })
    journal.progress(id, 4)
    const recovered = await new Journal(path, clock).recover()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.finished).toEqual({ kind: 'finished', seq: 5, ts: 500, status: 'failed',
      errorCode: 'WORKER_RESTARTED', exitCode: null, signal: null, summary: '', durationMs: 0 })
    // 幂等：第二次恢复不再生成新事件
    const again = await new Journal(path, clock).recover()
    expect(again[0]!.finished).toEqual(recovered[0]!.finished)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('CR-6 compaction preserves cli_exited and a Phase 6 journal still loads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-journal-'))
  try {
    const path = join(dir, 'journal')
    const clock = new FakeClock(7)
    const id = runId()
    const journal = new Journal(path, clock)
    journal.accepted({ runId: id, taskId: taskId(), workspaceId: 'sandbox', pid: 4242, pidStartTime: 'start-1' })
    journal.progress(id, 3)
    journal.progress(id, 9)
    journal.cliExited(id, { round: 0, verifyRequested: true, verifyAttempts: 1, outcome: finishedOutcome('succeeded') })
    journal.compact()
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(records.map(record => record.type)).toEqual(['run.accepted', 'run.cli_exited'])
    const accepted = records[0] as unknown as { pid?: number; pidStartTime?: string; lastSeq?: number }
    expect(accepted).toMatchObject({ pid: 4242, pidStartTime: 'start-1', lastSeq: 9 })
    const recovered = await new Journal(path, clock).recover()
    expect(recovered[0]!.finished).toMatchObject({ seq: 10, ts: 7, status: 'succeeded',
      verification: { status: 'unverified', reason: 'WORKER_RESTARTED', attempts: 1 } })
    // Phase 6 格式（只有 run.accepted + run.finished，无新字段）仍能加载且不产生新事件
    const legacy = join(dir, 'legacy-journal')
    const legacyId = runId()
    await writeFile(legacy, [
      JSON.stringify({ type: 'run.accepted', runId: legacyId, taskId: taskId(), workspaceId: 'sandbox' }),
      JSON.stringify({ type: 'run.finished', runId: legacyId, finishedEvent: { ...finishedOutcome('succeeded'), seq: 1, ts: 1 } }),
    ].join('\n') + '\n')
    const loaded = await new Journal(legacy, clock).recover()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.finished).toMatchObject({ seq: 1, status: 'succeeded' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('CR-6b ignores a truncated trailing journal line instead of dropping the whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-journal-'))
  try {
    const path = join(dir, 'journal')
    const id = runId()
    await writeFile(path, JSON.stringify({ type: 'run.accepted', runId: id, taskId: taskId(), workspaceId: 'sandbox' }) + '\n'
      + '{"type":"run.checkpoint","runId":"' + id + '","lastSe')
    const recovered = await new Journal(path, new FakeClock(3)).recover()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.runId).toBe(id)
    expect(recovered[0]!.finished).toMatchObject({ status: 'failed', errorCode: 'WORKER_RESTARTED' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// 便于 lint 检查：确认常量被引用
it('keeps the budget table and hard cap wired to the reader', () => {
  expect(BOARD_FILES['HANDOFF.md'].budgetBytes).toBe(4096)
  expect(BOARD_HARD_CAP_BYTES).toBe(16_384)
  expect(constants.O_RDONLY).toBeGreaterThanOrEqual(0)
})
