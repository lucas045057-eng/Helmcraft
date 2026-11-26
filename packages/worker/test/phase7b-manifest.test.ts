import { mkdtemp, mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WorkspaceHarnessConfig } from '../src/config/schema.js'
import { compileGlob } from '../src/harness/glob.js'
import { scanManifest, diffManifest } from '../src/harness/manifest.js'
import { inspectCommands, sensitivePaths } from '../src/harness/tamper.js'

const config = (argv: string[]) => WorkspaceHarnessConfig.parse({ verify: { commands: [{ id: 'check', argv }] } })
it.each('cmd CMD.EXE powershell pwsh bash sh zsh dash fish ksh csh tcsh wsl'.split(' '))('VF-1 forbids interpreter %s', exe => {
  expect(() => config([exe])).toThrow(/VERIFY_SHELL_FORBIDDEN/)
})
it('VF-1 restricts names, relative paths and UTF-8 argv size', () => {
  for (const exe of ['./node', 'sub/node', 'sub\\node', 'two words']) expect(() => config([exe])).toThrow()
  for (const exe of ['node', process.execPath]) expect(config([exe]).verify.commands).toHaveLength(1)
  expect(() => config(['node', 'z'.repeat(4097)])).toThrow()
  expect(() => config(['node', ...Array<string>(8).fill('界'.repeat(4096))])).toThrow()
})
it.each([
  ['AGENTS.md', 'sub/AGENTS.md', false], ['**/A?.{js,ts}', 'x/y/A1.ts', true], ['**/A?.{js,ts}', 'A2.js', true],
  ['*.{ts,js}', 'x/a.ts', false], ['docs/**', 'docs/a/b.md', true], ['a.b', 'axb', false], ['a*b', 'a/x/b', false],
])('TR-1 matches %s against %s', (glob, path, expected) => expect(compileGlob(String(glob)).test(String(path))).toBe(expected))
it('TR-1 supports Windows folding', () => expect(compileGlob('Agents.md', true).test('AGENTS.MD')).toBe(true))

let dir: string, root: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vf-')); root = join(dir, 'repo'); await mkdir(root) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
it('TR-2–8 hashes sensitive inputs, never descends into junctions, and ignores metadata-only hash changes', async () => {
  const cfg = config(['node', 'check.mjs'])
  await writeFile(join(root, 'check.mjs'), '')
  const sensitive = sensitivePaths(root, cfg)
  const names = ['vitest.config.ts', 'tsconfig.json', '.github/workflows/ci.yml', 'AGENTS.md', 'pnpm-lock.yaml', 'docs/AGENTS.md', 'check.mjs']
  for (const path of names) expect(sensitive(path)).toBe(true)
  expect(sensitive('.board/package.json')).toBe(false)
  for (const name of ['dist', 'node_modules']) { await mkdir(join(root, name)); await writeFile(join(root, name, 'package.json'), '{}') }
  const file = join(root, 'package.json')
  await writeFile(file, 'old')
  await utimes(file, 2000, 2000)
  const pre = await scanManifest(root, cfg.manifest, sensitive)
  expect(pre.summary).toMatchObject({ files: 2, hashed: 2, truncated: false })
  await utimes(file, 1000, 1000)
  expect(diffManifest(pre, await scanManifest(root, cfg.manifest, sensitive), sensitive).changes.total).toBe(0)
  await writeFile(file, 'new')
  await utimes(file, 2000, 2000)
  await symlink(dir, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  const post = await scanManifest(root, cfg.manifest, sensitive)
  expect(post.entries.get('alias')?.target).toBe('OUTSIDE')
  expect(diffManifest(pre, post, sensitive)).toMatchObject({ changes: { total: 2, links: 1, modified: 1 }, tamper: { paths: ['alias', 'package.json'] } })
  expect((await scanManifest(root, { ...cfg.manifest, maxFiles: 1 }, sensitive)).summary.truncated).toBe(true)
  cfg.tamper = { replaceDefaults: true, extraPaths: ['local.*', '.board/**'] }
  const replaced = sensitivePaths(root, cfg)
  for (const path of ['local.settings', 'check.mjs']) expect(replaced(path)).toBe(true)
  for (const path of ['package.json', '.board/file']) expect(replaced(path)).toBe(false)
})

it('TR-5 protects a referenced file created during the run and ignores a directory argument', async () => {
  const cfg = config(['node', 'check.mjs', 'scripts'])
  await mkdir(join(root, 'scripts'))
  const before = sensitivePaths(root, cfg)
  const pre = await scanManifest(root, cfg.manifest, before)
  expect(before('check.mjs')).toBe(false)
  await writeFile(join(root, 'check.mjs'), 'process.exit(0)')
  const after = sensitivePaths(root, cfg)
  expect(after('scripts')).toBe(false)
  const post = await scanManifest(root, cfg.manifest, after)
  expect(diffManifest(pre, post, after)).toMatchObject({ changes: { added: 1 }, tamper: { paths: ['check.mjs'] } })
})

it('VF-22 compares case-only path renames using the platform filesystem rules', async () => {
  const cfg = config(['node']), sensitive = sensitivePaths(root, cfg)
  await writeFile(join(root, 'Readme.txt'), 'x')
  const pre = await scanManifest(root, cfg.manifest, sensitive)
  await rename(join(root, 'Readme.txt'), join(root, 'README.txt'))
  const { changes } = diffManifest(pre, await scanManifest(root, cfg.manifest, sensitive), sensitive)
  expect(changes).toMatchObject(process.platform === 'win32' ? { total: 0 } : { total: 2, added: 1, deleted: 1 })
})

it('keeps exact totals and checks sensitive changes beyond the 200 displayed paths', async () => {
  const cfg = config(['node']), sensitive = sensitivePaths(root, cfg)
  const pre = await scanManifest(root, cfg.manifest, sensitive)
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeFile(join(root, 'a' + (batch * 25 + i)), 'x')))
  }
  await writeFile(join(root, 'z.config.js'), 'x')
  const { changes, tamper } = diffManifest(pre, await scanManifest(root, cfg.manifest, sensitive), sensitive)
  expect(changes).toMatchObject({ total: 251, added: 251, truncated: false })
  expect(changes.sample).toHaveLength(200)
  expect(changes.sample.some(p => p.path === 'z.config.js')).toBe(false)
  expect(tamper?.paths).toEqual(['z.config.js'])
})

it('normalizes versioned python3.11 interpreters for module baselining and unknown flags', async () => {
  await mkdir(join(root, 'local_pkg'), { recursive: true })
  await writeFile(join(root, 'local_pkg', '__init__.py'), '')
  await writeFile(join(root, 'local_pkg', 'runner.py'), 'print("ok")\n')
  await writeFile(join(root, 'script.py'), 'print("script")\n')

  const mod = inspectCommands(root, [{ argv: ['python3.11', '-m', 'local_pkg.runner'] }])
  expect(mod.unbaselined).toBe(false)
  expect(mod.paths).toEqual(['local_pkg/__init__.py', 'local_pkg/runner.py'])

  const unknown = inspectCommands(root, [{ argv: ['python3.11', '--unknown-flag', 'script.py'] }])
  expect(unknown.unbaselined).toBe(true)
})
