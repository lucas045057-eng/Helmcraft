import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { z } from 'zod'
import { withinWorkspace } from '../security/workspace.js'

const Owner = z.strictObject({ project: z.string().min(1), root: z.string().min(1), directoryId: z.string() })
function identity(root: string) {
  const stat = statSync(root, { bigint: true })
  return stat.dev + ':' + stat.ino
}
export class ProjectOccupation {
  constructor(private path: string) {}
  private read() {
    if (!lstatSync(this.path, { throwIfNoEntry: false })) return
    return Owner.parse(JSON.parse(readFileSync(this.path, 'utf8')))
  }
  permits(root: string, project?: string) {
    const owner = this.read()
    if (!owner) return true
    const actual = realpathSync.native(root)
    const same = identity(actual) === owner.directoryId
    if (project === owner.project) return actual === owner.root && same
    return !same && !withinWorkspace(actual, owner.root) && !withinWorkspace(owner.root, actual)
  }
  claim(root: string, project: string) {
    const owner = this.read(), actual = realpathSync.native(root)
    const directoryId = identity(actual)
    if (owner?.project === project && owner.root === actual && owner.directoryId === directoryId) return
    if (owner) throw new Error('Another personal project occupies the Worker')
    writeFileSync(this.path, JSON.stringify({ project, root: actual, directoryId }), { flag: 'wx', flush: true, mode: 0o600 })
  }
  release(root: string, project: string) {
    const owner = this.read()
    if (!owner || owner.project !== project || !this.permits(root, project)) throw new Error('Project occupancy mismatch')
    unlinkSync(this.path)
  }
}
