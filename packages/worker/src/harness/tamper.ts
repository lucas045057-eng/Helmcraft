import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBoardPath } from '@agent-hub/protocol'
import type { Workspace } from '../config/schema.js'
import { withinWorkspace, resolveWorkspaceSubdir } from '../security/workspace.js'
import { compileGlob, manifestKey } from './glob.js'
import { resolveVerifyCommand } from './verify-runner.js'

const defaults = ('AGENTS.md **/AGENTS.md **/CLAUDE.md **/GEMINI.md **/package.json **/package-lock.json **/npm-shrinkwrap.json ' +
  '**/pnpm-lock.yaml **/pnpm-workspace.yaml **/yarn.lock **/bun.lock **/bun.lockb **/.npmrc **/.yarnrc **/.yarnrc.yml **/.pnpmfile.cjs ' +
  '**/*.config.* **/tsconfig*.json **/jsconfig*.json **/.eslintrc* **/.prettierrc* **/.dependency-cruiser* **/.babelrc* **/jest.config* ' +
  '**/vitest.workspace* **/.mocharc* **/karma.conf* **/pytest.ini **/pyproject.toml **/setup.cfg **/tox.ini **/noxfile.py **/conftest.py ' +
  '**/Makefile **/justfile **/Taskfile.yml .github/** .gitlab-ci.yml .circleci/** azure-pipelines.yml .husky/** .gitattributes .gitmodules').split(' ')
function exeBaseName(exe: string): string {
  const base = win32.basename(exe).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '')
  if (/^python\d+(?:\.\d+)*$/u.test(base)) return 'python3'
  if (/^pypy\d+(?:\.\d+)*$/u.test(base)) return 'pypy3'
  return base
}
const RUNTIME_INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'python', 'python3', 'py', 'pypy', 'pypy3'])
const JS_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'tsx'])
const IMPLICIT_JS_EXTS = ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx', '.json', '.node']

function inlineCodeFlagsFor(exe: string): Set<string> {
  const name = exeBaseName(exe)
  if (['node', 'nodejs', 'deno', 'bun', 'tsx'].includes(name)) return new Set(['-e', '--eval', '-p', '--print'])
  if (['python', 'python3', 'py', 'pypy', 'pypy3'].includes(name)) return new Set(['-c'])
  if (['ruby', 'perl'].includes(name)) return new Set(['-e'])
  if (name === 'php') return new Set(['-r'])
  return new Set()
}

function modulePreloadFlagsFor(exe: string): Set<string> {
  const name = exeBaseName(exe)
  if (['node', 'nodejs', 'tsx'].includes(name)) return new Set(['-r', '--require', '--import', '--loader', '--experimental-loader'])
  if (name === 'bun') return new Set(['-r', '--preload'])
  if (['python', 'python3', 'py', 'pypy', 'pypy3'].includes(name)) return new Set(['-m'])
  return new Set()
}

function valueFlagsFor(exe: string): Set<string> {
  const name = exeBaseName(exe)
  if (['node', 'nodejs', 'tsx'].includes(name)) {
    return new Set([
      '-C', '--conditions', '--input-type', '--max-old-space-size', '--max-old-space-size-percentage',
      '--v8-pool-size', '--heapsnapshot-near-heap-limit', '--heapsnapshot-signal', '--redirect-warnings', '--title',
      '--env-file', '--env-file-if-exists', '--diagnostic-dir', '--report-dir', '--report-directory',
      '--report-filename', '--report-signal', '--test-name-pattern', '--test-skip-pattern', '--test-reporter',
      '--test-reporter-destination', '--test-concurrency', '--test-shard', '--test-timeout',
      '--test-coverage-branches', '--test-coverage-exclude', '--test-coverage-functions',
      '--test-coverage-include', '--test-coverage-lines', '--test-global-setup', '--test-rerun-failures',
      '--inspect-port', '--inspect-publish-uid', '--icu-data-dir', '--openssl-config', '--tls-cipher-list', '--tls-keylog',
      '--cpu-prof-dir', '--cpu-prof-name', '--cpu-prof-interval', '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval',
      '--watch-path', '--watch-kill-signal', '--max-http-header-size', '--dns-result-order',
      '--disable-proto', '--disable-warning', '--unhandled-rejections', '--use-largepages',
      '--experimental-config-file', '--experimental-sea-config', '--build-snapshot-config', '--snapshot-blob',
      '--secure-heap', '--secure-heap-min', '--localstorage-file', '--network-family-autoselection-attempt-timeout',
      '--allow-fs-read', '--allow-fs-write', '--run', '--trace-event-categories', '--trace-event-file-pattern',
      '--trace-require-module',
    ])
  }
  if (['python', 'python3', 'py', 'pypy', 'pypy3'].includes(name)) return new Set(['-W', '-X', '--check-hash-based-pycs'])
  if (name === 'deno') return new Set(['--config', '-c', '--import-map', '--lock', '--env-file'])
  if (name === 'bun') return new Set(['--config', '-c', '--env-file', '--cwd'])
  return new Set()
}

function booleanFlagsFor(exe: string): Set<string> {
  const name = exeBaseName(exe)
  if (['node', 'nodejs', 'tsx'].includes(name)) {
    return new Set([
      '--inspect', '--inspect-brk', '--inspect-wait', '--no-warnings', '--enable-source-maps',
      '--experimental-strip-types', '--experimental-vm-modules', '--experimental-transform-types',
      '--experimental-sqlite', '--test', '--test-only', '--test-force-exit', '--test-update-snapshots',
      '--watch', '--watch-preserve-output', '-c', '--check', '-v', '--version', '-h', '--help',
      '--preserve-symlinks', '--preserve-symlinks-main', '--trace-warnings', '--trace-deprecation',
      '--throw-deprecation', '--no-deprecation', '--pending-deprecation', '--expose-gc', '--zero-fill-buffers',
      '--permission', '--allow-addons', '--allow-child-process', '--allow-inspector', '--allow-wasi', '--allow-worker',
      '--abort-on-uncaught-exception', '--disallow-code-generation-from-strings', '--use-env-proxy',
      '--use-system-ca', '--use-bundled-ca', '--use-openssl-ca', '--cpu-prof', '--heap-prof', '--prof',
      '--entry-url', '--no-addons', '--no-experimental-fetch', '--no-experimental-websocket',
      '--no-experimental-detect-module', '--no-experimental-strip-types',
    ])
  }
  if (['python', 'python3', 'py', 'pypy', 'pypy3'].includes(name)) {
    return new Set(['-b', '-bb', '-B', '-d', '-E', '-h', '--help', '-i', '-I', '-O', '-OO', '-P', '-q', '-s', '-S', '-u', '-v', '-V', '--version', '-x'])
  }
  if (name === 'deno') {
    return new Set(['--allow-all', '-A', '--allow-read', '--allow-write', '--allow-net', '--allow-env', '--allow-run', '--allow-sys', '--allow-ffi', '--no-check', '--watch', '--quiet', '-q', '-v', '--version', '-h', '--help'])
  }
  if (name === 'bun') {
    return new Set(['--watch', '--hot', '--smol', '--no-clear-screen', '--silent', '-v', '--version', '-h', '--help'])
  }
  return new Set()
}

function hasImplicitExtCandidate(path: string): boolean {
  return IMPLICIT_JS_EXTS.some(ext => !!lstatSync(path + ext, { throwIfNoEntry: false }))
}

export function inspectCommands(
  root: string,
  commands: ReadonlyArray<{ argv: string[]; cwd?: string | undefined }>,
): { paths: string[]; unbaselined: boolean } {
  const files = new Set<string>()
  let unbaselined = false
  const baselinePath = (full: string, allowMissing: boolean, rejectDirectory = false, checkImplicitExt = false) => {
    const lst = lstatSync(full, { throwIfNoEntry: false })
    if (!lst) {
      if (!allowMissing || (checkImplicitExt && hasImplicitExtCandidate(full))) unbaselined = true
      return
    }
    if (lst.isDirectory()) {
      if (rejectDirectory) unbaselined = true
      return
    }
    if (lst.isSymbolicLink()) {
      try {
        const target = realpathSync.native(full)
        const st = statSync(target)
        if (!withinWorkspace(root, target) || !st.isFile()) { unbaselined = true; return }
        const rel = relative(root, full).split(sep).join('/')
        const targetRel = relative(root, target).split(sep).join('/')
        if (!rel || rel.length > 512 || !targetRel || targetRel.length > 512) { unbaselined = true; return }
        files.add(rel)
        files.add(targetRel)
      } catch {
        unbaselined = true
      }
      return
    }
    if (!lst.isFile()) { unbaselined = true; return }
    try {
      const target = realpathSync.native(full)
      const rel = relative(root, full).split(sep).join('/')
      const targetRel = relative(root, target).split(sep).join('/')
      if (!withinWorkspace(root, target) || !rel || rel.length > 512 || !targetRel || targetRel.length > 512) {
        unbaselined = true
        return
      }
      files.add(rel)
      files.add(targetRel)
    } catch {
      unbaselined = true
    }
  }
  const inspectToken = (
    candidate: string,
    cwd: string,
    isPathLikeOutsideError: boolean,
    requireInsideIfLocal: boolean,
    rejectDirectory = false,
    checkImplicitExt = false,
  ) => {
    if (!candidate || /[\r\n\0]/u.test(candidate)) { unbaselined = true; return }
    let path: string
    if (/^file:/iu.test(candidate)) {
      try {
        path = fileURLToPath(candidate)
      } catch {
        unbaselined = true
        return
      }
      if (!withinWorkspace(root, path)) {
        unbaselined = true
        return
      }
      baselinePath(path, true, rejectDirectory, checkImplicitExt)
      return
    }
    path = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate)
    if (!withinWorkspace(root, path)) {
      if (requireInsideIfLocal) { unbaselined = true; return }
      if (isPathLikeOutsideError && (candidate.startsWith('.') || candidate.includes('/') || candidate.includes('\\'))) {
        const outsideStat = lstatSync(path, { throwIfNoEntry: false })
        if (outsideStat && (outsideStat.isFile() || outsideStat.isSymbolicLink() || (rejectDirectory && outsideStat.isDirectory()))) {
          unbaselined = true
        } else if (checkImplicitExt && !outsideStat && hasImplicitExtCandidate(path)) {
          unbaselined = true
        }
      }
      return
    }
    baselinePath(path, !requireInsideIfLocal, rejectDirectory, checkImplicitExt)
  }
  const addCommandFiles = (cmd: { argv: string[]; cwd?: string | undefined }) => {
    let cwd: string
    try { cwd = resolveWorkspaceSubdir(root, cmd.cwd) } catch { unbaselined = true; return }
    const exeToken = cmd.argv[0]
    const resolved = exeToken ? resolveVerifyCommand(exeToken) : undefined
    const absExeFull = exeToken && isAbsolute(exeToken) ? resolve(exeToken) : undefined
    const absExeStat = absExeFull && withinWorkspace(root, absExeFull) ? lstatSync(absExeFull, { throwIfNoEntry: false }) : undefined
    const absExeLocal = !!absExeStat && !absExeStat.isDirectory()
    if (resolved?.status === 'error' && (resolved.error === 'VERIFY_SHELL_FORBIDDEN' || absExeLocal)) {
      unbaselined = true
    }
    const shimLocal = resolved?.status === 'ready' && !!resolved.shimPath && withinWorkspace(root, resolved.shimPath)
    const resolvedCmdLocal = resolved?.status === 'ready' && withinWorkspace(root, resolved.exe.command)
    const rawExeLocal = absExeLocal || shimLocal || resolvedCmdLocal
    if (resolved?.status === 'ready') {
      if (shimLocal && resolved.shimPath) baselinePath(resolved.shimPath, false, true)
      if (resolvedCmdLocal) baselinePath(resolved.exe.command, false, true)
      for (const prefixArg of resolved.exe.prefixArgs) {
        inspectToken(prefixArg, cwd, false, rawExeLocal, true)
      }
    }
    const flagSource = resolved?.status === 'ready' && resolved.exe.prefixArgs.length === 0
      ? resolved.exe.command
      : (exeToken ?? '')
    const runtimeName = exeBaseName(flagSource)
    const runtime = RUNTIME_INTERPRETERS.has(runtimeName)
    const isJsRuntime = JS_RUNTIMES.has(runtimeName)
    const isPython = ['python', 'python3', 'py', 'pypy', 'pypy3'].includes(runtimeName)
    const endsAtInlineCode = isPython || ['ruby', 'perl', 'php'].includes(runtimeName)
    const codeFlags = inlineCodeFlagsFor(flagSource)
    const preloadFlags = modulePreloadFlagsFor(flagSource)
    const valueFlags = valueFlagsFor(flagSource)
    const booleanFlags = booleanFlagsFor(flagSource)
    const inspectPythonModule = (mod: string, cwdDir: string) => {
      if (!mod || /[/\\\r\n\0]/u.test(mod)) {
        unbaselined = true
        return
      }
      const parts = mod.split('.')
      if (parts.some(p => !p || p === '.' || p === '..')) {
        unbaselined = true
        return
      }
      const roots = cwdDir !== root ? [cwdDir, root] : [cwdDir]
      for (const base of roots) {
        const topDir = resolve(base, parts[0]!)
        const topFile = topDir + '.py'
        if (!lstatSync(topDir, { throwIfNoEntry: false }) && !lstatSync(topFile, { throwIfNoEntry: false })) continue
        if (!withinWorkspace(root, topDir)) {
          unbaselined = true
          return
        }
        const targetDir = resolve(base, ...parts)
        const dirSt = lstatSync(targetDir, { throwIfNoEntry: false })
        if (dirSt && (dirSt.isDirectory() || dirSt.isSymbolicLink())) {
          unbaselined = true
          return
        }
        for (let k = 1; k < parts.length; k++) {
          const pkgDir = resolve(base, ...parts.slice(0, k))
          const pkgSt = lstatSync(pkgDir, { throwIfNoEntry: false })
          if (!pkgSt || pkgSt.isSymbolicLink() || !pkgSt.isDirectory() || !withinWorkspace(root, pkgDir)) {
            unbaselined = true
            return
          }
          const initPy = resolve(pkgDir, '__init__.py')
          if (lstatSync(initPy, { throwIfNoEntry: false })) baselinePath(initPy, false, true)
        }
        baselinePath(targetDir + '.py', false, true)
      }
    }
    let skipNext = false
    let nextIsPreload = false
    let nextIsPythonModule = false
    let nextIsValueFlag = false
    let afterDoubleDash = false
    let seenEntry = false
    let allPosDirsUnbaselined = false
    let endedRuntimeOpts = false
    for (let i = 0; i < cmd.argv.length; i++) {
      const arg = cmd.argv[i]!
      if (i === 0) {
        if (isAbsolute(arg)) inspectToken(arg, cwd, false, false, false)
        continue
      }
      if (skipNext) { skipNext = false; continue }
      if (nextIsPythonModule) {
        nextIsPythonModule = false
        nextIsPreload = false
        inspectPythonModule(arg, cwd)
        continue
      }
      if (nextIsPreload) {
        nextIsPreload = false
        inspectToken(arg, cwd, true, false, true, isJsRuntime)
        continue
      }
      if (nextIsValueFlag) {
        nextIsValueFlag = false
        inspectToken(arg, cwd, true, false, false)
        continue
      }
      if (endedRuntimeOpts) {
        if (arg.startsWith('-')) {
          const eq = arg.indexOf('=')
          if (eq > 0) inspectToken(arg.slice(eq + 1), cwd, true, false, false)
        } else {
          inspectToken(arg, cwd, true, false, false)
        }
        continue
      }
      if (!afterDoubleDash && arg === '--') { afterDoubleDash = true; continue }
      if (!afterDoubleDash && codeFlags.has(arg)) {
        skipNext = true
        seenEntry = true
        if (endsAtInlineCode) endedRuntimeOpts = true
        continue
      }
      if (!afterDoubleDash && preloadFlags.has(arg)) {
        if (isPython && arg === '-m') {
          nextIsPythonModule = true
          seenEntry = true
          endedRuntimeOpts = true
        } else {
          nextIsPreload = true
        }
        continue
      }
      if (!afterDoubleDash && valueFlags.has(arg)) { nextIsValueFlag = true; continue }
      if (!afterDoubleDash && arg.startsWith('-')) {
        if (runtime && arg === '-') {
          seenEntry = true
          endedRuntimeOpts = true
          continue
        }
        if (runtime && arg === '--test') { allPosDirsUnbaselined = true; continue }
        const eq = arg.indexOf('=')
        if (eq > 0) {
          const flagName = arg.slice(0, eq)
          if (codeFlags.has(flagName)) {
            seenEntry = true
            if (endsAtInlineCode) endedRuntimeOpts = true
            continue
          }
          const isPreloadEq = preloadFlags.has(flagName)
          inspectToken(arg.slice(eq + 1), cwd, true, false, isPreloadEq, isPreloadEq && isJsRuntime)
        } else if (arg.length > 2 && /^-[A-Za-z]/u.test(arg) && codeFlags.has(arg.slice(0, 2))) {
          seenEntry = true
          if (endsAtInlineCode) endedRuntimeOpts = true
        } else if (arg.length > 2 && /^-[A-Za-z]/u.test(arg) && preloadFlags.has(arg.slice(0, 2))) {
          const shortFlag = arg.slice(0, 2)
          const operand = arg.slice(2)
          if (isPython && shortFlag === '-m') {
            inspectPythonModule(operand, cwd)
            seenEntry = true
            endedRuntimeOpts = true
          } else {
            inspectToken(operand, cwd, true, false, true, isJsRuntime)
          }
        } else if (isPython && /^-[bBdEhiIOqsSuvx]+$/u.test(arg)) {
          // Known single-dash Python boolean cluster
        } else if (runtime && !booleanFlags.has(arg)) {
          // Unknown bare runtime flag may consume the following positional entrypoint.
          unbaselined = true
        }
        continue
      }
      if (runtime && !seenEntry && (runtimeName === 'deno' || runtimeName === 'bun') && (arg === 'run' || arg === 'test')) {
        if (arg === 'test') allPosDirsUnbaselined = true
        continue
      }
      const isEntry = runtime && (!seenEntry || allPosDirsUnbaselined)
      inspectToken(arg, cwd, true, false, isEntry, isEntry && isJsRuntime)
      if (runtime && !seenEntry) {
        seenEntry = true
        if (!allPosDirsUnbaselined) endedRuntimeOpts = true
      }
    }
  }
  for (const cmd of commands) addCommandFiles(cmd)
  return { paths: [...files], unbaselined }
}

export function inspectCommandFiles(root: string, config: Workspace['harness']): { paths: string[]; unbaselined: boolean } {
  const cmds: Array<{ argv: string[]; cwd?: string | undefined }> = [...config.verify.commands]
  if (config.visual.startCommand) cmds.push(config.visual.startCommand)
  for (const override of Object.values(config.visual.subdirOverrides)) {
    if (override.startCommand) cmds.push(override.startCommand)
  }
  return inspectCommands(root, cmds)
}

export function commandFilePaths(root: string, config: Workspace['harness']): string[] {
  return inspectCommandFiles(root, config).paths
}

export function sensitivePaths(root: string, config: Workspace['harness']) {
  const patterns = [...(config.tamper.replaceDefaults ? [] : defaults), ...config.tamper.extraPaths].map(p => compileGlob(p))
  const files = new Set(commandFilePaths(root, config).map(manifestKey))
  return (path: string) => !isBoardPath(manifestKey(path)) && (files.has(manifestKey(path)) || patterns.some(re => re.test(path)))
}
