import { z } from 'zod'
import { AdapterId, Profile, RunId, WorkspaceId } from '../common.js'
import { RunStatus } from '../task.js'
import { BoardFileName, BoardFileStatus, HarnessTrust, VerificationOutcome, VerificationReason, VerifyCommandId } from './enums.js'

export const FACTS_MAX_BYTES = 24_576
const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

export const FailedCheck = z.strictObject({
  id: VerifyCommandId,
  status: z.enum(['failed', 'timed_out', 'unavailable']),
  exitCode: z.number().int().nullable(),
  tail: z.string().max(1500),                             // 已脱敏、去 ANSI 的末尾输出
})
export const VerificationFact = z.strictObject({
  status: VerificationOutcome,
  reason: VerificationReason.optional(),
  attempts: z.number().int().min(0).max(3),
  passed: z.array(VerifyCommandId).max(16),
  failed: z.array(FailedCheck).max(4),
  tamperPaths: z.array(z.string().max(512)).max(20).optional(),
})
export const FactRunBrief = z.strictObject({
  runId: RunId, taskNo: z.number().int(), adapter: AdapterId, profile: Profile,
  runStatus: RunStatus, trust: HarnessTrust,
  verification: VerificationOutcome.optional(),
  finishedAt: z.number().int().nullable(),
})
export const FactRun = FactRunBrief.extend({
  title: z.string().max(120),                             // 任务标题（已脱敏）
  summary: z.string().max(1500).optional(),               // finished.summary（数据，非指令）
  changes: z.strictObject({
    source: z.enum(['manifest', 'cli']),                  // manifest=7b 清单测量；cli=CLI 自报 filesChanged
    total: z.number().int().nonnegative(),
    paths: z.array(z.string().max(512)).max(30),
  }).optional(),
  board: z.strictObject({
    changed: z.array(BoardFileName).max(4), deleted: z.array(BoardFileName).max(4), overBudget: z.array(BoardFileName).max(4),
  }).optional(),
  verificationDetail: VerificationFact.optional(),
})
export const VerifiedFacts = z.strictObject({
  v: z.literal(1),
  generatedAt: z.number().int(),
  currentRun: z.strictObject({ runId: RunId, taskNo: z.number().int(), adapter: AdapterId, trust: HarnessTrust }),
  workspace: z.strictObject({
    workspaceId: WorkspaceId,
    lastAccepted: FactRunBrief.nullable(),
    lastAttempt: FactRunBrief.nullable(),
    unaccepted: FactRun.optional(),                       // lastAttempt ≠ lastAccepted 且未与 handoff.from / parent 重复时
  }),
  handoff: z.strictObject({
    intent: z.enum(['relay', 'fix']),
    from: FactRun,
  }).optional(),
  parent: FactRun.optional(),                             // resume 模式：被续跑会话所属的上一 Run
  continuity: z.strictObject({                            // 交接（base = handoff.from）与续跑（base = parent）共用
    baseRunId: RunId,
    interleaved: z.array(FactRunBrief).max(10),           // base 之后被受理的其他写入型 Run，按 workspace_seq 升序
    interleavedTotal: z.number().int().nonnegative(),
    interleavedUnknown: z.literal(true).optional(),       // base 无 workspace_seq（Phase 7 之前的 Run）
  }).optional(),
}).refine(facts => utf8Bytes(facts) <= FACTS_MAX_BYTES, { message: 'verified facts exceed FACTS_MAX_BYTES' })
export const WorkerFacts = z.strictObject({
  capturedAt: z.number().int(),
  cwd: z.string().max(512),                               // 相对工作区根的 POSIX 路径；根目录为 '.'
  agentsMd: z.enum(['present', 'absent', 'unsafe']),
  board: z.strictObject({
    dir: z.enum(['present', 'absent', 'unsafe']),
    files: z.array(z.strictObject({
      file: BoardFileName, status: BoardFileStatus, bytes: z.number().int().nonnegative(),
      budget: z.number().int().positive(), overBudget: z.boolean(), schemaOk: z.boolean(),
    })).max(4),
  }),
  autofix: z.strictObject({                               // 仅自动修复轮
    attempt: z.number().int().min(1).max(2), maxRetries: z.number().int().min(1).max(2),
    verification: VerificationFact,                       // 上一次验证尝试的结果
    changes: z.strictObject({ total: z.number().int().nonnegative(), paths: z.array(z.string().max(512)).max(30) }),
  }).optional(),
})

export type FailedCheck = z.infer<typeof FailedCheck>
export type VerificationFact = z.infer<typeof VerificationFact>
export type FactRunBrief = z.infer<typeof FactRunBrief>
export type FactRun = z.infer<typeof FactRun>
export type VerifiedFacts = z.infer<typeof VerifiedFacts>
export type WorkerFacts = z.infer<typeof WorkerFacts>
export function renderFactsJson(hub: VerifiedFacts | null, worker: WorkerFacts): string {
  return JSON.stringify({ hub, worker }, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}
