import { z } from 'zod'
import { AdapterId, RunId, TaskId, Profile, WorkspaceId, WorkerId } from '../common.js'
import { RunStatus } from '../task.js'
import { BoardChange, BoardSnapshot } from '../harness/board.js'
import { VerifiedFacts } from '../harness/facts.js'
import { BoardMode, InjectMode, HarnessTrust, BoardFileName, VerificationState, VerificationReason, VerifyCommandId } from '../harness/enums.js'
import { HarnessDirectiveCore, HarnessApplied, PromptDigest, ManifestDiffSummary, TamperInfo, VerifyCommandResult, VerificationSummary } from '../worker/harness.js'
export { BoardChange } from '../harness/board.js'
export const RunHarnessSummary = z.strictObject({
  board: BoardMode, inject: InjectMode, trust: HarnessTrust,
  boardChanges: z.array(z.strictObject({ file: BoardFileName, change: BoardChange,
    added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() })).max(4).optional(),
  boardWarnings: z.array(z.enum(['OVER_BUDGET', 'SCHEMA', 'UNSAFE', 'DELETED'])).max(4).optional(),
  verification: z.strictObject({ state: VerificationState, reason: VerificationReason.optional(),
    failed: z.array(VerifyCommandId).max(16), attempts: z.number().int().min(0).max(3),
    autoFixAttempts: z.number().int().min(0).max(2) }).optional(),
  tamper: z.strictObject({ total: z.number().int().positive(), sample: z.array(z.string().max(512)).max(5) }).optional(),
  readonlyCheck: z.enum(['clean', 'violation', 'inconclusive']).optional(),
  workspaceSeq: z.number().int().positive().optional(),
  pointer: z.array(z.enum(['lastAccepted', 'lastAttempt'])).max(2).optional(),
})
export const PointerRef = z.strictObject({
  runId: RunId, taskId: TaskId, taskNo: z.number().int(), adapter: AdapterId, seq: z.number().int().positive(),
  runStatus: RunStatus, verification: VerificationState.nullable(), finishedAt: z.number().int().nullable(),
  acceptedBy: z.string().optional(),                     // 仅 lastAccepted：'auto' 或 Owner id
})
export const WorkspacePointerView = z.strictObject({
  workerId: WorkerId, workspaceId: WorkspaceId, attemptCounter: z.number().int().nonnegative(),
  lastAccepted: PointerRef.nullable(), lastAttempt: PointerRef.nullable(), updatedAt: z.number().int(),
})
export const ProjectOverview = z.strictObject({
  workerId: WorkerId, workspaceId: WorkspaceId, label: z.string(), isGitRepo: z.boolean(),
  workerOnline: z.boolean(), maxProfile: Profile, allowedAdapters: z.array(AdapterId),
  activeTasks: z.number().int().nonnegative(), totalTasks: z.number().int().nonnegative(),
  succeededTasks: z.number().int().nonnegative(), failedTasks: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nullable(), latestTaskId: TaskId.nullable(), latestTaskNo: z.number().int().nullable(),
  latestRunId: RunId.nullable(), latestAdapter: AdapterId.nullable(), latestVerification: VerificationState.nullable(),
  pointer: WorkspacePointerView.nullable(), board: BoardSnapshot.nullable(), boardCapturedAt: z.number().int().nullable(),
})
export type ProjectOverview = z.infer<typeof ProjectOverview>
export const RunHarnessView = z.strictObject({
  runId: RunId,
  directive: HarnessDirectiveCore.omit({ facts: true }).nullable(),   // 不能对带 refine 的 HarnessDirective 调用 .omit()
  facts: VerifiedFacts.nullable(),
  applied: HarnessApplied.nullable(), prompt: PromptDigest.nullable(),
  board: z.strictObject({ pre: BoardSnapshot.nullable(), post: BoardSnapshot.nullable(),
    postRound: z.number().int().min(0).max(2).nullable(), diff: z.array(z.strictObject({ file: BoardFileName,
      change: BoardChange, added: z.number().int(), removed: z.number().int() })).max(4) }),
  changes: ManifestDiffSummary.nullable(), tamper: TamperInfo.nullable(),
  readonlyCheck: z.enum(['clean', 'violation', 'inconclusive']).nullable(),
  verification: z.strictObject({ state: VerificationState,
    attempts: z.array(z.strictObject({ attempt: z.number().int(), commands: z.array(VerifyCommandId),
      status: z.enum(['passed', 'failed', 'aborted']).nullable(), results: z.array(VerifyCommandResult) })).max(3),
    outcome: VerificationSummary.nullable() }).nullable(),
  pointer: WorkspacePointerView.nullable(),
  canAccept: z.boolean(),                                // §8.5.5 的全部校验在当前状态下可通过
})
export const HandoffTaskRequest = z.strictObject({
  intent: z.enum(['relay', 'fix']), fromRunId: RunId.optional(), adapter: AdapterId.optional(),
  model: z.string().max(128).optional(), prompt: z.string().min(1).max(32_000).optional(), profile: Profile.optional(), expectedVersion: z.number().int().optional(),
})
export const HandoffPreviewQuery = z.strictObject({
  intent: z.enum(['relay', 'fix']).optional(), fromRunId: RunId.optional(), adapter: AdapterId.optional(),
})
export const HandoffPreview = z.strictObject({
  fromRunId: RunId, workerId: WorkerId, workspaceId: WorkspaceId, adapter: AdapterId.nullable(), resume: z.boolean(),
  facts: VerifiedFacts, board: BoardSnapshot.nullable(),  // fromRun 最新 post（无则 pre）快照
  promptPreview: z.string(),                              // composeHarnessPrompt(…, nonce = PREVIEW_NONCE)；以 Worker 实际读取为准
  warnings: z.array(z.enum(['WORKER_OFFLINE', 'WORKER_NO_BLACKBOARD', 'INTERLEAVED', 'INTERLEAVED_UNKNOWN',
    'BOARD_UNAVAILABLE', 'ADAPTER_NOT_READY', 'VERIFY_UNSUPPORTED'])).max(8),
})
export const AcceptRunRequest = z.strictObject({ runId: RunId, expectedAcceptedRunId: RunId.nullable() })

export type RunHarnessSummary = z.infer<typeof RunHarnessSummary>
export type PointerRef = z.infer<typeof PointerRef>
export type WorkspacePointerView = z.infer<typeof WorkspacePointerView>
export type RunHarnessView = z.infer<typeof RunHarnessView>
export type HandoffTaskRequest = z.infer<typeof HandoffTaskRequest>
export type HandoffPreviewQuery = z.infer<typeof HandoffPreviewQuery>
export type HandoffPreview = z.infer<typeof HandoffPreview>
export type AcceptRunRequest = z.infer<typeof AcceptRunRequest>
