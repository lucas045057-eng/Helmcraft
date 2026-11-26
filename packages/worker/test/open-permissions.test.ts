import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnvironment } from '../src/security/env.js'
import { filterExtraArgs } from '../src/security/args.js'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { loadWorkerConfig, loadWorkerReload } from '../src/config/load.js'
import { resolveWorkspaceSubdir } from '../src/security/workspace.js'
import { readBoard } from '../src/harness/board-reader.js'
import { computeApplied } from '../src/harness/session.js'

it('allows extra env and argv independently and always filters reserved keys and control characters', () => {
  const overrides = { SAMPLE: 'sample-value', aGeNt_WoRkEr_Key: 'protected', HuB_X: 'protected', NODE_OPTIONS: 'protected',
    node_path: 'protected', ELECTRON_RUN_AS_NODE: 'protected', WORKER_IDENTITY: 'protected', WORKER_PRIVATE_KEY: 'protected' }
  const adapter = { env: {}, passEnv: [] }
  const allowed = buildEnvironment({}, adapter, overrides, ['*'])
  expect(allowed.env.SAMPLE).toBe('sample-value')
  expect(Object.values(allowed.env)).not.toContain('protected')
  expect(allowed.knownSecrets).toEqual({ SAMPLE: 'sample-value' })
  expect(buildEnvironment({}, adapter, overrides).env.SAMPLE).toBeUndefined()
  const warn = vi.fn()
  expect(filterExtraArgs(['--model=local', 'x\0', 'x\n', 'x\t', 'x\x7f', 'x\u0085'], ['*'], warn)).toEqual(['--model=local'])
  expect(warn).toHaveBeenCalledWith(5)
  expect(filterExtraArgs(['--model=local'], [])).toEqual([])
})

it('preserves workspace, board and verification protections with open worker settings', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'open-worker-')))
  try {
    const dir = join(root, '.board'), file = join(root, 'worker.yaml'), other = join(root, 'other')
    const ws = { id: 'test', label: 'test', path: root, maxProfile: 'full', allowedAdapters: ['codex', 'claude-code'],
      harness: { tamper: { replaceDefaults: true }, verify: { commands: [{ id: 'check', argv: ['node', '--version'] }] } } }
    const config = { workerId: 'test', hub: { url: 'ws://localhost' }, security: { allowedEnvOverrideKeys: ['*'] },
      adapters: { codex: { allowedExtraArgs: ['*'] } }, workspaces: [ws] }
    await fs.writeFile(file, JSON.stringify(config))
    const original = loadWorkerConfig(file, join(root, 'state'))
    const local = original.workspaces[0]!
    expect(() => resolveWorkspaceSubdir(local.path, '../escape')).toThrow()
    await fs.mkdir(other)
    await fs.symlink(other, dir, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await readBoard(local.path)).dir).toBe('unsafe')
    await fs.unlink(dir)
    await fs.mkdir(dir)
    const board = join(dir, 'HANDOFF.md'), target = join(other, 'outside')
    await fs.writeFile(target, 'test')
    await fs.link(target, board)
    expect((await readBoard(local.path)).files[0]?.reason).toBe('HARDLINK')
    await fs.unlink(board)
    await fs.writeFile(board, 'different')
    const raced = await readBoard(local.path, {}, [], { realpath: fs.realpath, lstat: fs.lstat, open: () => fs.open(target, 'r') })
    expect(raced.files[0]).toMatchObject({ status: 'unsafe', reason: 'RACE' })
    expect(local.configExposed).toBe(true)
    expect(computeApplied({ v: 1, trust: 'owner', inject: 'fresh', board: 'write', bootstrap: true,
      verify: { autoFixMaxRetries: 2 } }, local.harness, 'full', local.configExposed).verify).toBe(false)
    ws.harness.verify.commands[0]!.argv = ['pwsh', '--version']
    expect(WorkerConfigSchema.safeParse(config).success).toBe(false)
    await fs.writeFile(file, JSON.stringify(config))
    const blocked = vi.fn()
    const reload = loadWorkerReload(file, join(root, 'state'), original, true, blocked)
    expect(blocked).toHaveBeenCalledWith('test')
    expect(reload.workspaces[0]?.harness.verify.commands[0]?.argv).toEqual(['node', '--version'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
