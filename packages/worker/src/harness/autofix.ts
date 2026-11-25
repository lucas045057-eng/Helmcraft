import type { ManifestDiffSummary, RunEvent, VerificationSummary, VerifyCommandResult, WorkerFacts } from '@agent-hub/protocol'

export type CliOutcome = Omit<Extract<RunEvent, { kind: 'finished' }>, 'seq' | 'ts' | 'verification'>
export function aggregateRound(previous: CliOutcome | undefined, current: CliOutcome): CliOutcome {
  if (!previous) return current
  const usage = { ...previous.usage }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd'] as const) {
    if (current.usage?.[key] !== undefined) usage[key] = (usage[key] ?? 0) + current.usage[key]
  }
  return { ...(current.status === 'succeeded' ? current : previous),
    ...((previous.usage || current.usage) && { usage }),
    ...((previous.filesChanged || current.filesChanged) && { filesChanged: [...new Set([...(previous.filesChanged ?? []), ...(current.filesChanged ?? [])])].slice(0, 200) }) }
}
export function nextRepair(summary: VerificationSummary, results: VerifyCommandResult[], changes: ManifestDiffSummary,
  round: number, maxRetries: number, remaining: number, timeoutMs: number): WorkerFacts['autofix'] {
  if (summary.status !== 'failed' || !maxRetries) return
  if (round >= maxRetries || remaining < Math.max(120000, timeoutMs * 0.2)) {
    summary.autoFix = { attempts: round, stoppedBy: round >= maxRetries ? 'MAX_RETRIES' : 'BUDGET' }
    return
  }
  return { attempt: round + 1, maxRetries, changes: { total: changes.total, paths: changes.sample.slice(0, 30).map(p => p.path) },
    verification: { status: summary.status, attempts: summary.attempts, passed: results.filter(r => r.status === 'passed').map(r => r.id),
      failed: results.flatMap(r => r.status === 'failed' || r.status === 'unavailable' || r.status === 'timed_out'
        ? [{ id: r.id, status: r.status, exitCode: r.exitCode, tail: (r.tail ?? '').slice(-1500) }] : []).slice(0, 4) } }
}
