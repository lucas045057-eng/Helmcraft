import { unwatchFile, watch, watchFile } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import type { HubConfig } from './schema.js'
import { loadHubConfig } from './load.js'

export function watchHubConfig(path: string, apply: (config: HubConfig) => Promise<void>, reject: (error: unknown) => void) {
  const resolved = resolve(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = Promise.resolve()
  let stopped = false
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      pending = pending.then(async () => {
        if (!stopped) await apply(loadHubConfig(resolved))
      }).catch(reject)
    }, 500)
  }
  const watcher = watch(dirname(resolved), (_event, file) => {
    if (file === null || file === basename(resolved)) schedule()
  })
  watcher.on('error', reject)
  // A single-file Docker bind mount may only deliver changes to the mounted inode.
  watchFile(resolved, { interval: 1000, persistent: false }, schedule)
  return async () => {
    stopped = true
    watcher.close()
    unwatchFile(resolved, schedule)
    clearTimeout(timer)
    await pending
  }
}
