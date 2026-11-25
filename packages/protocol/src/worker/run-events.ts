import { BoardSnapshot } from '../harness/board.js'
import { VerifyCommandId } from '../harness/enums.js'
import { HarnessApplied, PromptDigest, ManifestSummary, ManifestDiffSummary, TamperInfo, VerifyCommandResult, VerificationSummary } from './harness.js'
import { z } from 'zod'
import { AdapterId, Profile, RunId, TaskId } from '../common.js'
import { AgentEvent } from '../agent-event.js'
const Base = z.strictObject({ seq: z.number().int().positive(), ts: z.number().int() })

export const LogStream = z.enum(['stdout', 'stderr', 'system'])

export const RunEvent = z.discriminatedUnion('kind', [
  Base.extend({ kind: z.literal('started'),
    pid: z.number().int(), adapter: AdapterId, cliVersion: z.string().optional(),
    effectiveProfile: Profile, clampedFrom: Profile.optional(),
    commandSummary: z.string().max(512) }),           // 已脱敏的命令行摘要（不含 prompt）
  Base.extend({ kind: z.literal('log'),
    stream: LogStream, text: z.string(),              // ≤ maxLogEntryBytes，超长截断并追加 “…[truncated N bytes]”
    truncatedBytes: z.number().int().optional() }),
  Base.extend({ kind: z.literal('agent'), event: AgentEvent }),   // 归一化结构化事件，见 06 §3
  Base.extend({ kind: z.literal('session'), cliSessionId: z.string().max(256) }),
  Base.extend({ kind: z.literal('progress'), phase: z.string().max(64), detail: z.string().max(256).optional() }),
  Base.extend({ kind: z.literal('input_request'),
    requestId: z.string(), question: z.string().max(4000),
    options: z.array(z.string().max(200)).max(10).optional() }),
  Base.extend({ kind: z.literal('dropped'),
    lines: z.number().int(), bytes: z.number().int(),
    reason: z.enum(['backpressure', 'run_cap']), fromTs: z.number().int(), toTs: z.number().int() }),
  Base.extend({ kind: z.literal('harness'),                  // Pre：每个 Run 至多一次
    applied: HarnessApplied,
    prompt: PromptDigest.optional(),                         // 未改写 stdin 时缺省
    board: BoardSnapshot.optional(),                         // applied.board === 'off' 时缺省
    manifest: ManifestSummary.optional() }),                 // verify.v1
  Base.extend({ kind: z.literal('workspace'),                // Post：每个 CLI 轮次一次
    round: z.number().int().min(0).max(2),
    board: BoardSnapshot.optional(),
    readonlyCheck: z.enum(['clean', 'violation', 'inconclusive']).optional(),   // 仅只读 Run
    readonlyPaths: z.array(z.string().max(512)).max(20).optional(),
    changes: ManifestDiffSummary.optional(),                 // verify.v1
    tamper: TamperInfo.optional() }),                        // verify.v1；有 TAMPER_RISK 时出现
  Base.extend({ kind: z.literal('verify'),                   // verify.v1
    attempt: z.number().int().min(1).max(3),
    phase: z.enum(['started', 'result']),
    commands: z.array(VerifyCommandId).max(16),              // 计划执行顺序
    status: z.enum(['passed', 'failed', 'aborted']).optional(),
    results: z.array(VerifyCommandResult).max(16).optional(),
  }).refine(e => e.phase === 'result' ? e.status !== undefined && e.results !== undefined : e.status === undefined && e.results === undefined,
    { message: 'status/results are present iff phase=result' }),
  Base.extend({ kind: z.literal('finished'),
    verification: VerificationSummary.optional(),
    status: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    errorCode: z.enum(['NONZERO_EXIT', 'SPAWN_ERROR', 'ADAPTER_ERROR', 'TIMEOUT', 'IDLE_TIMEOUT',
      'CANCELLED', 'WORKER_SHUTDOWN', 'WORKER_RESTARTED', 'INPUT_TIMEOUT']).optional(),
    errorMessage: z.string().max(2000).optional(),
    summary: z.string().max(20000),                   // 最终回复正文（已脱敏）
    personalResultDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    cliSessionId: z.string().max(256).optional(),
    usage: z.strictObject({
      inputTokens: z.number().int().optional(), outputTokens: z.number().int().optional(),
      cacheReadTokens: z.number().int().optional(), costUsd: z.number().optional(),
    }).optional(),
    durationMs: z.number().int(),
    filesChanged: z.array(z.string().max(512)).max(200).optional() }), // 相对工作区路径
])

export const RunEventsFrame = z.strictObject({
  runId: RunId,
  taskId: TaskId,
  events: z.array(RunEvent).min(1).max(500),          // seq 严格连续递增
}).refine(
  (f) => f.events.every((e, i) => i === 0 || e.seq === f.events[i - 1]!.seq + 1),
  { message: 'events.seq must be strictly consecutive within a frame' },
).refine(
  (f) => f.events.every((event, i) => event.kind !== 'finished' || i === f.events.length - 1),
  { message: 'finished must be the final event' },
)

export const RunGapFrame = z.strictObject({ runId: RunId, fromSeq: z.number().int().positive(), toSeq: z.number().int().positive() })
  .refine(({ fromSeq, toSeq }) => toSeq >= fromSeq, { message: 'toSeq must be at least fromSeq' })
export const RunAckFrame = z.strictObject({ acks: z.array(z.strictObject({ runId: RunId, ackSeq: z.number().int().nonnegative() })).max(64) })
export const RunResendFrame = z.strictObject({ runId: RunId, fromSeq: z.number().int().positive() })

export type LogStream = z.infer<typeof LogStream>
export type RunEvent = z.infer<typeof RunEvent>
export type RunEventsFrame = z.infer<typeof RunEventsFrame>
export type RunGapFrame = z.infer<typeof RunGapFrame>
export type RunAckFrame = z.infer<typeof RunAckFrame>
export type RunResendFrame = z.infer<typeof RunResendFrame>
