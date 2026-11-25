import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Invocation } from '../adapters/types.js'

const prefix = 'run-'

export function removeRunTempDir(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

export function recoverRunTempFiles(root: string) {
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^run-[a-zA-Z0-9]{6}$/.test(entry.name)) removeRunTempDir(join(root, entry.name))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function createRunTempDir(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(root, prefix))
}

export function writeRunTempFiles(dir: string, invocation: Invocation, env: NodeJS.ProcessEnv) {
  for (const file of invocation.tempFiles ?? []) {
    if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(file.path)) throw new Error('Invalid Run temp filename')
    const path = join(dir, file.path)
    writeFileSync(path, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (const [name, value] of Object.entries(invocation.env)) {
      if (value === file.path) env[process.platform === 'win32' ? name.toUpperCase() : name] = path
    }
  }
}
