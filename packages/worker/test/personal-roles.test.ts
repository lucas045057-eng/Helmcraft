import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bindRepository, checkPersonalRole, personalProfiles } from '../src/personal/roles.js'
import { PersonalResult } from '../src/personal/result.js'
import { mapWorkspaceFile } from '../src/security/workspace.js'

it.runIf(process.platform === 'linux')('maps a real POSIX filename when its portable spelling is not a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'literal-file-'))
  try {
    const name = 'draft\\notes.txt'
    writeFileSync(join(dir, 'draft'), 'ordinary file')
    writeFileSync(join(dir, name), 'notes')
    expect(mapWorkspaceFile(dir, dir, name)).toBe(name)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('requires a complete, tool-free native reviewer result even when the CLI exits successfully', () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'PASS' })
  for (const tools of [[], ['Write']]) {
    const parser = new PersonalResult('reviewer')
    parser.observe(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools }))
    expect(parser.finish()).toBeUndefined()
    parser.observe(result)
    expect(parser.finish()).toBe(tools.length ? undefined : 'PASS')
    parser.observe(result)
    expect(parser.finish()).toBeUndefined()
  }
  const partial = new PersonalResult('advisor')
  partial.observe(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK' } }), true)
  expect(partial.finish()).toBeUndefined()
})

it('requires an upstream and binds the physical root, branch and push destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'personal-roles-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=Main', '-c', 'user.email=main@localhost', 'commit', '--allow-empty', '-qm', 'init')
    expect(() => bindRepository(dir)).toThrow(/upstream/i)
    git('init', '--bare', '-q', 'target.git')
    git('remote', 'add', 'origin', join(dir, 'target.git'))
    git('push', '-qu', 'origin', 'main')
    const binding = bindRepository(dir)
    expect(binding).toMatchObject({ root: realpathSync(dir), branch: 'main', remote: 'origin', ref: 'refs/heads/main' })
    git('remote', 'set-url', '--push', 'origin', 'another.git')
    expect(bindRepository(dir).destination).not.toBe(binding.destination)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('pins reviewer and advisor capabilities and rejects role or profile substitution', () => {
  expect(personalProfiles.reviewer).toMatchObject({ adapter: 'claude-code', profile: 'readonly', model: 'claude-opus-5-5' })
  expect(personalProfiles.advisor).toMatchObject({ adapter: 'antigravity', profile: 'readonly', model: 'gemini-4-carbon-high' })
  expect(() => checkPersonalRole('reviewer', { ...personalProfiles.reviewer, profile: 'edit' })).toThrow()
  expect(() => checkPersonalRole('main', { ...personalProfiles.main, extraArgs: ['--model', 'other'] })).toThrow()
  expect(() => checkPersonalRole('advisor', { ...personalProfiles.advisor, resume: {} })).toThrow()
  expect(() => checkPersonalRole('reviewer', personalProfiles.reviewer)).not.toThrow()
})
