import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RunDispatch } from '@agent-hub/protocol'
import { withinWorkspace } from '../security/workspace.js'
import type { CliAdapter, InvocationInput } from '../adapters/types.js'

export const personalProfiles = {
  main: { adapter: 'codex', profile: 'edit', model: 'gpt-6.2-astra', version: '0.166.0' },
  reviewer: { adapter: 'claude-code', profile: 'readonly', model: 'claude-opus-5-5', version: '2.1.318' },
  advisor: { adapter: 'antigravity', profile: 'readonly', model: 'gemini-4-carbon-high', version: '1.5.17' },
} as const
export type PersonalRole = keyof typeof personalProfiles

export function bindRepository(directory: string) {
  const root = realpathSync.native(directory)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, timeout: 5000,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  if (realpathSync.native(git('rev-parse', '--show-toplevel')) !== root) throw new Error('Expected the repository root')
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD')
  git('rev-parse', '--verify', 'HEAD^{commit}')
  const upstream = git('for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/' + branch)
  const [remote, ref] = upstream.split('\0')
  if (!remote || remote === '.' || remote.startsWith('-') || !ref?.startsWith('refs/heads/')) throw new Error('No fixed upstream remote/ref')
  const fetchUrl = git('remote', 'get-url', '--all', remote)
  const pushUrl = git('remote', 'get-url', '--push', '--all', remote)
  if (!pushUrl || !fetchUrl || /[\r\n]/u.test(fetchUrl + pushUrl)) throw new Error('Ambiguous remote destination')
  const destination = createHash('sha256').update(fetchUrl + '\0' + pushUrl).digest('hex')
  return { root, branch, remote, ref, destination }
}

interface RoleRequest {
  adapter: string; model?: string | undefined; profile: string; extraArgs?: string[] | undefined; env?: unknown; resume?: unknown
  subdir?: string | undefined; origin?: RunDispatch['origin']
}
export function checkPersonalRole(role: PersonalRole, request: RoleRequest) {
  const fixed = personalProfiles[role]
  if (request.adapter !== fixed.adapter || request.model !== fixed.model || request.profile !== fixed.profile ||
      request.extraArgs?.length || request.env || request.resume || request.subdir ||
      (request.origin && request.origin.actorType !== 'owner')) throw new Error('Personal role policy mismatch')
}

export function readonlyAdvisor(root: string, command: string, args: string[]) {
  const dirs = [join(homedir(), '.gemini/antigravity-cli'), join(homedir(), '.cache/antigravity')]
  const sharedState: string[] = []
  for (const dir of dirs) {
    const real = realpathSync.native(dir)
    if (real !== dir || withinWorkspace(root, real) || withinWorkspace(real, root)) throw new Error('CLI state overlaps the repository')
    sharedState.push('--bind', real, real)
  }
  const dns = realpathSync.native('/etc/resolv.conf')
  const resolver = dns.startsWith('/mnt/') || dns.startsWith('/run/') ? ['--ro-bind', '/etc/resolv.conf', dns] : []
  return { command: '/usr/bin/bwrap', args: ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/mnt',
    ...resolver, ...sharedState, '--chdir', '/tmp', '--', command, ...args] }
}

export function personalInvocation(role: PersonalRole, adapter: CliAdapter, input: InvocationInput) {
  const policy = personalProfiles[role]
  const fixed = role === 'main' ? ['--sandbox', 'workspace-write', '-c', 'model_reasoning_effort="high"'] :
    role === 'reviewer' ? ['--permission-mode', 'dontAsk', '--effort', 'medium', '--safe-mode', '--strict-mcp-config',
      '--disable-slash-commands', '--no-session-persistence', '--tools', ''] : ['--sandbox', '--disable-slash-commands']
  const invocation = adapter.buildInvocation({ ...input, profile: policy.profile, model: policy.model,
    extraArgs: [], adapterConfig: { ...input.adapterConfig, argsOverride: { [policy.profile]: fixed } } })
  return role === 'advisor' ? { ...invocation, ...readonlyAdvisor(input.cwd, invocation.command, invocation.args) } : invocation
}
