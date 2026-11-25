import { z } from 'zod'
import { VerifyCommandId } from '../harness/enums.js'

const documentName = z.string().max(128).regex(/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*\.md$/iu)
  .refine(name => name.toLowerCase() !== 'tasks.md')
export const PlanSources = z.array(documentName).min(1).max(8).refine(files => new Set(files).size === files.length)
const refs = z.array(z.string().min(1).max(150)).min(1).max(16)
export const PersonalPlanItem = z.strictObject({
  id: z.string().regex(/^[A-Z][A-Z0-9_-]{0,31}$/u),
  title: z.string().trim().min(1).max(300).regex(/^[^\r\n\p{Cc}]+$/u),
  requirements: refs, acceptanceRefs: refs, checks: z.array(VerifyCommandId).min(1).max(16),
})
const items = z.array(PersonalPlanItem).min(1).max(64).refine(rows => new Set(rows.map(row => row.id)).size === rows.length)
export const PersonalPlan = z.strictObject({ items })
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
export const PersonalPlanReceipt = PersonalPlan.extend({
  head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  sourceDigest: digest, tasksDigest: digest, checksDigest: digest,
})
export type PersonalPlanReceipt = z.infer<typeof PersonalPlanReceipt>
