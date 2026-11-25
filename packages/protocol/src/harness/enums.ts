import { z } from 'zod'
export const BoardMode = z.enum(['off', 'capture', 'read', 'write'])
export const InjectMode = z.enum(['none', 'resume', 'fresh', 'handoff'])
export const HarnessTrust = z.enum(['owner', 'requester'])
export const BoardFileName = z.enum(['HANDOFF.md', 'PROJECT_STATE.md', 'DECISIONS.md', 'LESSONS.md'])
export const BoardFileStatus = z.enum(['present', 'absent', 'unsafe', 'oversize', 'invalid'])
export const BoardUnsafeReason = z.enum(['LINK', 'NOT_DIR', 'NOT_FILE', 'HARDLINK', 'ESCAPES_ROOT', 'RACE', 'BINARY', 'IO_ERROR'])
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)
export const VerifyCommandId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
export const VerificationOutcome = z.enum(['passed', 'failed', 'skipped', 'unverified'])               // 线上/终态
export const VerificationState = z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'unverified']) // DB/DTO
export const SKIPPED_REASONS = ['NO_CHANGES', 'NO_COMMANDS', 'TAMPER_RISK', 'CLI_NOT_SUCCEEDED', 'CONFIG_EXPOSED'] as const
export const UNVERIFIED_REASONS = ['WORKER_RESTARTED', 'WORKER_SHUTDOWN', 'CANCELLED', 'BUDGET_EXHAUSTED',
  'MANIFEST_INCOMPLETE', 'COMMAND_UNAVAILABLE', 'RUN_LOST', 'INTERNAL'] as const
export const VerificationReason = z.enum([...SKIPPED_REASONS, ...UNVERIFIED_REASONS])
export const AutoFixStop = z.enum(['PASSED', 'MAX_RETRIES', 'BUDGET', 'TAMPER_RISK', 'MANIFEST_INCOMPLETE', 'ABORTED'])
export const DowngradeReason = z.enum(['LOCAL_DISABLED', 'PROFILE_CLAMPED', 'BOARD_UNSAFE', 'NO_COMMANDS', 'CONFIG_EXPOSED',
  'PROMPT_TOO_LARGE', 'NONCE_COLLISION'])

export type BoardMode = z.infer<typeof BoardMode>
export type InjectMode = z.infer<typeof InjectMode>
export type HarnessTrust = z.infer<typeof HarnessTrust>
export type BoardFileName = z.infer<typeof BoardFileName>
export type BoardFileStatus = z.infer<typeof BoardFileStatus>
export type BoardUnsafeReason = z.infer<typeof BoardUnsafeReason>
export type Sha256Hex = z.infer<typeof Sha256Hex>
export type VerifyCommandId = z.infer<typeof VerifyCommandId>
export type VerificationOutcome = z.infer<typeof VerificationOutcome>
export type VerificationState = z.infer<typeof VerificationState>
export type VerificationReason = z.infer<typeof VerificationReason>
export type AutoFixStop = z.infer<typeof AutoFixStop>
export type DowngradeReason = z.infer<typeof DowngradeReason>
