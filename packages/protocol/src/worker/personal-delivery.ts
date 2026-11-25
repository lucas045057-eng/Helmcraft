import { z } from 'zod'
import { PersonalItemExecution, PersonalPlanReceipt } from './personal-plan.js'

const oid = PersonalPlanReceipt.shape.head
export const TestedCandidate = z.strictObject({ head: oid, indexTree: oid, tree: oid })
export type TestedCandidate = z.infer<typeof TestedCandidate>
export const DeliveryStep = z.enum(['commit', 'push', 'verify_final'])
export const PersonalDelivery = z.strictObject({
  kind: DeliveryStep, spec: PersonalItemExecution, candidate: TestedCandidate, commit: oid.optional(),
})
export type PersonalDelivery = z.infer<typeof PersonalDelivery>
export const DeliveryReceipt = z.strictObject({
  kind: DeliveryStep, taskId: z.string(), runId: z.string(), itemId: z.string(),
  parent: oid, tree: oid, commit: oid, remoteSha: oid.optional(),
})
export type DeliveryReceipt = z.infer<typeof DeliveryReceipt>
