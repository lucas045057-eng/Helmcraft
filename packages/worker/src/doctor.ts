import { resolveVerifyCommand } from './harness/verify-runner.js'
import { checkBoardDir } from './harness/board-reader.js'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { AdapterRegistry } from './adapters/registry.js'
import { readWorkerConfig, resolveWorkspaces } from './config/load.js'
import type { WorkerConfig } from './config/schema.js'
import { identityPermissionsArePrivate, readIdentity } from './identity.js'
import { checkWindowsJobObject } from './runner/kill-tree.js'

function jobObjectStatus(enabled = true) {
  if (process.platform !== 'win32') return { status: 'not_applicable', mode: 'process-group' }
  if (!enabled) return { status: 'warning', mode: 'taskkill', warning: 'Windows Job Objects are disabled in worker.yaml' }
  try {
    checkWindowsJobObject()
    return { status: 'ok', mode: 'job' }
  } catch {
    return { status: 'warning', mode: 'taskkill', warning: 'Windows Job Objects via koffi are unavailable' }
  }
}

function identityStatus(path: string) {
  if (!existsSync(path)) return { path, status: 'missing' }
  try {
    readIdentity(path)
    const acl = identityPermissionsArePrivate(path)
      ? { status: 'ok' }
      : { status: 'error', error: 'Identity permissions allow access beyond the current user' }
    return { path, status: acl.status, type: 'ed25519', acl }
  } catch {
    return { path, status: 'error', error: 'Identity or its permissions could not be validated' }
  }
}

async function checkHub(hub: string) {
  const url = new URL('/healthz', hub)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
    await response.body?.cancel()
    return { status: response.ok ? 'ok' : 'error', url: url.href, httpStatus: response.status }
  } catch {
    return { status: 'error', url: url.href, error: 'Hub health check failed' }
  }
}

async function adapterStatus(config: WorkerConfig, dumpHelp: boolean) {
  const registry = new AdapterRegistry(config)
  const capabilities = await registry.probe()
  const results = []
  for (const capability of capabilities) {
    const probe = registry.get(capability.id)
    const exe = probe?.result.exe
    const help = dumpHelp && exe && probe?.adapter?.dumpHelp
      ? await probe.adapter.dumpHelp(exe, AbortSignal.timeout(5000), config.adapters[capability.id]) : undefined
    results.push({ ...capability, ...(exe && { exe }), ...(help && { help }) })
  }
  return results
}

export async function doctor(path: string, options: { dumpHelp: boolean; checkHub: boolean }) {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const node = { version: process.version, status: major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'error' }
  let config: WorkerConfig
  try {
    config = readWorkerConfig(path)
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { ok: false, node, config: { path, status: missing ? 'missing' : 'error',
      error: missing ? 'worker.yaml is missing' : 'worker.yaml could not be parsed or failed schema validation' },
    jobObject: jobObjectStatus() }
  }
  let workspaceError: string | undefined
  try { resolveWorkspaces(config, path) }
  catch (error) { workspaceError = error instanceof Error ? error.message : 'Workspace validation failed' }
  const workspaces = await Promise.all(config.workspaces.map(async ({ id, path, harness, configExposed }) => {
    const board = config.harness.enabled && harness.blackboard && !workspaceError ? await checkBoardDir(path) : undefined
    const verify = harness.verify.commands.map(command => {
      const resolved = resolveVerifyCommand(command.argv[0]!)
      return { id: command.id, status: resolved.status, ...(resolved.status === 'error' && { error: resolved.error }),
        ...(resolved.status === 'ready' && { executable: resolved.exe.command }) }
    })
    return { id, path, verify, ...(configExposed && { warning: 'VERIFY_CONFIG_EXPOSED' }), blackboard: harness.blackboard, board: board?.dir ?? 'skipped', ...(board?.dirReason && { boardReason: board.dirReason }) }
  }))
  const identity = identityStatus(resolve(dirname(path), config.hub.identityPath ?? 'identity.key'))
  const [adapters, hub] = await Promise.all([
    adapterStatus(config, options.dumpHelp),
    options.checkHub ? checkHub(config.hub.url) : Promise.resolve({ status: 'skipped' }),
  ])
  const ok = node.status === 'ok' && workspaceError === undefined && identity.status === 'ok'
    && adapters.every(adapter => adapter.status === 'ready') && hub.status !== 'error'
  return { ok, node, config: { path, status: 'ok', harness: config.harness }, workspaces, workspaceStatus: workspaceError ? 'error' : 'ok',
    ...(workspaceError && { workspaceError }), identity,
    jobObject: jobObjectStatus(config.security.useJobObject), adapters, hub }
}
