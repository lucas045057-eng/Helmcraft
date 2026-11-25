import type { Actor, PolicyRule, Profile, Source } from '@agent-hub/protocol'
export interface PolicyInput {
  actor: Actor
  source: Source
  workspaceId: string
  adapter?: string | undefined
  chatId?: string | undefined
  profile: Profile
  prompt: string
}
export type PolicyOutcome = PolicyRule['effect'] & { ruleId: string | null; clampedProfile?: Profile }
export interface PolicyService {
  evaluate(input: PolicyInput): PolicyOutcome
  listRules(): PolicyRule[]
  revision(): number
  replaceRules(rules: PolicyRule[], actor: Actor, expectedRevision?: number): number
}
