import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveWorkspaceRoot, resolveWorkspaceSubdir } from '../src/security/workspace.js'
import { buildEnvironment } from '../src/security/env.js'

it('rejects traversal, Windows aliases and directory links that escape a workspace', () => {
  const base = mkdtempSync(join(tmpdir(), 'workspace-'))
  try {
    mkdirSync(join(base, 'repo'))
    const root = resolveWorkspaceRoot(join(base, 'repo'))
    symlinkSync(base, join(root, 'link'), 'junction')
    for (const path of ['../', 'folder\\..', 'C:bad', 'NUL.txt', 'item. ', 'link']) {
      expect(() => resolveWorkspaceSubdir(root, path)).toThrow()
    }
    expect(resolveWorkspaceSubdir(root, '.')).toBe(root)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
it('isolates child environment even when a forbidden key was explicitly allowed', () => {
  const { env } = buildEnvironment({ PATH: 'path', NODE_OPTIONS: '--require unsafe', HUB_SECRET: 'abcdef1234' },
    { passEnv: ['NODE_OPTIONS', 'HUB_*'], env: {} }, { node_options: 'also unsafe', SAFE: 'override' }, ['NODE_OPTIONS', 'SAFE'])
  expect(env).toEqual({ PATH: 'path', SAFE: 'override', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb', CI: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' })
})
