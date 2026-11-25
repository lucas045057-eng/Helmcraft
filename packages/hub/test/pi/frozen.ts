/**
 * Pi 独立验收 · Phase 6 线上帧字段冻结表（08 §5.1–§5.4、§12.2 C-6）。
 *
 * HP-13 / HP-14 要求「新 Worker 在未协商时发出的每一帧」与「新 Hub 发给未声明能力的 Worker 的每一帧」
 * 都必须仍能被 **Phase 6 的严格 Schema** 解析。这里不引用生产 Schema（否则等于自证），
 * 而是把 Phase 6 的字段名逐条冻结成字面量：任何新增字段（哪怕 `.optional()`）都会让断言失败。
 */

/** Phase 6 `hub.welcome` 的字段集合（`capabilities` 是 Phase 7 增量，不得出现）。 */
export const PHASE6_WELCOME_KEYS = [
  'sessionId', 'connectionEpoch', 'serverTime', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'ackIntervalMs',
  'maxFrameBytes', 'maxInFlightBytes', 'maxLogEntryBytes', 'resume', 'drain', 'redactionPatterns',
] as const

/** Phase 6 `run.dispatch` 的字段集合（`harness` 是 Phase 7 增量）。 */
export const PHASE6_DISPATCH_KEYS = [
  'taskId', 'runId', 'taskNo', 'attempt', 'adapter', 'workspaceId', 'subdir', 'profile', 'prompt', 'resume',
  'model', 'timeoutMs', 'idleTimeoutMs', 'notAfter', 'env', 'extraArgs', 'origin',
] as const

/** Phase 6 `RunEvent` 各 kind 的字段集合（`harness` / `workspace` / `verify` 与 `finished.verification` 是增量）。 */
export const PHASE6_EVENT_KEYS: Record<string, readonly string[]> = {
  started: ['seq', 'ts', 'kind', 'pid', 'adapter', 'cliVersion', 'effectiveProfile', 'clampedFrom', 'commandSummary'],
  log: ['seq', 'ts', 'kind', 'stream', 'text', 'truncatedBytes'],
  agent: ['seq', 'ts', 'kind', 'event'],
  session: ['seq', 'ts', 'kind', 'cliSessionId'],
  progress: ['seq', 'ts', 'kind', 'phase', 'detail'],
  input_request: ['seq', 'ts', 'kind', 'requestId', 'question', 'options'],
  dropped: ['seq', 'ts', 'kind', 'lines', 'bytes', 'reason', 'fromTs', 'toTs'],
  finished: ['seq', 'ts', 'kind', 'status', 'exitCode', 'signal', 'errorCode', 'errorMessage', 'summary', 'cliSessionId',
    'usage', 'durationMs', 'filesChanged'],
}

/** Phase 6 不认识的帧类型：新 kind 只允许在协商后出现。 */
export const PHASE6_FORBIDDEN_KINDS = ['harness', 'workspace', 'verify'] as const

export function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter(key => !allowed.includes(key))
}

function assertWithin(value: unknown, allowed: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' is not an object')
  const extra = unexpectedKeys(value as Record<string, unknown>, allowed)
  if (extra.length) throw new Error(label + ' carries Phase 7 keys that Phase 6 cannot parse: ' + extra.join(','))
}

export function assertPhase6Welcome(payload: unknown) {
  assertWithin(payload, PHASE6_WELCOME_KEYS, 'hub.welcome')
}

export function assertPhase6Dispatch(payload: unknown) {
  assertWithin(payload, PHASE6_DISPATCH_KEYS, 'run.dispatch')
}

export function assertPhase6Event(event: unknown) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('run event is not an object')
  const kind = (event as { kind: string }).kind
  const allowed = PHASE6_EVENT_KEYS[kind]
  if (!allowed) throw new Error('run event kind ' + kind + ' did not exist in Phase 6')
  assertWithin(event, allowed, 'run event ' + kind)
}
