import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { trackProcessTree } from '../src/runner/kill-tree.js'
import { processAlive } from '../src/runner/process-identity.js'

it.runIf(process.platform === 'win32')('reports a detached survivor when Windows Job Objects are disabled', async () => {
  const mock = fileURLToPath(new URL('../../mock-cli/src/index.ts', import.meta.url))
  const child = spawn(process.execPath, [mock], { detached: true, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] })
  const closed = once(child, 'close')
  let stdout = '', orphan: number | undefined
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  const warnings: unknown[] = []
  const tree = trackProcessTree(child.pid!, { useJobObject: false, onWarning: warning => warnings.push(warning) })
  try {
    child.stdin.end('#scenario: orphan\n')
    await closed
    orphan = (JSON.parse(stdout) as { pid: number }).pid
    expect(processAlive(orphan)).toBe(true)
    tree.observe(orphan)
    await tree.kill({ force: true })
    expect(warnings).toContainEqual({ code: 'ORPHAN_SURVIVED', pid: orphan })
  } finally {
    if (orphan && processAlive(orphan)) process.kill(orphan)
    tree.close()
    if (processAlive(child.pid!)) child.kill()
  }
}, 15_000)
