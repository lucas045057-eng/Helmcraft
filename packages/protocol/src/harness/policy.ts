import type { AdapterId, Profile } from '../common.js'
import type { HarnessDirective, VerificationSummary } from '../worker/harness.js'
import { mockHarnessOptIn } from './prompt.js'
export interface HarnessPolicy { enabled: boolean; blackboard: boolean; allowRequesterBlackboard: boolean
  verify: boolean; allowRequesterVerify: boolean; autoFixMaxRetries: 0 | 1 | 2 }
export interface ResolveHarnessInput {
  caps: readonly string[]                                   // 目标 Worker 当前连接的协商结果
  policy: HarnessPolicy
  requesterType: 'owner' | 'requester'
  profile: Profile
  adapter: AdapterId                                        // DISPATCH 选定的 adapter
  prompt: string
  resume: boolean                                           // 本次派发是否携带 resume.cliSessionId
  handoff: boolean                                          // tasks.handoff_from_run_id 非空
  overrides?: { blackboard?: boolean; verify?: boolean }    // Owner 审批覆写
}
export function resolveHarness(input: ResolveHarnessInput): Omit<HarnessDirective, 'facts'> | null {
  const { policy, caps, requesterType: trust, overrides, profile } = input
  if (!caps.includes('blackboard.v1') || !policy.enabled || (input.adapter === 'mock' && !mockHarnessOptIn(input.prompt))) return null
  const owner = trust === 'owner'
  const allowed = policy.blackboard && (overrides?.blackboard ?? (owner || policy.allowRequesterBlackboard))
  const board = !policy.blackboard ? 'off' : !allowed ? 'capture' : profile === 'readonly' ? 'read' : 'write'
  const inject = !owner && !allowed ? 'none' : input.resume ? 'resume' : input.handoff ? 'handoff' : 'fresh'
  const verify = caps.includes('verify.v1') && policy.verify && profile !== 'readonly' && (overrides?.verify ?? (owner || policy.allowRequesterVerify))
  if (board === 'off' && inject === 'none' && !verify) return null
  return { v: 1, board, inject, trust, bootstrap: board === 'write' && owner && (inject === 'handoff' || inject === 'fresh'),
    ...(verify && { verify: { autoFixMaxRetries: owner ? policy.autoFixMaxRetries : 0 } }) }
}
export interface AutoAcceptInput {
  trust: 'owner' | 'requester'; profile: Profile; runStatus: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  verificationRequested: boolean; verification?: VerificationSummary
  allowRequesterAutoAccept?: boolean
  failedAttempt?: boolean
  predecessorAccepted: boolean            // workspace_seq = 1，或 last_accepted_seq = workspace_seq − 1
}
export function autoAcceptDecision(input: AutoAcceptInput): { accept: boolean; reason: string } {
  const { verification: result } = input
  if (input.trust === 'requester' && !input.allowRequesterAutoAccept) return { accept: false, reason: 'REQUESTER' }
  if (input.profile === 'readonly') return { accept: false, reason: 'READONLY' }
  if (input.runStatus !== 'succeeded') return { accept: false, reason: 'CLI_NOT_SUCCEEDED' }
  if ((input.failedAttempt || result?.autoFix?.attempts) && result?.status !== 'passed') {
    return { accept: false, reason: 'FAILED_ATTEMPT' }
  }
  if (!input.verificationRequested) return { accept: true, reason: 'NOT_REQUESTED' }
  if (result?.status === 'passed') return { accept: true, reason: 'PASSED' }
  const accept = result?.status === 'skipped' && (result.reason === 'NO_COMMANDS' || (result.reason === 'NO_CHANGES' && input.predecessorAccepted))
  return { accept, reason: result?.reason ?? result?.status.toUpperCase() ?? 'MISSING' }
}
