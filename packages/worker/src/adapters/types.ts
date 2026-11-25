import type { AdapterCapability, AdapterId, AgentEvent, Profile, RunEvent } from '@agent-hub/protocol'
import type { WorkerConfig } from '../config/schema.js'
import type { ResolvedExe } from './resolve-exe.js'
export type { ResolvedExe } from './resolve-exe.js'

export interface ProbeResult {
  status: AdapterCapability['status']
  version?: string
  exe?: ResolvedExe
  error?: string
}
export interface InvocationInput {
  exe: ResolvedExe; prompt: string; cwd: string; profile: Profile
  resumeSessionId?: string; model?: string; extraArgs: string[]; adapterConfig: WorkerConfig['adapters'][AdapterId]
}
export interface Invocation {
  command: string; args: string[]; stdin: string; env: Record<string, string>
  // Paths are filenames relative to the private Run temp directory.
  tempFiles?: Array<{ path: string; content: string }>
}
export type ParsedItem =
  | { kind: 'log'; stream: 'stdout' | 'stderr'; text: string; truncatedBytes?: number }
  | { kind: 'agent'; event: AgentEvent }
  | { kind: 'session'; cliSessionId: string }
  | { kind: 'progress'; phase: string; detail?: string }
  | { kind: 'input_request'; question: string; options?: string[] }
export type ParsedOutcome = Omit<Extract<RunEvent, {kind: 'finished'}>, 'kind' | 'seq' | 'ts' | 'exitCode' | 'signal' | 'durationMs'>
export interface OutputParser {
  onStdout(line: string): ParsedItem[]
  onStderr(line: string): ParsedItem[]
  flushPending?(): ParsedItem[]
  finish(exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean },
    emit?: (item: ParsedItem) => void): ParsedOutcome
}
export interface CliAdapter {
  readonly id: AdapterId
  readonly displayName: string
  readonly features: AdapterCapability['features']
  probe(signal: AbortSignal, config?: InvocationInput['adapterConfig']): Promise<ProbeResult>
  dumpHelp?(exe: ResolvedExe, signal: AbortSignal, config: InvocationInput['adapterConfig']): Promise<Record<string, string>>
  buildInvocation(input: InvocationInput): Invocation
  createParser(): OutputParser
}
