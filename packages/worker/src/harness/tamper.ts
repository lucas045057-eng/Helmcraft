import { realpathSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { Workspace } from '../config/schema.js'
import { withinWorkspace, resolveWorkspaceSubdir } from '../security/workspace.js'
import { compileGlob, manifestKey } from './glob.js'

const defaults = ('AGENTS.md **/AGENTS.md **/CLAUDE.md **/GEMINI.md **/package.json **/package-lock.json **/npm-shrinkwrap.json ' +
  '**/pnpm-lock.yaml **/pnpm-workspace.yaml **/yarn.lock **/bun.lock **/bun.lockb **/.npmrc **/.yarnrc **/.yarnrc.yml **/.pnpmfile.cjs ' +
  '**/*.config.* **/tsconfig*.json **/jsconfig*.json **/.eslintrc* **/.prettierrc* **/.dependency-cruiser* **/.babelrc* **/jest.config* ' +
  '**/vitest.workspace* **/.mocharc* **/karma.conf* **/pytest.ini **/pyproject.toml **/setup.cfg **/tox.ini **/noxfile.py **/conftest.py ' +
  '**/Makefile **/justfile **/Taskfile.yml .github/** .gitlab-ci.yml .circleci/** azure-pipelines.yml .husky/** .gitattributes .gitmodules').split(' ')
export function sensitivePaths(root: string, config: Workspace['harness']) {
  const patterns = [...(config.tamper.replaceDefaults ? [] : defaults), ...config.tamper.extraPaths].map(p => compileGlob(p))
  const files = new Set<string>()
  for (const cmd of config.verify.commands) {
    let cwd: string
    try { cwd = resolveWorkspaceSubdir(root, cmd.cwd) } catch { continue }
    for (const arg of cmd.argv) {
      if (arg.startsWith('-')) continue
      const path = resolve(cwd, arg)
      if (!withinWorkspace(root, path)) continue
      try {
        const target = realpathSync.native(path)
        if (!withinWorkspace(root, target) || !statSync(target).isFile()) continue
        files.add(manifestKey(relative(root, path).split(sep).join('/')))
        files.add(manifestKey(relative(root, target).split(sep).join('/')))
      } catch { /* The next snapshot checks newly created argument files. */ }
    }
  }
  return (path: string) => !manifestKey(path).startsWith('.board/') && (files.has(manifestKey(path)) || patterns.some(re => re.test(path)))
}
