import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { stringify } from 'yaml'
import { WorkerEnrollResponse, WorkerId } from '@agent-hub/protocol'
import { AdapterRegistry } from './adapters/registry.js'
import { startWorker } from './app.js'
import { defaultWorkerConfig, loadWorkerConfig } from './config/load.js'
import { WorkerConfigSchema } from './config/schema.js'
import { loadIdentity } from './identity.js'
import { WorkerAlreadyRunning } from './runner/lock.js'
import { doctor } from './doctor.js'
import { preflight } from './personal/preflight.js'
import { installTask, uninstallTask } from './scheduled-task.js'

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, hub: { type: 'string' }, token: { type: 'string' }, id: { type: 'string' }, 'worker-id': { type: 'string' },
    'task-name': { type: 'string' }, 'dump-help': { type: 'boolean' }, 'check-hub': { type: 'boolean' },
  } })
  const path = resolve(values.config ?? defaultWorkerConfig)
  switch (positionals[0]) {
    case 'personal-preflight': {
      const config = loadWorkerConfig(path)
      try {
        const binding = await preflight(config, positionals[1] ?? '', new AdapterRegistry(config))
        console.log(JSON.stringify({ ok: true, binding }))
        return 0
      } catch (error) {
        const cause = error instanceof Error ? error.message : 'Personal preflight failed'
        console.log(JSON.stringify({ ok: false, reason: cause.startsWith('Command failed:') ? 'Could not confirm Git binding' : cause }))
        return 1
      }
    }
    case 'doctor': {
      const report = await doctor(path, { dumpHelp: values['dump-help'] ?? false, checkHub: values['check-hub'] ?? false })
      console.log(JSON.stringify(report, null, 2))
      return report.ok ? 0 : 1
    }
    case 'install-task':
      loadWorkerConfig(path)
      await installTask(path, values['task-name'])
      return 0
    case 'uninstall-task':
      await uninstallTask(values['task-name'])
      return 0
  }
  const existing = existsSync(path) ? loadWorkerConfig(path) : undefined
  const identityPath = resolve(dirname(path), existing?.hub.identityPath ?? 'identity.key')
  switch (positionals[0]) {
    case 'enroll': {
      const workerId = WorkerId.parse(values.id ?? values['worker-id'] ?? existing?.workerId)
      const hub = new URL(values.hub ?? existing?.hub.url ?? '')
      if (hub.protocol === 'https:') hub.protocol = 'wss:'
      else if (hub.protocol === 'http:') hub.protocol = 'ws:'
      if (hub.pathname === '/') hub.pathname = '/ws/worker'
      const draft = { workerId, hub: { url: hub.href }, workspaces: [] }
      WorkerConfigSchema.parse(draft)
      if (existing && (existing.workerId !== workerId || existing.hub.url !== hub.href)) throw new Error('Enrollment differs from worker.yaml')
      if (!values.token) throw new Error('An enroll token is required')
      const identity = loadIdentity(identityPath, true)
      const url = new URL('/api/v1/worker-enroll', hub)
      url.protocol = hub.protocol === 'wss:' ? 'https:' : 'http:'
      const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId, token: values.token,
          publicKey: identity.publicKey, hostname: hostname(), os: process.platform }) })
      if (!response.ok) throw new Error('Worker enrollment failed (HTTP ' + response.status + ')')
      const receipt = WorkerEnrollResponse.parse(await response.json())
      if (receipt.workerId !== workerId || receipt.keyFingerprint !== identity.fingerprint) throw new Error('Enrollment identity mismatch')
      if (!existing) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, stringify(draft), { flag: 'wx', mode: 0o600 })
      }
      console.log('Enrolled ' + workerId)
      return 0
    }
    case 'probe': {
      if (!existing) throw new Error('worker.yaml is required')
      const registry = new AdapterRegistry(existing)
      console.log(JSON.stringify(await registry.probe()))
      return registry.capabilities().some(item => item.status !== 'ready') ? 1 : 0
    }
    case 'run': {
      if (!existing) throw new Error('worker.yaml is required')
      const worker = await startWorker(existing, { identity: loadIdentity(identityPath), configPath: path,
        onStop: code => { process.exitCode = code; removeSignals() } })
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK' as const] : [])]
      const stop = () => { void worker.close().then(removeSignals, () => { process.exitCode = 1; removeSignals() }) }
      function removeSignals() { for (const signal of signals) process.off(signal, stop) }
      for (const signal of signals) process.on(signal, stop)
      return undefined
    }
    default: throw new Error('Usage: agent-worker run | enroll | probe | doctor | install-task | uninstall-task')
  }
}
export async function runCli() {
  try { const status = await main(); if (status !== undefined) process.exitCode = status }
  catch (error) {
    console.error(error instanceof WorkerAlreadyRunning ? error.message : 'Worker command failed')
    process.exitCode = error instanceof WorkerAlreadyRunning ? 3 : 1
  }
}
