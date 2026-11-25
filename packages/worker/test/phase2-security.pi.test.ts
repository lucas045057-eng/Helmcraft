/**
 * Pi 独立验收 · Phase 2 门禁：SEC-1 ~ SEC-8（Worker 侧安全护栏）
 * 对照 docs/specs/06-worker-adapters-security.md §6.3 / §6.4 与 pi-test-matrix §9。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceRoot, resolveWorkspaceSubdir, withinWorkspace } from '../src/security/workspace.js'
import { buildEnvironment } from '../src/security/env.js'
import { effectiveProfile } from '../src/security/profile.js'
import { filterExtraArgs } from '../src/security/args.js'
import { resolveWorkspaces, loadWorkerConfig } from '../src/config/load.js'
import { WorkerConfigSchema } from '../src/config/schema.js'

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, 'repo'), { recursive: true })
  return { dir, repo: join(dir, 'repo'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('SEC-1 / SEC-2 / SEC-3 / SEC-4 路径防护', () => {
  it('SEC-1 subdir 穿越全部反例 → PATH_REJECTED', () => {
    const files = tempDir('pi-sec1-')
    try {
      const root = resolveWorkspaceRoot(files.repo)
      const cases = ['..\\..\\Windows', '../etc', 'C:\\x', '\\\\server\\s', '\\\\?\\C:\\', 'a\\..\\..\\b',
        'CON', 'aux.txt', 'a:stream', 'x.', 'x ', 'NUL.txt', 'folder/../../out', '/etc/passwd']
      for (const candidate of cases) {
        expect(() => resolveWorkspaceSubdir(root, candidate), candidate).toThrow()
      }
      expect(resolveWorkspaceSubdir(root, '.')).toBe(root)
      mkdirSync(join(root, 'sub'))
      expect(resolveWorkspaceSubdir(root, 'sub')).toBe(join(root, 'sub'))
    } finally { files.cleanup() }
  })

  it('SEC-2 符号链接 / Junction 逃逸工作区 → 拒绝', () => {
    const files = tempDir('pi-sec2-')
    try {
      const root = resolveWorkspaceRoot(files.repo)
      mkdirSync(join(files.dir, 'outside'), { recursive: true })
      symlinkSync(join(files.dir, 'outside'), join(root, 'escape'), 'junction')
      expect(() => resolveWorkspaceSubdir(root, 'escape')).toThrow()
      // 指向工作区内部的目录链接是合法的
      mkdirSync(join(root, 'inside'))
      symlinkSync(join(root, 'inside'), join(root, 'alias'), 'junction')
      expect(resolveWorkspaceSubdir(root, 'alias')).toBe(join(root, 'inside'))
    } finally { files.cleanup() }
  })

  it('SEC-3 Windows 大小写：同一路径不同大小写视为相等，外部路径拒绝', () => {
    expect(withinWorkspace('D:\\Code\\Backend', 'd:\\code\\backend\\sub', true)).toBe(true)
    expect(withinWorkspace('d:\\code\\backend', 'D:\\Code\\Backend', true)).toBe(true)
    expect(withinWorkspace('D:\\Code\\Backend', 'D:\\Code\\Backend-evil\\x', true)).toBe(false)
    expect(withinWorkspace('D:\\Code\\Backend', 'D:\\Other\\x', true)).toBe(false)
    if (process.platform === 'win32') {
      const files = tempDir('pi-sec3-')
      try {
        mkdirSync(join(files.repo, 'Sub'))
        const root = resolveWorkspaceRoot(files.repo)
        expect(() => resolveWorkspaceSubdir(root, 'sub')).not.toThrow()
        expect(() => resolveWorkspaceSubdir(root, '..')).toThrow()
      } finally { files.cleanup() }
    }
  })

  it('SEC-4 工作区根互相包含 → 配置加载失败并给出明确错误', () => {
    const files = tempDir('pi-sec4-')
    try {
      mkdirSync(join(files.repo, 'nested'))
      const config = WorkerConfigSchema.parse({ workerId: 'sec4', hub: { url: 'ws://localhost:1/ws/worker' },
        workspaces: [
          { id: 'outer', label: 'Outer', path: files.repo, allowedAdapters: ['mock'], maxProfile: 'edit' },
          { id: 'inner', label: 'Inner', path: join(files.repo, 'nested'), allowedAdapters: ['mock'], maxProfile: 'edit' },
        ] })
      expect(() => resolveWorkspaces(config)).toThrow(/Overlapping workspace roots/)
    } finally { files.cleanup() }
  })
})

describe('SEC-5 / SEC-6 环境变量隔离', () => {
  const hubEnv = {
    PATH: 'LOCAL-PATH',
    NODE_OPTIONS: '--require evil.js',
    HUB_SECRET: 'hub-secret-value',
    AGENT_WORKER_TOKEN: 'worker-token',
    WORKER_PRIVATE_KEY: 'C:\\secret\\identity.key',
    ANTHROPIC_API_KEY: 'sk-ant-abcdefgh12345678',
    HOME: '/home/user',
  }

  it('SEC-5 Hub 下发 NODE_OPTIONS / PATH / AGENT_WORKER_X → 子进程不存在或为本地值', () => {
    // 默认（allowedEnvOverrideKeys 为空）时 Hub 无法注入任何 env
    const defaults = buildEnvironment(hubEnv, { passEnv: [], env: {} }, { PATH: 'C:\\evil', SAFE: 'x' })
    expect(defaults.env.PATH).toBe('LOCAL-PATH')
    expect(defaults.env.SAFE).toBeUndefined()
    // 即使本地显式允许，硬禁止键（NODE_OPTIONS / AGENT_WORKER_*）依然被剔除
    const forced = buildEnvironment(hubEnv, { passEnv: [], env: {} },
      { NODE_OPTIONS: '--require pwn.js', PATH: 'C:\\evil', AGENT_WORKER_X: '1' }, ['NODE_OPTIONS', 'PATH', 'AGENT_WORKER_X'])
    expect(forced.env.NODE_OPTIONS).toBeUndefined()
    expect(forced.env.AGENT_WORKER_X).toBeUndefined()
  })

  it('SEC-6 子进程中无 Worker 私钥路径、无 HUB_*（真实进程验证）', () => {
    const { env } = buildEnvironment(hubEnv, { passEnv: [], env: {} }, {}, [])
    expect(env.HUB_SECRET).toBeUndefined()
    expect(env.AGENT_WORKER_TOKEN).toBeUndefined()
    expect(env.WORKER_PRIVATE_KEY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    const script = 'console.log(JSON.stringify(process.env))'
    const child = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true, shell: false })
    expect(child.status).toBe(0)
    const seen = JSON.parse(child.stdout) as Record<string, string>
    expect(seen.HUB_SECRET).toBeUndefined()
    expect(seen.AGENT_WORKER_TOKEN).toBeUndefined()
    expect(seen.WORKER_PRIVATE_KEY).toBeUndefined()
    expect(seen.NODE_OPTIONS).toBeUndefined()
    expect(seen.NO_COLOR).toBe('1')
    expect(seen.CI).toBe('1')
  })
})

describe('SEC-7 / SEC-8 参数与 profile 钳制', () => {
  it('SEC-7 extraArgs：Hub 下发 --dangerously-skip-permissions 被过滤并告警', () => {
    const warnings: number[] = []
    const filtered = filterExtraArgs(['--model=gpt', '--dangerously-skip-permissions'], ['--model*'], count => warnings.push(count))
    expect(filtered).toEqual(['--model=gpt'])
    expect(warnings).toEqual([1])
    // 未列入白名单的参数一律被去除
    expect(filterExtraArgs(['--model', 'gpt'], ['--model'])).toEqual(['--model'])
  })

  it('SEC-8 profile clamp：请求 full + maxProfile=edit → 以 edit 运行并标记 clamped；strictProfile → PROFILE_NOT_ALLOWED', () => {
    expect(effectiveProfile('full', 'edit')).toEqual({ effectiveProfile: 'edit', clampedFrom: 'full' })
    expect(effectiveProfile('readonly', 'edit')).toEqual({ effectiveProfile: 'readonly' })
    expect(effectiveProfile('full', 'edit', true)).toBeNull()
    const config = WorkerConfigSchema.parse({ workerId: 'sec8', hub: { url: 'ws://localhost:1/ws/worker' },
      workspaces: [{ id: 'ws', label: 'ws', path: process.cwd(), allowedAdapters: ['mock'], maxProfile: 'edit', strictProfile: true }] })
    expect(config.workspaces[0]!.strictProfile).toBe(true)
  })
})

void loadWorkerConfig
