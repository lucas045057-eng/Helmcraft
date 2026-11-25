import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Invocation } from '../adapters/types.js'
export function spawnRun(invocation: Invocation, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(invocation.command, invocation.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, detached: process.platform !== 'win32', shell: false })
  child.stdin.on('error', () => undefined)
  return child
}

export function writePrompt(child: ChildProcessWithoutNullStreams, input: string, liveInput: boolean) {
  if (liveInput) child.stdin.write(input.endsWith('\n') ? input : input + '\n', 'utf8')
  else child.stdin.end(input, 'utf8')
}
