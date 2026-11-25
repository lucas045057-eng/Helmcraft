import { execFile } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'
import type { CliAdapter, InvocationInput, ResolvedExe } from './types.js'
import { resolveExe } from './resolve-exe.js'
import { adapterPassEnv, buildEnvironment } from '../security/env.js'

type AdapterConfig = InvocationInput['adapterConfig']
const probeTimeoutMs = 5000

function execute(exe: ResolvedExe, args: string[], signal: AbortSignal, config: Pick<AdapterConfig, 'passEnv' | 'env'>) {
  const { env } = buildEnvironment(process.env, config)
  return new Promise<{ code: number | string | null; output: string }>((resolve, reject) => {
    const child = execFile(exe.command, [...exe.prefixArgs, ...args], {
      env, signal, timeout: probeTimeoutMs, maxBuffer: 256 * 1024, windowsHide: true, shell: false,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) reject(error)
      else resolve({ code: error?.code ?? 0, output: stripVTControlCharacters([stdout, stderr].filter(Boolean).join('\n')).trim() })
    })
    child.stdin?.end()
  })
}

export function realCli(id: CliAdapter['id'], name: string, help: string[][] = [], authArgs?: string[]):
  Pick<CliAdapter, 'features' | 'probe' | 'dumpHelp'> {
  return {
    features: { resume: true, liveInput: false, structuredOutput: true },
    async probe(signal, config) {
      const found = resolveExe(name, config?.command === undefined ? {} : { command: config.command })
      if (found.status !== 'ready') return found
      const { exe } = found
      const environment = config ?? { passEnv: adapterPassEnv[id], env: {} }
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(probeTimeoutMs)])
      let version: string | undefined
      try {
        const result = await execute(exe, ['--version'], deadline, environment)
        version = result.output.split(/\r?\n/).find(line => /\b\d+\.\d+\.\d+\b/u.test(line))?.trim().slice(0, 64)
        const unauthenticated = (output: string) => /\b(?:not (?:logged in|authenticated)|please (?:log|sign) in)\b|"loggedIn"\s*:\s*false/iu.test(output)
        if (unauthenticated(result.output)) return { status: 'error', exe, error: 'not authenticated', ...(version && { version }) }
        if (result.code !== 0 || !version) return { status: 'error', exe, error: 'CLI version could not be determined' }
        if (authArgs && !(id === 'codex' && buildEnvironment(process.env, environment).env.OPENAI_API_KEY)) {
          // Older or custom CLIs may not implement this status subcommand.
          const auth = await execute(exe, authArgs, deadline, environment)
          if (unauthenticated(auth.output)) return { status: 'error', exe, version, error: 'not authenticated' }
        }
        return { status: 'ready', exe, version }
      } catch {
        return { status: 'error', exe, ...(version && { version }),
          error: deadline.aborted ? 'Adapter probe timed out after 5 s' : 'Adapter probe failed' }
      }
    },
    async dumpHelp(exe, signal, config) {
      const outputs: Record<string, string> = {}
      for (const args of [[], ...help]) {
        const key = [...args, '--help'].join(' ')
        try { outputs[key] = (await execute(exe, [...args, '--help'], signal, config)).output }
        catch { outputs[key] = 'CLI help is unavailable' }
      }
      return outputs
    },
  }
}
