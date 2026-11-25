/**
 * Pi 独立验收 · Phase 6 · DB-10（容量护栏）
 *
 * 覆盖 07 §6 的三档行为与恢复路径：
 *  - 80% → warning：面板告警（hub/status.storageLevel）+ 保留天数减半（30→15、90→45 天）。
 *  - 95% → critical：新 `log` 文本不再入库，改为单条 `kind='gap'`（reason=hub_cap）O(1) 占位并推进
 *    `to_seq`/`log_dropped_bytes`/`last_seq`（INV-7 区间连续）；非 log 事件（agent/session/progress/finished）照常持久化。
 *  - 回落到阈值下 → ok：正文写入自动恢复、保留期恢复 30/90 天，`assertInvariants` 全通过。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { createTestHub } from '../src/app.js'
import { assertInvariants, assertRunLogContinuity } from './pi/harness.js'
import { safeOn } from '../src/kernel/safe.js'
import { seedRun } from './pi/phase6.js'
import { recordMetrics } from './pi/phase6.js'

const epoch = Date.UTC(2026, 0, 15, 0)
type FiberLike = { config: Record<string, unknown>; update(next: Record<string, unknown>): Promise<unknown> }

it('DB-10 容量护栏：80% warning 保留减半 / 95% critical 拒绝正文并 O(1) gap / 回落自动恢复且 INV 全通过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-db10-'))
  const clock = new FakeClock(epoch)
  const hub = await createTestHub({ storage: { path: join(dir, 'hub.sqlite'), ingest: { batchMs: 10 } },
    retention: { sliceIntervalMs: 50, sliceRows: 5000 } }, { listen: false, clock })
  const store = hub.ctx.store
  const db = store.repos
  const purgeState = (id: string) => db.runs.get(id + '-run')!.logsPurgedAt
  try {
    store.tx(repo => {
      seedRun(repo, { id: 'pi-succ20', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 20, now: epoch, logs: 3 })
      seedRun(repo, { id: 'pi-succ16', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 16, now: epoch, logs: 3 })
      seedRun(repo, { id: 'pi-succ14', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 14, now: epoch, logs: 3 })
      seedRun(repo, { id: 'pi-fail50', taskStatus: 'failed', runStatus: 'failed', ageDays: 50, now: epoch, logs: 3 })
      seedRun(repo, { id: 'pi-fail40', taskStatus: 'failed', runStatus: 'failed', ageDays: 40, now: epoch, logs: 3 })
      seedRun(repo, { id: 'pi-live', taskStatus: 'running', runStatus: 'running', ageDays: 1, now: epoch })
    })
    const levels: string[] = []
    safeOn(hub.ctx, 'hub/status', value => { if (value.storageLevel) levels.push(value.storageLevel) })
    const fiber = hub.fibers.get('retention') as unknown as FiberLike
    const setCap = async (maxDbBytes: number) => fiber.update({ ...fiber.config, maxDbBytes, sliceIntervalMs: 50 })

    // ① ok（默认 10 GiB）：全部保留，完整保留期 30/90 天生效。
    expect(store.retention.storageLevel).toBe('ok')
    clock.advance(50)
    for (const id of ['pi-succ20', 'pi-succ16', 'pi-succ14', 'pi-fail50', 'pi-fail40']) expect(purgeState(id)).toBeNull()

    // ② 80% → warning + 保留减半（succeeded 30→15 天，other 90→45 天）。
    const size = store.health().dbSizeBytes
    expect(size).toBeGreaterThan(0)
    await setCap(Math.floor(size / 0.82))
    expect(store.retention.storageLevel).toBe('warning')
    expect(levels).toContain('warning')
    expect(hub.ctx.orchestrator.overview().hub.storageLevel).toBe('warning')
    const tickTimes: number[] = []
    for (let tick = 0; tick < 4; tick++) { clock.advance(50); tickTimes.push(clock.now()) }
    // 每片处理一个 Run（按 finished_at 最早优先：fail50 → succ20 → succ16）。
    for (const id of ['pi-succ20', 'pi-succ16', 'pi-fail50']) expect(tickTimes).toContain(purgeState(id))
    expect(purgeState('pi-succ14')).toBeNull() // 14 天 < 15 天 → 保留
    expect(purgeState('pi-fail40')).toBeNull() // 40 天 < 45 天 → 保留
    expect(db.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-succ14-run'").pluck().get()).toBe(3)

    // ③ 95% → critical：正文拒绝入库，O(1) gap 占位，非 log 事件照常。
    await setCap(Math.floor(size / 0.96))
    expect(store.retention.storageLevel).toBe('critical')
    expect(levels).toContain('critical')
    const log = (seq: number, text = 'payload-' + seq) => ({ kind: 'log' as const, seq, ts: clock.now(), stream: 'stdout' as const, text })
    // FakeClock 下批次定时器不会自行触发：显式 flush 后再 await 事务提交。
    const write = async (events: Parameters<typeof store.ingest.enqueue>[1]) => {
      const job = store.ingest.enqueue('pi-live-run', events)
      await store.ingest.flush()
      return job
    }
    const started = { kind: 'started' as const, seq: 1, ts: clock.now(), pid: 4242, adapter: 'mock',
      effectiveProfile: 'readonly' as const, commandSummary: 'mock' }
    await write([started])
    const batch = Array.from({ length: 500 }, (_, index) => log(index + 2))
    const dropped = batch.reduce((total, event) => total + Buffer.byteLength(event.text), 0)
    await write(batch)
    let rows = db.prepare("SELECT seq,kind,text,data_json AS dataJson,bytes FROM task_logs WHERE run_id='pi-live-run' ORDER BY seq").all() as
      Array<{ seq: number; kind: string; text: string | null; dataJson: string | null; bytes: number }>
    expect(rows.map(row => [row.seq, row.kind])).toEqual([[1, 'started'], [2, 'gap']])
    expect(rows[1]!.text).toBeNull()
    expect(JSON.parse(rows[1]!.dataJson!)).toMatchObject({ reason: 'hub_cap', toSeq: 501, droppedBytes: dropped })
    const run = db.runs.get('pi-live-run')!
    expect(run.lastSeq).toBe(501)
    expect(run.logDroppedBytes).toBe(dropped)
    // 被拒正文不计入每 Run 日志字节：logBytes 仅含非 log/gap 的结构化事件字节。
    expect(run.logBytes).toBe(db.prepare("SELECT coalesce(sum(bytes),0) FROM task_logs WHERE run_id='pi-live-run' AND kind NOT IN ('log','gap')").pluck().get())
    expect(run.logBytes).toBeLessThan(500)
    assertRunLogContinuity(db, 'pi-live-run')

    // 后续被拒绝的 log 事件只原地推进同一 gap 行（O(1) 行数），不新增行。
    const more = Array.from({ length: 100 }, (_, index) => log(index + 502))
    await write(more)
    rows = db.prepare("SELECT seq,kind,data_json AS dataJson FROM task_logs WHERE run_id='pi-live-run' ORDER BY seq").all() as
      Array<{ seq: number; kind: string; dataJson: string | null }>
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[1]!.dataJson!)).toMatchObject({ reason: 'hub_cap', toSeq: 601 })
    expect(db.runs.get('pi-live-run')!.lastSeq).toBe(601)

    // 非 log 事件在 critical 下照常持久化（agent / session / progress / finished）。
    await write([
      { kind: 'agent', seq: 602, ts: clock.now(), event: { type: 'message', role: 'assistant', text: 'still stored', final: true } },
      { kind: 'session', seq: 603, ts: clock.now(), cliSessionId: 'pi-session' },
      { kind: 'progress', seq: 604, ts: clock.now(), phase: 'apply', detail: 'ok' },
      { kind: 'finished', seq: 605, ts: clock.now(), status: 'succeeded', exitCode: 0, signal: null, durationMs: 1, summary: 'done' },
    ])
    rows = db.prepare("SELECT seq,kind,text FROM task_logs WHERE run_id='pi-live-run' ORDER BY seq").all() as
      Array<{ seq: number; kind: string; text: string | null }>
    expect(rows.map(row => row.kind)).toEqual(['started', 'gap', 'agent', 'session', 'progress', 'finished'])
    expect(db.runs.get('pi-live-run')!.lastSeq).toBe(605)
    assertRunLogContinuity(db, 'pi-live-run')

    // ④ 回落到 95% 以下 → ok：正文写入自动恢复 + 保留期恢复。
    await setCap(size * 2)
    expect(store.retention.storageLevel).toBe('ok')
    expect(levels.at(-1)).toBe('ok')
    await write([log(606, 'recovered-text')])
    const recovered = db.prepare("SELECT kind,text FROM task_logs WHERE run_id='pi-live-run' AND seq=606").get() as
      { kind: string; text: string | null } | undefined
    expect(recovered).toEqual({ kind: 'log', text: 'recovered-text' })
    expect(db.runs.get('pi-live-run')!.lastSeq).toBe(606)
    assertRunLogContinuity(db, 'pi-live-run')

    // 恢复完整保留期：25 天的 succeeded Run 在 ok 档（30 天）应保留。
    store.tx(repo => seedRun(repo, { id: 'pi-succ25', taskStatus: 'succeeded', runStatus: 'succeeded', ageDays: 25, now: clock.now(), logs: 3 }))
    for (let tick = 0; tick < 3; tick++) clock.advance(50)
    expect(purgeState('pi-succ25')).toBeNull()
    expect(db.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-succ25-run'").pluck().get()).toBe(3)

    // 指标面：system/metrics 与 overview 与内部状态一致。
    const token = hub.ctx.auth.createApiToken('pi-db10', ['admin'])
    const metrics = (await hub.ctx.http.app.inject({ url: '/api/v1/system/metrics', headers: { authorization: 'Bearer ' + token } })).json()
    expect(metrics).toMatchObject({ storageLevel: 'ok', lastBackupAt: null })
    expect(metrics.retentionDeletedRowsTotal).toBe(9)

    assertRunLogContinuity(db, 'pi-live-run')
    assertInvariants(db)
    recordMetrics('DB-10', { levels,
      warningPurgedAges: ['pi-succ20', 'pi-succ16', 'pi-fail50'],
      warningKeptAges: ['pi-succ14', 'pi-fail40'],
      gapRowsFor500RejectedLogs: db.prepare("SELECT count(*) FROM task_logs WHERE run_id='pi-live-run' AND kind='gap'").pluck().get(),
      persistedKinds: db.prepare("SELECT group_concat(kind) FROM (SELECT kind FROM task_logs WHERE run_id='pi-live-run' ORDER BY seq)").pluck().get(),
      metricsRetentionDeleted: (metrics as { retentionDeletedRowsTotal: number }).retentionDeletedRowsTotal })
  } finally {
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
