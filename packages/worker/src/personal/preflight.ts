import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { release } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { PersonalBinding, type AdapterId } from '@agent-hub/protocol'
import type { AdapterRegistry } from '../adapters/registry.js'
import type { WorkerConfig } from '../config/schema.js'
import { buildEnvironment } from '../security/env.js'
import { resolveWorkspaceSubdir, withinWorkspace } from '../security/workspace.js'
import { bindRepository, personalProfiles, readonlyAdvisor, type PersonalRole } from './roles.js'

export function isCommandBoundToProject(workspaceRoot: string, projectRoot: string, cmd: { cwd?: string | undefined }): boolean {
  let wsRoot: string
  let projRoot: string
  try {
    wsRoot = resolveWorkspaceSubdir(workspaceRoot)
    projRoot = resolveWorkspaceSubdir(projectRoot)
  } catch {
    return false
  }
  if (projRoot === wsRoot) return true
  if (!cmd.cwd) return false
  try {
    const cmdCwd = resolveWorkspaceSubdir(workspaceRoot, cmd.cwd)
    return withinWorkspace(projRoot, cmdCwd)
  } catch {
    return false
  }
}

const roles: PersonalRole[] = ['main', 'reviewer', 'advisor']
const rolePrefs: Record<PersonalRole, AdapterId[]> = {
  main: ['codex', 'claude-code', 'antigravity', 'mock'],
  reviewer: ['claude-code', 'codex', 'antigravity', 'mock'],
  advisor: ['antigravity', 'claude-code', 'codex', 'mock'],
}

export function personalBinding(config: WorkerConfig, workspaceId: string, registry: AdapterRegistry): PersonalBinding {
  if (process.platform !== 'linux' || !/microsoft.*wsl2/iu.test(release())) throw new Error('The personal workflow requires WSL2')
  if (!config.harness.enabled) throw new Error('Personal workflow requires harness.enabled=true on the Worker')
  const workspace = config.workspaces.find(w => w.id === workspaceId)
  if (!workspace || workspace.maxProfile === 'readonly' || workspace.configExposed) throw new Error('Personal workspace unavailable')
  const repository = bindRepository(workspace.path)
  const executables = { main: '', reviewer: '', advisor: '' }
  for (const role of roles) {
    const fixed = personalProfiles[role], probe = registry.get(fixed.adapter)?.result
    if (!workspace.allowedAdapters.includes(fixed.adapter) || probe?.status !== 'ready' || !probe.exe ||
        probe.exe.prefixArgs.length || probe.version?.match(/\b\d+\.\d+\.\d+\b/u)?.[0] !== fixed.version) {
      throw new Error('Personal CLI unavailable or version changed: ' + role)
    }
    executables[role] = realpathSync.native(probe.exe.command)
  }
  return PersonalBinding.parse({ workerId: config.workerId, workspaceId, ...repository, executables })
}

export function flexibleBinding(
  config: WorkerConfig,
  workspaceId: string,
  registry: AdapterRegistry,
  opts: { subdir?: string | undefined; autoCommit?: boolean | undefined; autoPush?: boolean | undefined } = {},
): PersonalBinding {
  if (!config.harness.enabled) throw new Error('Personal workflow requires harness.enabled=true on the Worker')
  const workspace = config.workspaces.find(w => w.id === workspaceId)
  if (!workspace || workspace.maxProfile === 'readonly' || workspace.configExposed) throw new Error('Personal workspace unavailable')
  const root = opts.subdir ? resolveWorkspaceSubdir(workspace.path, opts.subdir) : resolveWorkspaceSubdir(workspace.path)
  if (opts.subdir && workspace.harness.verify.commands.length > 0 &&
      !workspace.harness.verify.commands.some(c => isCommandBoundToProject(workspace.path, root, c))) {
    throw new Error('SUBDIR_VERIFY_COMMANDS_UNBOUND')
  }
  const autoPush = opts.autoPush === true
  const autoCommit = opts.autoCommit ?? true
  const repository = bindRepository(root, { allowNoUpstream: !autoPush })
  const pickAdapter = (role: PersonalRole): { id: AdapterId; exe: string } => {
    for (const candidate of rolePrefs[role]) {
      const probe = registry.get(candidate)?.result
      if (workspace.allowedAdapters.includes(candidate) && probe?.status === 'ready' && probe.exe) {
        return { id: candidate, exe: probe.exe.command }
      }
    }
    throw new Error('No supported ready adapter available for role: ' + role)
  }
  const main = pickAdapter('main')
  const reviewer = pickAdapter('reviewer')
  const advisor = pickAdapter('advisor')
  return PersonalBinding.parse({
    workerId: config.workerId,
    workspaceId,
    ...repository,
    executables: { main: main.exe, reviewer: reviewer.exe, advisor: advisor.exe },
    mode: 'flexible',
    allowVersionDrift: true,
    autoCommit,
    autoPush,
    ...(opts.subdir && { subdir: opts.subdir }),
    adapters: { main: main.id, reviewer: reviewer.id, advisor: advisor.id },
  })
}

export function assertBinding(expected: PersonalBinding, actual: PersonalBinding) {
  if (!isDeepStrictEqual(expected, actual)) throw new Error('Personal workspace, Git target or CLI binding changed')
}

export async function preflight(config: WorkerConfig, workspaceId: string, registry: AdapterRegistry) {
  await registry.probe(roles.map(role => personalProfiles[role].adapter))
  const binding = personalBinding(config, workspaceId, registry)
  const tip = spawnStatus('git', ['ls-remote', '--exit-code', '--refs', binding.remote, binding.ref], {
    ...process.env, GIT_TERMINAL_PROMPT: '0',
  }, binding.root).trim().split(/\s+/u)
  if (tip.length !== 2 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip[0]!) || tip[1] !== binding.ref) {
    throw new Error('Could not confirm the upstream ref')
  }
  for (const role of roles) {
    const adapter = config.adapters[personalProfiles[role].adapter]
    const { env } = buildEnvironment(process.env, adapter)
    const cli = binding.executables[role]
    const invocation = role === 'advisor' ? readonlyAdvisor(binding.root, cli, ['models']) :
      { command: cli, args: role === 'main' ? ['login', 'status'] : ['auth', 'status', '--json'] }
    // codex prints login status to stderr. Never include account strings or raw output in diagnostics.
    const result = spawnStatus(invocation.command, invocation.args, env, binding.root)
    const verified = role === 'main' ? /\bLogged in (?:using|with)\b/iu.test(result) :
      role === 'reviewer' ? /"loggedIn"\s*:\s*true/u.test(result) : result.split(/\r?\n/u).some(line => line.split(/\s/u)[0] === personalProfiles.advisor.model)
    if (!verified) throw new Error('CLI authentication or model unavailable: ' + role)
  }
  return binding
}

export async function flexiblePreflight(
  config: WorkerConfig,
  workspaceId: string,
  registry: AdapterRegistry,
  opts: { subdir?: string | undefined; autoCommit?: boolean | undefined; autoPush?: boolean | undefined } = {},
) {
  const workspace = config.workspaces.find(w => w.id === workspaceId)
  if (!workspace) throw new Error('Unknown workspace: ' + workspaceId)
  await registry.probe(workspace.allowedAdapters)
  const binding = flexibleBinding(config, workspaceId, registry, opts)
  if (opts.autoPush && binding.remote !== 'local') {
    const tip = spawnStatus('git', ['ls-remote', '--exit-code', '--refs', binding.remote, binding.ref], {
      ...process.env, GIT_TERMINAL_PROMPT: '0',
    }, binding.root).trim().split(/\s+/u)
    if (tip.length !== 2 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tip[0]!) || tip[1] !== binding.ref) {
      throw new Error('Could not confirm the upstream ref')
    }
  }
  const boundCommands = opts.subdir
    ? workspace.harness.verify.commands.filter(c => isCommandBoundToProject(workspace.path, binding.root, c))
    : workspace.harness.verify.commands
  const configuredChecks = boundCommands.map(c => c.id)
  return {
    binding,
    checks: configuredChecks.length ? configuredChecks : ['self-check'],
    noChecks: !configuredChecks.length,
  }
}

function spawnStatus(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, args, { cwd, env, timeout: 20_000, maxBuffer: 256 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error || result.status !== 0) return ''
  return result.stdout + '\n' + result.stderr
}
