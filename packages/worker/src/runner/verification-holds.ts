import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { resolveWorkspaceRoot, withinWorkspace } from '../security/workspace.js'

const Hold = z.strictObject({
  runId: z.string().min(1), workspaceId: z.string().min(1),
  root: z.string().nullable(), directoryId: z.string().nullable(),
})
type Hold = z.infer<typeof Hold>

function identify(path: string) {
  const root = resolveWorkspaceRoot(path)
  const stat = statSync(root, { bigint: true })
  return { root, directoryId: stat.ino ? stat.dev + ':' + stat.ino : null }
}

/** The Worker state lock serializes writers of this file. An outstanding record
 * means that the Worker has no durable proof of cleanup, including after restart. */
export class VerificationHolds {
  private records: Hold[]
  constructor(private readonly path: string) {
    try { this.records = z.array(Hold).parse(JSON.parse(readFileSync(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.records = []
    }
  }

  private save(next: Hold[]) {
    writeFileSync(this.path + '.tmp', JSON.stringify(next), { mode: 0o600, flush: true })
    renameSync(this.path + '.tmp', this.path)
    this.records = next
  }

  blocks(workspaceId: string, path: string): boolean {
    if (!this.records.length) return false
    if (this.records.some(record => record.workspaceId === workspaceId || !record.root)) return true
    const current = identify(path)
    return this.records.some(record => (current.directoryId !== null && record.directoryId === current.directoryId) ||
      withinWorkspace(record.root!, current.root) || withinWorkspace(current.root, record.root!))
  }

  begin(runId: string, workspaceId: string, path: string) {
    if (this.blocks(workspaceId, path)) throw new Error('Verification cleanup is pending')
    const hold = { runId, workspaceId, ...identify(path) }
    this.save([...this.records, hold])
    // Only the invocation which created this record may attest its cleanup.
    return () => {
      if (!this.records.includes(hold)) throw new Error('Stale verification cleanup')
      this.save(this.records.filter(record => record !== hold))
    }
  }

  recover(runId: string, workspaceId: string, path?: string) {
    if (this.records.some(record => record.runId === runId)) return
    let identity: Pick<Hold, 'root' | 'directoryId'> = { root: null, directoryId: null }
    if (path) {
      try { identity = identify(path) } catch { /* Unresolved legacy identity blocks writers pending reconciliation. */ }
    }
    this.save([...this.records, { runId, workspaceId, ...identity }])
  }
}
