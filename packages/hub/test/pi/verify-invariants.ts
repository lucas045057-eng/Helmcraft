/**
 * Pi 独立验收 · Phase 7b 的 Harness 不变量复核器（INV-9 ~ INV-14）
 *
 * 为什么不直接用 `pi/invariants.ts` 的 `assertHarnessInvariants`：那一版有两处误判
 * （见 `docs/handoff/pi-phase7b-acceptance-report.md` 的 P2-1 / P2-2）——
 *  1. INV-10 重算 `autoAcceptDecision` 时没有把 `verification_json.outcome` 传进去，
 *     于是任何「请求了验证且被自动采纳」的 7b Run 都会被误报 `MISSING`；
 *  2. INV-11 把 `RUN_LOST` 造成的 `task=failed` + `verification=unverified` 误判为违规。
 *
 * 这里保持同样的「只读 DB、只写原生 SQL」原则，但用规格原文（08 §13）重新实现：
 *  - INV-9 / INV-10 与 7a 一致，只是 outcome 从 `verification_json` 读取；
 *  - INV-11 只对「真的收到了 finished」的 Run 断言任务状态（RUN_LOST 不是验证结论造成的迁移）；
 *  - INV-12 复用 boardContentPaths；
 *  - INV-13 / INV-14 按 08 §13 原文。
 */
import { autoAcceptDecision } from '@agent-hub/protocol'
import type { Profile, RunStatus, VerificationSummary } from '@agent-hub/protocol'
import type { Repos } from '../../src/services/store.js'
import { boardContentPaths } from './invariants.js'

const WRITE = new Set(['edit', 'full'])
const ACTIVE = new Set(['dispatching', 'running', 'awaiting_input', 'cancelling'])
interface Row {
  id: string; task_id: string; worker_id: string; workspace_id: string; profile: string; status: string
  workspace_seq: number | null; verification_status: string | null; verification_json: string | null
  harness_json: string | null; acked_at: number | null; started_at: number | null
}
interface Pointer {
  worker_id: string; workspace_id: string; attempt_counter: number
  last_attempt_run_id: string | null; last_attempt_seq: number | null
  last_accepted_run_id: string | null; last_accepted_seq: number | null; accepted_by: string | null
}

export function assertVerificationInvariants(db: Repos): string[] {
  const rows = <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[]
  const fail = (id: string, message: string): never => { throw new Error(id + ': ' + message) }
  const runs = rows<Row>('SELECT id, task_id, worker_id, workspace_id, profile, status, workspace_seq, '
    + 'verification_status, verification_json, harness_json, acked_at, started_at FROM task_runs')
  const pointers = rows<Pointer>('SELECT worker_id, workspace_id, attempt_counter, last_attempt_run_id, '
    + 'last_attempt_seq, last_accepted_run_id, last_accepted_seq, accepted_by FROM workspace_pointers')
  const byId = new Map(runs.map(run => [run.id, run]))
  const taskOf = (id: string) => db.prepare('SELECT requester_type, status FROM tasks WHERE id = ?').get(id) as
    { requester_type: string; status: string } | undefined
  const hasFinished = (id: string) => !!db.prepare("SELECT 1 AS x FROM task_logs WHERE run_id = ? AND kind = 'finished'").get(id)
  const accepted = (row: Row) => row.status !== 'dispatching' && row.status !== 'refused'

  // ── INV-9 ────────────────────────────────────────────────────────────────
  for (const pointer of pointers) {
    const key = pointer.worker_id + '/' + pointer.workspace_id
    const write = runs.filter(run => run.worker_id === pointer.worker_id && run.workspace_id === pointer.workspace_id
      && WRITE.has(run.profile) && run.workspace_seq !== null && accepted(run))
    const seqs = write.map(run => run.workspace_seq!)
    if (new Set(seqs).size !== seqs.length) fail('INV-9', key + ' has duplicate write workspace_seq')
    if (pointer.attempt_counter !== write.length) fail('INV-9', key + ' attempt_counter=' + pointer.attempt_counter + ' vs ' + write.length)
    const maxSeq = seqs.length ? Math.max(...seqs) : null
    if (pointer.last_attempt_seq !== maxSeq) fail('INV-9', key + ' last_attempt_seq=' + pointer.last_attempt_seq + ' vs max ' + maxSeq)
    if (pointer.last_accepted_seq !== null && (pointer.last_attempt_seq === null || pointer.last_accepted_seq > pointer.last_attempt_seq)) {
      fail('INV-9', key + ' last_accepted_seq exceeds last_attempt_seq')
    }
  }

  // ── INV-10（outcome 从 verification_json 读取）────────────────────────────
  for (const pointer of pointers) {
    if (pointer.last_accepted_run_id === null) continue
    const key = pointer.worker_id + '/' + pointer.workspace_id
    const run = byId.get(pointer.last_accepted_run_id)
    if (!run) fail('INV-10', key + ' last_accepted_run_id points to an unknown run')
    if (!WRITE.has(run!.profile)) fail('INV-10', key + ' accepted run is not a write run')
    if (run!.status !== 'succeeded') fail('INV-10', key + ' accepted run is ' + run!.status)
    if (pointer.last_accepted_seq !== run!.workspace_seq) fail('INV-10', key + ' last_accepted_seq does not match')
    if (pointer.accepted_by !== 'auto') continue
    const record = run!.harness_json ? JSON.parse(run!.harness_json) as { directive?: { verify?: unknown } | null } : null
    const verification = run!.verification_json ? JSON.parse(run!.verification_json) as
      { outcome?: VerificationSummary } : null
    const sibling = runs.some(other => other.id !== run!.id && other.worker_id === run!.worker_id
      && other.workspace_id === run!.workspace_id && WRITE.has(other.profile) && other.workspace_seq === run!.workspace_seq! - 1)
    const decision = autoAcceptDecision({ trust: (taskOf(run!.task_id)?.requester_type ?? 'owner') as 'owner' | 'requester',
      profile: run!.profile as Profile, runStatus: run!.status as RunStatus,
      verificationRequested: !!record?.directive?.verify || !!verification?.outcome,
      ...(verification?.outcome && { verification: verification.outcome }),
      predecessorAccepted: run!.workspace_seq === 1 || sibling })
    if (!decision.accept) fail('INV-10', key + ' auto-accepted run ' + run!.id + ' but decision says ' + decision.reason)
  }

  // ── INV-11（只约束真的收到了 finished 的 Run）────────────────────────────
  for (const run of runs) {
    if (run.verification_status !== 'failed' && run.verification_status !== 'unverified') continue
    if (!hasFinished(run.id)) continue   // RUN_LOST：任务状态由 lost 路径决定，与验证结论无关
    const task = taskOf(run.task_id)
    if (!task) continue
    if (task.status !== 'succeeded' && task.status !== 'running' && task.status !== 'cancelling') {
      fail('INV-11', 'run ' + run.id + ' verification=' + run.verification_status + ' but task is ' + task.status)
    }
  }

  // ── INV-12 ───────────────────────────────────────────────────────────────
  for (const row of rows<{ id: number; data_json: string | null }>(
    'SELECT id, data_json FROM task_logs WHERE kind IN (?, ?, ?)', 'harness', 'workspace', 'verify')) {
    if (!row.data_json) continue
    const hits = boardContentPaths(JSON.parse(row.data_json))
    if (hits.length) fail('INV-12', 'task_logs#' + row.id + ' leaks board content at ' + hits.join(','))
  }

  // ── INV-13 ───────────────────────────────────────────────────────────────
  for (const run of runs) {
    if (run.verification_status !== 'running') continue
    if (run.status !== 'running' && run.status !== 'cancelling') fail('INV-13', 'verifying run ' + run.id + ' is ' + run.status)
    const others = runs.filter(other => other.id !== run.id && other.worker_id === run.worker_id
      && other.workspace_id === run.workspace_id && WRITE.has(other.profile) && ACTIVE.has(other.status))
    if (others.length) fail('INV-13', 'run ' + run.id + ' verifies while ' + others.length + ' other write run(s) are active')
  }

  // ── INV-14 ───────────────────────────────────────────────────────────────
  for (const run of runs) {
    if (run.verification_status !== 'passed' && run.verification_status !== 'failed') continue
    const parse = (kind: string) => (db.prepare('SELECT data_json FROM task_logs WHERE run_id = ? AND kind = ? ORDER BY seq')
      .all(run.id, kind) as Array<{ data_json: string | null }>).map(row => row.data_json ? JSON.parse(row.data_json) as
      { phase?: string; attempt?: number; round?: number } : null).filter((data): data is { phase?: string; attempt?: number; round?: number } => !!data)
    const lastResult = parse('verify').filter(data => data.phase === 'result').at(-1)
    const lastRound = parse('workspace').at(-1)?.round
    if (lastResult?.attempt === undefined) fail('INV-14', 'run ' + run.id + ' is ' + run.verification_status + ' without a verify result')
    if (lastResult!.attempt !== (lastRound ?? 0) + 1) {
      fail('INV-14', 'run ' + run.id + ' attempt=' + lastResult!.attempt + ' but last round=' + lastRound)
    }
  }
  return ['INV-9', 'INV-10', 'INV-11', 'INV-12', 'INV-13', 'INV-14']
}
