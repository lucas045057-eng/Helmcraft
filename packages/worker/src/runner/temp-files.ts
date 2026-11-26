import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunAttachment } from '@agent-hub/protocol'
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

export interface StagedAttachment {
  id: string
  kind: RunAttachment['kind']
  name: string
  mimeType: string
  path: string
}

export function stageRunAttachments(dir: string, attachments: RunAttachment[]): StagedAttachment[] {
  return attachments.map((att, index) => {
    if (!/^[A-Za-z0-9._-]+$/.test(att.name)) throw new Error('Invalid attachment filename')
    const filename = `att-${index + 1}-${att.name}`
    const path = join(dir, filename)
    const buffer = Buffer.from(att.data, 'base64')
    writeFileSync(path, buffer, { mode: 0o600, flag: 'wx' })
    return { id: att.id, kind: att.kind, name: att.name, mimeType: att.mimeType, path }
  })
}
