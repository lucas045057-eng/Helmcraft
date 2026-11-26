import { z } from 'zod'
import { WorkerId, WorkspaceId } from '../common.js'
import { PersonalBinding } from '../worker/commands.js'
import { PlanSources } from '../worker/personal-plan.js'

export const PersonalItemSummary = z.strictObject({
  id: z.string(),
  title: z.string().optional(),
  status: z.string(),
  reviewRounds: z.number().int().nonnegative(),
  commitSha: z.string().nullable(),
})
export type PersonalItemSummary = z.infer<typeof PersonalItemSummary>

export const PersonalProjectView = z.object({
  id: z.string(), phase: z.string(), control: z.string(), reason: z.string().nullable(), currentItem: z.string().nullable(),
  taskId: z.string(), runId: z.string().nullable(), lastCommit: z.string().nullable(), branch: z.string(), activeMs: z.number(),
  workerId: WorkerId.optional(),
  workspaceId: z.string().optional(),
  subdir: z.string().nullable().optional(),
  mode: z.enum(['strict', 'flexible']).optional(),
  autoCommit: z.boolean().optional(),
  autoPush: z.boolean().optional(),
  items: z.array(PersonalItemSummary).optional(),
})
export type PersonalProjectView = z.infer<typeof PersonalProjectView>

export const PersonalReports = z.strictObject({
  'ACCEPTANCE.md': z.string(), 'ADVISOR_FINAL.md': z.string(), 'UNRESOLVED.md': z.string(),
})
export type PersonalReports = z.infer<typeof PersonalReports>

export const AutopilotPreflightRequest = z.strictObject({
  workerId: WorkerId.optional(),
  workspaceId: WorkspaceId,
  subdir: z.string().max(256).optional(),
  mode: z.enum(['strict', 'flexible']).default('flexible'),
  autoCommit: z.boolean().optional(),
  autoPush: z.boolean().optional(),
})
export type AutopilotPreflightRequest = z.infer<typeof AutopilotPreflightRequest>

export const AutopilotPreflightResponse = z.strictObject({
  ok: z.boolean(),
  workerId: WorkerId,
  binding: PersonalBinding.optional(),
  checks: z.array(z.string()).default([]),
  noChecks: z.boolean().optional(),
  error: z.string().optional(),
})
export type AutopilotPreflightResponse = z.infer<typeof AutopilotPreflightResponse>

export const AutopilotStartRequest = z.strictObject({
  projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u).optional(),
  workerId: WorkerId.optional(),
  workspaceId: WorkspaceId,
  subdir: z.string().max(256).optional(),
  inlinePrompt: z.string().trim().min(1).max(16_000).optional(),
  sources: PlanSources.optional(),
  autoCommit: z.boolean().default(true),
  autoPush: z.boolean().default(false),
  notifyFeishuChatId: z.string().max(128).optional(),
  boardSync: z.boolean().default(true),
}).refine(v => Boolean(v.inlinePrompt || v.sources?.length), { message: '需要填写一句话目标或需求文档' })
export type AutopilotStartRequest = z.infer<typeof AutopilotStartRequest>
