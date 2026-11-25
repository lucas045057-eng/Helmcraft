import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import { WorkerConfigSchema, WorkspaceHarnessConfig } from './schema.js'
import type { WorkerConfig } from './schema.js'
import { resolveWorkspaceRoot, withinWorkspace } from '../security/workspace.js'

export const defaultWorkerConfig = join(process.env.APPDATA ?? homedir(), 'agent-worker', 'worker.yaml')
export const defaultWorkerState = join(process.env.LOCALAPPDATA ?? homedir(), 'agent-worker')
export function readWorkerConfig(path: string) {
  return WorkerConfigSchema.parse(parse(readFileSync(path, 'utf8')))
}
export function loadWorkerConfig(path = defaultWorkerConfig, stateDir = defaultWorkerState) {
  return resolveWorkspaces(readWorkerConfig(path), path, stateDir)
}

// Parse structural fields independently so an invalid edit to a blocked command cannot
// prevent an unrelated hot update. Only trusted startup values can supply commands.
export function loadWorkerReload(path: string, stateDir: string, previous: WorkerConfig, exposureSeen: boolean,
  blocked: (workspace: string) => void) {
  const raw = parse(readFileSync(path, 'utf8'))
  const requested = new Map<string, unknown>()
  for (const ws of Array.isArray(raw?.workspaces) ? raw.workspaces : []) {
    if (!ws?.harness || typeof ws.harness !== 'object' || Array.isArray(ws.harness)) continue
    requested.set(ws.id, { ...ws.harness })
    for (const key of ['verify', 'tamper', 'manifest']) delete ws.harness[key]
  }
  const next = resolveWorkspaces(WorkerConfigSchema.parse(raw), path, stateDir)
  const freeze = exposureSeen || next.workspaces.some(ws => ws.configExposed)
  for (const ws of next.workspaces) {
    const parsed = WorkspaceHarnessConfig.safeParse(requested.get(ws.id))
    if (!freeze) {
      if (!parsed.success) throw parsed.error
      ws.harness = parsed.data
      continue
    }
    const old = previous.workspaces.find(other => other.id === ws.id && other.path === ws.path)?.harness ?? WorkspaceHarnessConfig.parse({})
    const retained = { ...old, blackboard: ws.harness.blackboard }
    if (!parsed.success || !isDeepStrictEqual(parsed.data, retained)) blocked(ws.id)
    ws.harness = retained
  }
  return next
}

export function resolveWorkspaces(config: WorkerConfig, path = defaultWorkerConfig, stateDir = defaultWorkerState) {
  const paths = [path, stateDir, join(stateDir, 'state'), join(stateDir, 'state', 'journal.jsonl'), resolve(dirname(path), config.hub.identityPath ?? 'identity.key'),
    config.localLogs.dir?.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match) ?? join(stateDir, 'runs')]
  function physical(path: string): string {
    if (existsSync(path)) return realpathSync.native(path)
    const parent = dirname(path)
    return parent === path ? path : join(physical(parent), path.slice(parent.length))
  }
  const protectedPaths = paths.flatMap(p => [resolve(p), physical(resolve(p))])
  const ids = new Set<string>()
  const roots: string[] = []
  for (const workspace of config.workspaces) {
    if (ids.has(workspace.id)) throw new Error('Duplicate workspace ID')
    const root = resolveWorkspaceRoot(workspace.path)
    if (roots.some(other => withinWorkspace(root, other) || withinWorkspace(other, root))) throw new Error('Overlapping workspace roots')
    workspace.path = root
    workspace.configExposed = protectedPaths.some(p => withinWorkspace(root, p) || withinWorkspace(p, root))
    roots.push(root)
    ids.add(workspace.id)
  }
  return config
}

export function workspaceDeclarations(config: ReturnType<typeof loadWorkerConfig>) {
  return config.workspaces.map(({ id, label, allowedAdapters, maxProfile, maxConcurrent, path }) => ({
    id, label, allowedAdapters, maxProfile, maxConcurrent, isGitRepo: existsSync(join(path, '.git')),
  }))
}
