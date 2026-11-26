import { z } from 'zod'
import { AdapterId, BriefingId, Profile, WorkerId, WorkspaceId } from '../common.js'

export const BriefingHealth = z.enum(['healthy', 'attention', 'warning'])
export type BriefingHealth = z.infer<typeof BriefingHealth>

export const BriefingFinding = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']),
  category: z.enum(['board_stale', 'board_budget', 'board_unsafe', 'tech_debt', 'verification', 'open_questions', 'task_health']),
  message: z.string().max(500),
})
export type BriefingFinding = z.infer<typeof BriefingFinding>

export const BriefingAction = z.strictObject({
  index: z.number().int().min(1).max(10),
  title: z.string().max(120),
  prompt: z.string().max(4000),
  adapter: AdapterId.optional(),
  profile: Profile,
})
export type BriefingAction = z.infer<typeof BriefingAction>

export const ProjectBriefingView = z.strictObject({
  id: BriefingId,
  workerId: WorkerId,
  workspaceId: WorkspaceId,
  subdir: z.string(),
  kind: z.enum(['morning', 'manual', 'patrol']),
  health: BriefingHealth,
  summary: z.string(),
  findings: z.array(BriefingFinding),
  actions: z.array(BriefingAction),
  createdAt: z.number().int(),
})
export type ProjectBriefingView = z.infer<typeof ProjectBriefingView>

export const RunBriefingRequest = z.strictObject({
  workerId: WorkerId.optional(),
  workspaceId: WorkspaceId.optional(),
  subdir: z.string().max(256).optional(),
  notifyFeishu: z.boolean().optional(),
})
export type RunBriefingRequest = z.infer<typeof RunBriefingRequest>
