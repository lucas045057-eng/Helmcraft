import { redact } from '@agent-hub/common'
import { pathToFileURL } from 'node:url'
import { createHub, onHubFailure } from './app.js'
import { loadHubConfig } from './config/load.js'

export async function main(configPath = process.argv[2] ?? 'hub.yaml') {
  const hub = await createHub(loadHubConfig(configPath), { configPath, log: line => { process.stdout.write(line + '\n') } })
  let stopping = false
  const stop = (exitCode: number) => {
    if (stopping) { if (exitCode === 0) process.exit(130); return }
    stopping = true
    void hub.close().then(() => process.exit(exitCode), () => process.exit(1))
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  if (process.platform === 'win32') process.on('SIGBREAK', () => stop(0))
  process.on('uncaughtException', () => stop(1))
  process.on('unhandledRejection', () => stop(1))
  onHubFailure(hub, () => stop(1))
  return hub
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(JSON.stringify({ level: 'error', msg: redact(error instanceof Error ? error.message : 'Hub startup failed') }))
    process.exitCode = 1
  })
}
