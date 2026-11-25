import type { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

interface VerificationTree {
  terminate(force: boolean): void
  empty(): boolean
  close(): void
}

interface TerminalState {
  code: number | null
  signal: NodeJS.Signals | null
  cleanupConfirmed: boolean
  outputTruncated: boolean
}

/** Exit supplies the status, close confirms pipe drain, and containment supplies
 * a separate emptiness check. All paths share the same cleanup deadline. */
export function superviseVerification(
  child: EventEmitter & { stdout: Readable; stderr: Readable },
  tree: VerificationTree, stop: AbortSignal, force: AbortSignal,
): Promise<TerminalState> {
  return new Promise(resolve => {
    let code: number | null = null
    let signal: NodeJS.Signals | null = null
    let exited = false
    let drained = false
    let failed = false
    let outputError = false
    let done = false
    let grace: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    let poll: NodeJS.Timeout | undefined

    function finish(confirmed: boolean) {
      if (done) return
      done = true
      clearTimeout(grace)
      clearTimeout(deadline)
      clearInterval(poll)
      child.off('exit', onExit).off('close', onClose).off('error', onError)
      stop.removeEventListener('abort', graceful)
      force.removeEventListener('abort', escalate)
      for (const stream of [child.stdout, child.stderr]) {
        stream.off('error', onPipeError)
        if (!drained) stream.destroy()
      }
      try { tree.close() } catch { failed = true }
      resolve({ code, signal, cleanupConfirmed: confirmed && !failed, outputTruncated: !drained || outputError })
    }
    function check() {
      if (!exited || !drained || done) return
      try {
        if (tree.empty()) finish(true)
      } catch { finish(false) }
    }
    function escalate() {
      if (done || deadline) return
      clearTimeout(grace)
      deadline = setTimeout(() => finish(false), 2000)
      try { tree.terminate(true) } catch { failed = true }
      poll = setInterval(check, 50)
      check()
    }
    function graceful() {
      if (done || grace || deadline) return
      grace = setTimeout(escalate, 5000)
      try { tree.terminate(false) } catch { failed = true; escalate() }
    }
    function onExit(exitCode: number | null, exitSignal: NodeJS.Signals | null) {
      exited = true
      code = exitCode
      signal = exitSignal
      escalate()
      check()
    }
    function onClose() {
      drained = true
      if (!exited) escalate()
      check()
    }
    function onError() { failed = true; escalate() }
    function onPipeError() { outputError = true; onError() }
    child.once('exit', onExit).once('close', onClose).on('error', onError)
    child.stdout.on('error', onPipeError)
    child.stderr.on('error', onPipeError)
    stop.addEventListener('abort', graceful, { once: true })
    force.addEventListener('abort', escalate, { once: true })
    if (force.aborted) escalate()
    else if (stop.aborted) graceful()
  })
}
