/**
 * Pi 独立验收：08 §13 Harness 不变量（INV-9 ~ INV-14）。
 *
 * 设计原则：只读 DB、只使用原始 SQL（不依赖生产代码的查询封装），
 * 以便在实现出现回归时仍然独立成立。INV-15（Worker 零文件系统写入）
 * 属于 Worker 侧 fs 包装器断言，见 packages/worker/test/phase7-pi.test.ts。
 */
import { autoAcceptDecision } from '@agent-hub/protocol'
import type { Profile, RunStatus, VerificationSummary } from '@agent-hub/protocol'
import type { Repos } from '../../src/services/store.js'

export interface HarnessInvariantReport { checked: string[] }

const WRITE = new Set(['edit', 'full'])
/** 「已受理」= Hub 侧发生 dispatching → running 的真实迁移（refused / 未 ack 的派发不算）。 */
const isAccepted = (row: RunRow) => row.status !== 'dispatching' && row.status !== 'refused'

interface RunRow {
  id: string; task_id: string; worker_id: string; workspace_id: string; profile: string; status: string
  workspace_seq: number | null; verification_status: string | null; harness_json: string | null
  acked_at: number | null; started_at: number | null
}
interface PointerRow {
  worker_id: string; workspace_id: string; attempt_counter: number
  last_attempt_run_id: string | null; last_attempt_seq: number | null
  last_accepted_run_id: string | null; last_accepted_seq: number | null; accepted_by: string | null
}

/** 递归查找 Harness 载荷中被禁止出现的黑板正文（INV-12）。 */
export function boardContentPaths(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  const walk = (node: unknown, trail: string) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, trail + '[' + index + ']')); return }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const next = trail + '.' + key
      if (key === 'content' && /\.board\.files\[\d+\]$/u.test(trail)) hits.push(next)
      walk(child, next)
    }
  }
  walk(value, path)
  return hits
}

/** 断言一份线上载荷（run/events、task_logs.data_json、飞书/面板 DTO）不含黑板正文。 */
export function assertNoBoardContent(value: unknown, label: string) {
  const hits = boardContentPaths(value)
  if (hits.length) throw new Error('INV-12: ' + label + ' leaks board content at ' + hits.join(', '))
}

/**
 * 08 §13 INV-9 ~ INV-14。任何违规都以 `INV-<n>: …` 消息抛出。
 */
export function assertHarnessInvariants(db: Repos): HarnessInvariantReport {
  const rows = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[]
  const fail = (id: string, message: string): never => { throw new Error(id + ': ' + message) }

  const runs = rows<RunRow>('SELECT id, task_id, worker_id, workspace_id, profile, status, workspace_seq, '
    + 'verification_status, harness_json, acked_at, started_at FROM task_runs')
  const pointers = rows<PointerRow>('SELECT worker_id, workspace_id, attempt_counter, last_attempt_run_id, '
    + 'last_attempt_seq, last_accepted_run_id, last_accepted_seq, accepted_by FROM workspace_pointers')
  const taskOf = (id: string) => db.prepare('SELECT requester_type FROM tasks WHERE id = ?').get(id) as
    { requester_type: string } | undefined
  const byId = new Map(runs.map(run => [run.id, run]))

  // ── INV-9 ────────────────────────────────────────────────────────────────
  for (const pointer of pointers) {
    const key = pointer.worker_id + '/' + pointer.workspace_id
    const write = runs.filter(run => run.worker_id === pointer.worker_id && run.workspace_id === pointer.workspace_id
      && WRITE.has(run.profile) && run.workspace_seq !== null && isAccepted(run))
    const seqs = write.map(run => run.workspace_seq!)
    if (new Set(seqs).size !== seqs.length) fail('INV-9', key + ' has duplicate write workspace_seq ' + seqs.join(','))
    if (pointer.attempt_counter !== write.length) {
      fail('INV-9', key + ' attempt_counter=' + pointer.attempt_counter + ' but accepted write runs=' + write.length)
    }
    const maxSeq = seqs.length ? Math.max(...seqs) : null
    if (pointer.last_attempt_seq !== maxSeq) {
      fail('INV-9', key + ' last_attempt_seq=' + pointer.last_attempt_seq + ' but max workspace_seq=' + maxSeq)
    }
    if (pointer.last_attempt_run_id !== null && byId.get(pointer.last_attempt_run_id)?.workspace_seq !== maxSeq) {
      fail('INV-9', key + ' last_attempt_run_id does not own the maximum workspace_seq')
    }
    if (pointer.last_attempt_run_id === null && maxSeq !== null) {
      fail('INV-9', key + ' has write runs but no last_attempt_run_id')
    }
    if (pointer.last_accepted_seq !== null
      && (pointer.last_attempt_seq === null || pointer.last_accepted_seq > pointer.last_attempt_seq)) {
      fail('INV-9', key + ' last_accepted_seq=' + pointer.last_accepted_seq + ' > last_attempt_seq=' + pointer.last_attempt_seq)
    }
    // 严格递增：按受理时间排序后 seq 必须递增（同 tick 只要求不重复，已在上方断言）。
    const ordered = [...write].sort((a, b) => (a.acked_at ?? a.started_at ?? 0) - (b.acked_at ?? b.started_at ?? 0)
      || a.workspace_seq! - b.workspace_seq!)
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.workspace_seq! <= ordered[i - 1]!.workspace_seq!) {
        fail('INV-9', key + ' workspace_seq is not monotone across acceptance order')
      }
    }
  }

  // ── INV-10 ───────────────────────────────────────────────────────────────
  for (const pointer of pointers) {
    if (pointer.last_accepted_run_id === null) continue
    const key = pointer.worker_id + '/' + pointer.workspace_id
    const run = byId.get(pointer.last_accepted_run_id)
    if (!run) fail('INV-10', key + ' last_accepted_run_id points to unknown run')
    if (!WRITE.has(run!.profile)) fail('INV-10', key + ' accepted run ' + run!.id + ' is not a write run')
    if (run!.status !== 'succeeded') fail('INV-10', key + ' accepted run ' + run!.id + ' is ' + run!.status)
    if (pointer.last_accepted_seq !== run!.workspace_seq) fail('INV-10', key + ' last_accepted_seq does not match the run')
    if (pointer.accepted_by !== 'auto') continue
    const record = run!.harness_json ? JSON.parse(run!.harness_json) as
      { directive?: { verify?: unknown } | null } : null
    const sibling = runs.some(other => other.worker_id === run!.worker_id && other.workspace_id === run!.workspace_id
      && WRITE.has(other.profile) && other.workspace_seq === run!.workspace_seq! - 1)
    const decision = autoAcceptDecision({ trust: (taskOf(run!.task_id)?.requester_type ?? 'owner') as 'owner' | 'requester',
      profile: run!.profile as Profile, runStatus: run!.status as RunStatus, verificationRequested: !!record?.directive?.verify,
      predecessorAccepted: run!.workspace_seq === 1 || sibling })
    if (!decision.accept) fail('INV-10', key + ' auto-accepted run ' + run!.id + ' but autoAcceptDecision says ' + decision.reason)
  }

  // ── INV-11 ───────────────────────────────────────────────────────────────
  // 任务状态迁移与验证结果无关：验证结论落库后，任务状态只能由 finished.status 决定。
  for (const run of runs) {
    if (run.verification_status !== 'failed' && run.verification_status !== 'unverified') continue
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(run.task_id) as { status: string } | undefined
    if (!task) continue
    if (task.status !== 'succeeded' && task.status !== 'running' && task.status !== 'cancelling') {
      fail('INV-11', 'run ' + run.id + ' verification=' + run.verification_status + ' changed task status to ' + task.status)
    }
  }

  // ── INV-12 ───────────────────────────────────────────────────────────────
  const logs = rows<{ id: number; run_id: string; kind: string; data_json: string | null }>(
    'SELECT id, run_id, kind, data_json FROM task_logs WHERE kind IN (?, ?, ?)', 'harness', 'workspace', 'verify')
  for (const row of logs) {
    if (!row.data_json) continue
    assertNoBoardContent(JSON.parse(row.data_json), 'task_logs#' + row.id + ' (' + row.run_id + '/' + row.kind + ')')
  }

  // ── INV-13 ───────────────────────────────────────────────────────────────
  for (const run of runs) {
    if (run.verification_status === null || run.verification_status === 'pending') continue
    if (run.verification_status === 'running') {
      if (run.status !== 'running' && run.status !== 'cancelling') {
        fail('INV-13', 'run ' + run.id + ' is verifying but hub status is ' + run.status)
      }
      const others = runs.filter(other => other.id !== run.id && other.worker_id === run.worker_id
        && other.workspace_id === run.workspace_id && WRITE.has(other.profile)
        && ['dispatching', 'running', 'awaiting_input', 'cancelling'].includes(other.status))
      if (others.length) fail('INV-13', 'run ' + run.id + ' verifies while ' + others.length + ' other write run(s) are active')
    }
  }

  // ── INV-14 ───────────────────────────────────────────────────────────────
  for (const run of runs) {
    if (run.verification_status !== 'passed' && run.verification_status !== 'failed') continue
    const verifyRows = rows<{ data_json: string | null }>(
      'SELECT data_json FROM task_logs WHERE run_id = ? AND kind = ? ORDER BY seq', run.id, 'verify')
    const attempts = verifyRows.map(row => row.data_json ? JSON.parse(row.data_json) as
      { phase?: string; attempt?: number } : null).filter((data): data is { phase?: string; attempt?: number } => !!data)
    const lastResult = attempts.filter(data => data.phase === 'result').at(-1)
    const workspaceRows = rows<{ data_json: string | null }>(
      'SELECT data_json FROM task_logs WHERE run_id = ? AND kind = ? ORDER BY seq', run.id, 'workspace')
    const lastRound = workspaceRows.map(row => row.data_json ? JSON.parse(row.data_json) as { round?: number } : null)
      .filter((data): data is { round?: number } => !!data).at(-1)?.round
    if (lastResult?.attempt === undefined) fail('INV-14', 'run ' + run.id + ' is ' + run.verification_status + ' without a verify result')
    if (lastResult!.attempt !== (lastRound ?? 0) + 1) {
      fail('INV-14', 'run ' + run.id + ' verify attempt=' + lastResult!.attempt + ' but last workspace round=' + lastRound)
    }
  }

  return { checked: ['INV-9', 'INV-10', 'INV-11', 'INV-12', 'INV-13', 'INV-14'] }
}

/** INV-14 的显式形式（供 7b 使用，7a 中 verification_status 恒为 NULL）。 */
export function verificationMatchesRound(verification: VerificationSummary | undefined, round: number) {
  return verification === undefined || parseInt(String(verification.attempts), 10) === round + 1
}
