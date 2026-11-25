import { describe, expect, it } from 'vitest'
import { FakeClock } from '@agent-hub/common'
import { openStore } from '../src/plugins/store-sqlite/index.js'

describe('Phase 2 store', () => {
  it('migrates the schema and rolls back failed synchronous writes', () => {
    const store = openStore({ path: ':memory:' }, new FakeClock())
    try {
      expect(store.tx(db => db.prepare("SELECT name FROM sqlite_master WHERE name = 'ux_runs_task_seq'").get())).toBeDefined()
      expect(() => store.tx(db => {
        db.prepare("INSERT INTO meta VALUES ('probe', '1')").run()
        throw new Error('rollback')
      })).toThrow('rollback')
      expect(store.tx(db => db.prepare("SELECT value FROM meta WHERE key = 'probe'").get())).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

it('commits a quota gap, preserves independent state events and resolves only after SQLite commits', async () => {
  const clock = new FakeClock(1000)
  const store = openStore({ path: ':memory:', maxBytesPerRun: 3, ingest: { maxQueueRows: 1 } }, clock)
  try {
    store.tx(db => {
      db.prepare("INSERT INTO workers (id,display_name,public_key,key_fingerprint,created_at,updated_at) VALUES ('w','w','p','f',0,0)").run()
      db.tasks.insert({ id: 'task', status: 'dispatching', source: 'dashboard', originJson: { source: 'dashboard' },
        requesterType: 'owner', requesterId: 'owner', title: 'task', prompt: 'prompt', workspaceId: 'sandbox',
        profile: 'readonly', policyDecisionJson: { ruleId: null, decision: 'auto_approve' }, timeoutMs: 60000,
        createdAt: 1000, updatedAt: 1000, currentRunId: 'run' })
      db.prepare("INSERT INTO task_runs(id,task_id,run_seq,attempt,worker_id,adapter,workspace_id,profile,status,not_after,dispatched_at) VALUES ('run','task',1,1,'w','mock','sandbox','readonly','dispatching',2000,1000)").run()
    })
    const first = store.ingest.enqueue('run', [{ seq: 1, ts: 1000, kind: 'log', stream: 'stdout', text: 'abc' }])
    const delayed = store.ingest.enqueue('run', [{ seq: 2, ts: 1000, kind: 'log', stream: 'stdout', text: 'defg' }])
    expect(store.ingest.metrics.ingestWaiters).toBe(1)
    expect(store.repos.runs.get('run')?.lastSeq).toBe(0)
    clock.advance(50)
    await expect(first).resolves.toEqual({ lastSeq: 1 })
    await expect(delayed).resolves.toEqual({ lastSeq: 2 })
    const end = store.ingest.enqueue('run', [
      { seq: 3, ts: 1000, kind: 'log', stream: 'stdout', text: 'hi' },
      { seq: 4, ts: 1000, kind: 'finished', status: 'succeeded', summary: 'done', signal: null, durationMs: 1, exitCode: 0 },
    ], db => {
      expect(db.runs.get('run')?.lastSeq).toBe(4)
      db.prepare("UPDATE task_runs SET status='succeeded' WHERE id='run'").run()
    })
    await expect(end).resolves.toEqual({ lastSeq: 4 })
    expect(store.repos.runs.get('run')).toMatchObject({ status: 'succeeded', logDroppedBytes: 6 })
    const rows = store.repos.prepare('SELECT seq, kind, data_json FROM task_logs ORDER BY seq').all() as { seq: number; kind: string; data_json: string }[]
    expect(rows.map(row => [row.seq, row.kind])).toEqual([[1, 'log'], [2, 'gap'], [4, 'finished']])
    expect(JSON.parse(rows[1]!.data_json)).toEqual({ toSeq: 3, droppedBytes: 6, reason: 'hub_cap' })
    const rejected = store.ingest.enqueue('run', [
      { seq: 5, ts: 1000, kind: 'session', cliSessionId: 'no' },
    ], () => { throw new Error('state rollback') })
    await expect(rejected).rejects.toThrow('state rollback')
    expect(store.repos.runs.get('run')?.lastSeq).toBe(4)
    expect(store.repos.logs.tail('run')?.kind).toBe('finished')
  } finally { store.close() }
})

