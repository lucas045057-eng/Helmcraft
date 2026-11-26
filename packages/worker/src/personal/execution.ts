import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PersonalItemExecution } from '@agent-hub/protocol'
import type { WorkerConfig } from '../config/schema.js'
import { manifestKey } from '../harness/glob.js'
import { inspectCommands } from '../harness/tamper.js'
import { withinWorkspace } from '../security/workspace.js'

type Checks = WorkerConfig['workspaces'][number]['harness']['verify']['commands']
const hash = (text: Buffer | string) => createHash('sha256').update(text).digest('hex')

// Compute the proposed Git tree in a private index and object directory. Nothing is staged in the project.
export function inspectChanges(root: string) {
  const temp = mkdtempSync(join(tmpdir(), 'personal-review-'))
  try {
    const env = { ...process.env }
    const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
    const path = (name: string) => git('rev-parse', '--path-format=absolute', '--git-path', name).trimEnd()
    const index = path('index'), objects = path('objects')
    copyFileSync(index, join(temp, 'index'))
    mkdirSync(join(temp, 'objects'))
    Object.assign(env, { GIT_INDEX_FILE: join(temp, 'index'), GIT_OBJECT_DIRECTORY: join(temp, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects })
    if (git('ls-files', '-u', '-z') || /(?:^|\0)[a-zS] /u.test(git('ls-files', '-v', '-z')) ||
        /(?:^|\0)160000 /u.test(git('ls-files', '-s', '-z'))) throw new Error('Cannot inspect complete index')
    const indexTree = git('write-tree').trimEnd()
    git('add', '-A', '--', '.')
    if (/(?:^|\0)160000 /u.test(git('ls-files', '-s', '-z'))) throw new Error('Embedded repository cannot be reviewed')
    const tree = git('write-tree').trimEnd()
    const head = git('rev-parse', 'HEAD').trimEnd()
    const diff = git('diff', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames', head, tree, '--')
    if (diff.length > 90000) throw new Error('Complete review diff exceeds input limit')
    return { head, indexTree, tree, diff }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

export interface PlanBaselineOptions {
  mode?: 'strict' | 'flexible'
  inlinePrompt?: string
  autoCommit?: boolean
  expectedTree?: string
}

export function planBaseline(root: string, spec: PersonalItemExecution, initial: boolean, options: PlanBaselineOptions = {}) {
  const flexible = options.mode === 'flexible'
  const flexibleNoCommit = flexible && options.autoCommit === false
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] }).trimEnd()
  const read = (name: string) => {
    const path = join(root, name), stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 256000) throw new Error('Invalid plan input')
    return readFileSync(path)
  }
  const sources = flexible && options.inlinePrompt !== undefined && spec.sources.length === 1 && spec.sources[0] === 'INLINE_GOAL.md'
    ? [{ name: 'INLINE_GOAL.md', body: options.inlinePrompt }]
    : spec.sources.map(name => ({ name, body: new TextDecoder('utf-8', { fatal: true }).decode(read(name)) }))
  if (git('rev-parse', 'HEAD') !== spec.head || hash(read('TASKS.md')) !== spec.tasksDigest ||
      hash(JSON.stringify(sources)) !== spec.sourceDigest) throw new Error('Project baseline changed')
  if (initial) {
    if (flexibleNoCommit && !spec.first) {
      if (!options.expectedTree || inspectChanges(root).tree !== options.expectedTree) {
        throw new Error('Unexpected changes before implementation')
      }
      return
    }
    const status = git('status', '--porcelain', '--untracked-files=all')
    const filtered = flexibleNoCommit
      ? status.split(/\r?\n/u).filter(line => line && !/^..\s+(?:\.board\/|AGENTS\.md$)/u.test(line)).join('\n')
      : status
    if (filtered !== (spec.first ? '?? TASKS.md' : '')) throw new Error('Unexpected changes before implementation')
  }
}

const MAX_COMMAND_FILE_BYTES = 8 * 1024 * 1024

function hashFileBytes(full: string): string {
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_COMMAND_FILE_BYTES) throw new Error('COMMAND_FILES_UNBASELINED')
    return hash(readFileSync(fd))
  } finally {
    closeSync(fd)
  }
}

export function computeLegacyChecksDigest(commands: Checks): string {
  return hash(JSON.stringify(commands))
}

export function computeChecksDigest(root: string, commands: Checks): string {
  const inspected = inspectCommands(root, commands)
  if (inspected.unbaselined) throw new Error('COMMAND_FILES_UNBASELINED')
  const files: Array<{ path: string; sha256: string; linkIdentity?: string }> = []
  for (const rel of [...inspected.paths].sort()) {
    const full = resolve(root, rel)
    if (!withinWorkspace(root, full)) throw new Error('COMMAND_FILES_UNBASELINED')
    const lst = lstatSync(full)
    if (lst.isSymbolicLink()) {
      const target = realpathSync.native(full)
      if (!withinWorkspace(root, target)) throw new Error('COMMAND_FILES_UNBASELINED')
      files.push({ path: rel, linkIdentity: hash(manifestKey(target)), sha256: hashFileBytes(target) })
    } else if (lst.isFile()) {
      files.push({ path: rel, sha256: hashFileBytes(full) })
    } else {
      throw new Error('COMMAND_FILES_UNBASELINED')
    }
  }
  return hash(JSON.stringify({ commands, files }))
}

export function requiredCommands(spec: PersonalItemExecution, commands: Checks, flexibleNoChecks = false, root?: string) {
  const legacyDigest = computeLegacyChecksDigest(commands)
  if (!root) {
    if (legacyDigest !== spec.checksDigest) throw new Error('Verification configuration changed')
  } else {
    const v2Digest = computeChecksDigest(root, commands)
    if (spec.checksDigestVersion === 2) {
      if (v2Digest !== spec.checksDigest) throw new Error('Verification configuration changed')
    } else if (spec.checksDigest !== v2Digest) {
      if (spec.checksDigest === legacyDigest) throw new Error('CHECKS_REBASELINE_REQUIRED')
      throw new Error('Verification configuration changed')
    }
  }
  if (flexibleNoChecks && !commands.length && spec.item.checks.length === 1 && spec.item.checks[0] === 'self-check') return []
  const selected = [...new Set(spec.item.checks)].map(id => commands.find(command => command.id === id))
  if (selected.some(command => !command)) throw new Error('Required verification unavailable')
  return selected.map(command => command!)
}
