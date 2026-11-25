import { z } from 'zod'
import { PersonalItemExecution } from './personal-plan.js'

export const AdvisorTrigger = z.enum(['PLAN_READY','REVIEW_REJECTED_TWICE','DEBUG_NO_ROOT_CAUSE_TWICE','FINAL_READY'])
export type AdvisorTrigger = z.infer<typeof AdvisorTrigger>
export const PersonalGateKind = z.enum(['review','debug',...AdvisorTrigger.options])
export type PersonalGateKind = z.infer<typeof PersonalGateKind>
export const PersonalGate = z.strictObject({ kind: PersonalGateKind, spec: PersonalItemExecution, ordinal: z.number().int().positive() })
const text = z.string().trim().min(1).max(1800)
export const ReviewJudgment = z.strictObject({
  decision: z.enum(['PASS','REJECT']), findings: z.array(z.strictObject({
    kind: z.enum(['requirement','correctness','suggestion']), ref: text, basis: text, impact: text,
  })).max(16),
}).refine(v => (v.decision === 'REJECT') === v.findings.some(f => f.kind !== 'suggestion'), 'Blocking findings must match decision')
export const AdvisorJudgment = z.strictObject({ assessment: z.enum(['ok','concern']), advice: text })
export const DebugJudgment = z.strictObject({ located: z.boolean(), hypothesis: text, experiment: text, observation: text, evidence: z.string().max(1200) })
  .refine(v => !v.located || v.evidence.trim().length > 0, 'Diagnosis needs observed evidence')
export const GateReceipt = z.strictObject({
  taskId: z.string(), runId: z.string(), itemId: z.string(), kind: PersonalGateKind, ordinal: z.number().int().positive(),
  head: PersonalItemExecution.shape.head, tree: PersonalItemExecution.shape.head, inputDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  judgment: z.union([ReviewJudgment, AdvisorJudgment, DebugJudgment]),
})
export type GateReceipt = z.infer<typeof GateReceipt>
export const personalRoleSettings = {
  main: { adapter: 'codex', profile: 'edit', model: 'gpt-6.2-astra' },
  reviewer: { adapter: 'claude-code', profile: 'readonly', model: 'claude-opus-5-5' },
  advisor: { adapter: 'antigravity', profile: 'readonly', model: 'gemini-4-carbon-high' },
} as const
