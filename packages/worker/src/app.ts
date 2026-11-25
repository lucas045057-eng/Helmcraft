import { watch } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { redact, SystemClock } from '@agent-hub/common'
import type { Clock } from '@agent-hub/common'
import { AdapterRegistry } from './adapters/registry.js'
import type { CliAdapter } from './adapters/types.js'
import { defaultWorkerState, loadWorkerReload, resolveWorkspaces } from './config/load.js'
import type { WorkerConfig } from './config/schema.js'
import type { WorkerIdentity } from './identity.js'
import { WorkerTunnel } from './tunnel/connection.js'
import type { TunnelOptions } from './tunnel/connection.js'
import { Journal } from './runner/journal.js'
import { acquireWorkerLock } from './runner/lock.js'
import { RunManager } from './runner/run-manager.js'

export interface WorkerOptions extends TunnelOptions {
  stateDir?: string
  configPath?: string
  identity: WorkerIdentity
  clock?: Clock
  adapters?: CliAdapter[]
}
function expandPath(path: string) { return path.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match) }

export async function startWorker(input: WorkerConfig, options: WorkerOptions) {
  let config = resolveWorkspaces(structuredClone(input), options.configPath, options.stateDir)
  const clock = options.clock ?? new SystemClock()
  const stateDir = options.stateDir ?? defaultWorkerState
  const release = acquireWorkerLock(join(stateDir, 'worker.lock'))
  const warn = (text: string, code = 'WORKER_WARNING') => {
    const message = redact(text)
    options.onWarning?.(code + ' ' + message)
    if (!options.onWarning) console.error(JSON.stringify({ ts: clock.now(), level: 'warn', code, message }))
  }
  try {
    let exposureSeen = config.workspaces.some(ws => ws.configExposed)
    const reportExposure = (next: WorkerConfig) => {
      for (const ws of next.workspaces) if (ws.configExposed) warn(ws.id + ' contains Worker configuration or state', 'VERIFY_CONFIG_EXPOSED')
    }
    reportExposure(config)
    const journal = new Journal(join(stateDir, 'state', 'journal.jsonl'), clock)
    const registry = new AdapterRegistry(config, options.adapters)
    const runner = new RunManager(config, registry, clock, journal,
      config.localLogs.dir ? expandPath(config.localLogs.dir) : join(stateDir, 'runs'), warn, join(stateDir, 'run-temp'))
    await runner.recover()
    await registry.probe()
    let pendingConfig: WorkerConfig | undefined
    let pendingApply = Promise.resolve()
    let debounce: ReturnType<typeof setTimeout> | undefined
    let stopRequested = false
    const tunnel = new WorkerTunnel(config, options.identity, runner, registry, clock, {
      onWarning: warn, onStop: code => { void close().then(() => options.onStop?.(code), () => options.onStop?.(1)) },
      ...(options.random && { random: options.random }),
    })
    function applyPending() {
      const next = pendingConfig
      if (!next || runner.slotsUsed || stopRequested) return
      pendingConfig = undefined
      if (isDeepStrictEqual(next, config)) return
      runner.localDrain = true
      tunnel.state(true, 'config reload')
      config = next
      registry.update(config)
      runner.update(config)
      pendingApply = pendingApply.then(async () => {
        await registry.probe()
        if (stopRequested) return
        runner.localDrain = false
        tunnel.update(config)
      }).catch(() => { runner.localDrain = false; warn('Worker config reload failed') })
    }
    const watcher = options.configPath ? (() => {
      const path = resolve(options.configPath)
      const watcher = watch(dirname(path), (_event, filename) => {
        if (filename !== null && filename !== basename(path)) return
        clearTimeout(debounce)
        debounce = setTimeout(() => {
          try {
            const next = loadWorkerReload(path, stateDir, config, exposureSeen,
              id => warn(id + ' verification configuration changes require restart', 'VERIFY_CONFIG_RELOAD_BLOCKED'))
            reportExposure(next)
            exposureSeen ||= next.workspaces.some(ws => ws.configExposed)
            if (next.workerId !== config.workerId || !isDeepStrictEqual(next.hub, config.hub) ||
              !isDeepStrictEqual(next.localLogs, config.localLogs)) {
              warn('Worker identity, Hub connection or local logging changes require restart')
              return
            }
            pendingConfig = next
            applyPending()
          } catch { warn('Ignored invalid worker.yaml configuration') }
        }, 500)
      })
      watcher.on('error', () => warn('Could not watch worker.yaml'))
      return watcher
    })() : undefined
    const stopRuns = clock.setInterval(() => { runner.tick(); applyPending() }, 250)
    const stopProbe = clock.setInterval(() => { void registry.probe().catch(() => warn('Adapter probe failed')) }, 60_000)
    let closed: Promise<void> | undefined
    function close() {
      if (closed) return closed
      stopRequested = true
      runner.localDrain = true
      tunnel.state(true, 'shutdown')
      watcher?.close()
      clearTimeout(debounce)
      stopProbe()
      closed = (async () => {
        try {
          if (config.shutdown.drainTimeoutMs && runner.slotsUsed) {
            const controller = new AbortController()
            try { await Promise.race([runner.awaitRuns(), delay(config.shutdown.drainTimeoutMs, undefined, { signal: controller.signal })]) }
            finally { controller.abort() }
          }
          runner.cancelAll()
          await runner.awaitRuns()
          const start = clock.monotonic()
          for (let attempts = 0; attempts < 100 && runner.outbox.bufferedBytes && tunnel.online && clock.monotonic() - start < 5000; attempts++) {
            await delay(50)
          }
          await pendingApply
          journal.compact()
        } finally {
          stopRuns()
          try { await tunnel.stop() } finally { release() }
        }
      })()
      return closed
    }
    tunnel.start()
    return { tunnel, runner, registry, close }
  } catch (error) {
    release()
    throw error
  }
}
