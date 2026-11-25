import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { trackProcessTree } from '../../src/runner/kill-tree.ts'

const script = fileURLToPath(new URL('../../../mock-cli/src/index.ts', import.meta.url))
// Exclude libuv's own kill-on-close job so the test observes the explicit job.
const child = spawn(process.execPath, [script], { detached: true, shell: false, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] })
const tree = trackProcessTree(child.pid, { onWarning: console.error })
console.log(JSON.stringify({ mode: tree.mode }))
child.stdin.end('#scenario: spawn-tree depth=3 width=2\n')
setInterval(() => {}, 1_000)
