import { z } from 'zod'
import { BoardMode, InjectMode, HarnessTrust, BoardFileName, Sha256Hex, VerifyCommandId, DowngradeReason, VerificationOutcome, VerificationReason, AutoFixStop, SKIPPED_REASONS, UNVERIFIED_REASONS } from '../harness/enums.js'
import { VerifiedFacts } from '../harness/facts.js'
export const HarnessDirectiveCore = z.strictObject({
  v: z.literal(1),
  board: BoardMode,                       // 'off' | 'capture' | 'read' | 'write'
  inject: InjectMode,                     // 'none' | 'resume' | 'fresh' | 'handoff'
  trust: HarnessTrust,                    // 'owner' | 'requester'
  bootstrap: z.boolean(),
  facts: VerifiedFacts.optional(),        // §4.2
  verify: z.strictObject({ autoFixMaxRetries: z.number().int().min(0).max(2) }).optional(),   // verify.v1；存在即请求验证
})
export const HarnessDirective = HarnessDirectiveCore
  .refine(d => !d.bootstrap || (d.board === 'write' && d.trust === 'owner'), { message: 'bootstrap requires board=write and trust=owner' })
  .refine(d => d.inject !== 'handoff' || d.facts?.handoff !== undefined, { message: 'inject=handoff requires facts.handoff' })
  .refine(d => d.inject !== 'none' || d.facts === undefined, { message: 'facts are only sent when injecting' })
export const HarnessApplied = z.strictObject({
  board: BoardMode, inject: InjectMode, trust: HarnessTrust, bootstrap: z.boolean(),
  verify: z.boolean(), autoFixMaxRetries: z.number().int().min(0).max(2),
  downgrades: z.array(z.strictObject({
    field: z.enum(['board', 'inject', 'bootstrap', 'verify', 'autoFixMaxRetries']), reason: DowngradeReason,
  })).max(8),
})
export const PromptDigest = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['resume', 'fresh', 'handoff']),
  bytes: z.number().int().positive(),
  sha256: Sha256Hex,                                       // 对写入 stdin 的完整 UTF-8 字节计算（含 directive 行）
  sections: z.array(z.enum(['directive', 'preamble', 'facts', 'board', 'bootstrap', 'task'])).max(6),
  boardFiles: z.array(BoardFileName).max(4),
})
export const ManifestSummary = z.strictObject({            // verify.v1
  files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), hashed: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(), truncated: z.boolean(), durationMs: z.number().int().nonnegative(),
})
export const ManifestChange = z.enum(['added', 'modified', 'deleted', 'link'])
export const ManifestDiffSummary = z.strictObject({        // verify.v1；总是相对 round 0 之前的 Pre 清单
  added: z.number().int().nonnegative(), modified: z.number().int().nonnegative(), deleted: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  boardOnly: z.boolean(),                                   // 全部变更都位于 .board/ 之下
  sample: z.array(z.strictObject({ path: z.string().max(512), change: ManifestChange })).max(200),
  truncated: z.boolean(),                                   // Pre 或 Post 清单被截断（→ §7.5 MANIFEST_INCOMPLETE）
})
export const TamperInfo = z.strictObject({
  total: z.number().int().positive(), paths: z.array(z.string().max(512)).max(50), links: z.number().int().nonnegative(),
})
export const VerifyCommandResult = z.strictObject({
  id: VerifyCommandId,
  status: z.enum(['passed', 'failed', 'timed_out', 'unavailable', 'not_run']),   // not_run = failFast 后未执行
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  durationMs: z.number().int().nonnegative(),
  tail: z.string().max(4096).optional(),                    // 仅 failed/timed_out/unavailable：已脱敏、去 ANSI 的末尾 ≤ 64 行
})
export const VerificationSummary = z.strictObject({
  status: VerificationOutcome,
  reason: VerificationReason.optional(),
  attempts: z.number().int().min(0).max(3),                 // 实际执行的验证尝试数
  failed: z.array(VerifyCommandId).max(16),                 // 最后一次尝试中失败的命令 id
  autoFix: z.strictObject({ attempts: z.number().int().min(0).max(2), stoppedBy: AutoFixStop }).optional(),
}).refine(s => s.status === 'skipped' ? (SKIPPED_REASONS as readonly string[]).includes(s.reason ?? '')
  : s.status === 'unverified' ? (UNVERIFIED_REASONS as readonly string[]).includes(s.reason ?? '') : s.reason === undefined,
  { message: 'reason must match status category' })

export type HarnessDirectiveCore = z.infer<typeof HarnessDirectiveCore>
export type HarnessDirective = z.infer<typeof HarnessDirective>
export type HarnessApplied = z.infer<typeof HarnessApplied>
export type PromptDigest = z.infer<typeof PromptDigest>
export type ManifestSummary = z.infer<typeof ManifestSummary>
export type ManifestChange = z.infer<typeof ManifestChange>
export type ManifestDiffSummary = z.infer<typeof ManifestDiffSummary>
export type TamperInfo = z.infer<typeof TamperInfo>
export type VerifyCommandResult = z.infer<typeof VerifyCommandResult>
export type VerificationSummary = z.infer<typeof VerificationSummary>
