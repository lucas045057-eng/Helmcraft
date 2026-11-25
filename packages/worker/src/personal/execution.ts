import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersonalItemExecution } from '@agent-hub/protocol'
import type { WorkerConfig } from '../config/schema.js'

type Checks = WorkerConfig['workspaces'][number]['harness']['verify']['commands']
const hash = (text: Buffer | string) => createHash('sha256').update(text).digest('hex')

export function planBaseline(root: string, spec: PersonalItemExecution, initial: boolean) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] }).trimEnd()
  const read = (name: string) => {
    const path = join(root, name), stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 256000) throw new Error('Invalid plan input')
    return readFileSync(path)
  }
  const sources = spec.sources.map(name => ({ name, body: new TextDecoder('utf-8', { fatal: true }).decode(read(name)) }))
  if (git('rev-parse', 'HEAD') !== spec.head || hash(read('TASKS.md')) !== spec.tasksDigest ||
      hash(JSON.stringify(sources)) !== spec.sourceDigest) throw new Error('Project baseline changed')
  if (initial) {
    const status = git('status', '--porcelain', '--untracked-files=all')
    if (status !== (spec.first ? '?? TASKS.md' : '')) throw new Error('Unexpected changes before implementation')
  }
}

export function requiredCommands(spec: PersonalItemExecution, commands: Checks) {
  if (hash(JSON.stringify(commands)) !== spec.checksDigest) throw new Error('Verification configuration changed')
  const selected = [...new Set(spec.item.checks)].map(id => commands.find(command => command.id === id))
  if (selected.some(command => !command)) throw new Error('Required verification unavailable')
  return selected.map(command => command!)
}
