import { FakeClock, runId, taskId } from '@agent-hub/common'
import { expect, it } from 'vitest'
import { RunOutbox } from '../src/tunnel/outbox.js'
import type { SendRunFrame } from '../src/tunnel/outbox.js'

it('keeps the in-flight window bounded and reports dropped lines without allocating sequence numbers for them', () => {
  const clock = new FakeClock(1000)
  const id = runId(1000)
  const outbox = new RunOutbox(clock, { runBufferBytes: 1800, totalBufferBytes: 1800 }, () => undefined)
  const sent: Parameters<SendRunFrame>[0][] = []
  outbox.register(id, taskId(1000))
  outbox.attach(frame => { sent.push(frame); return true }, 2048, 800)
  for (let i = 0; i < 20; i++) outbox.push(id, { kind: 'log', stream: 'stdout', text: 'x'.repeat(180) })
  outbox.flush()
  expect(sent).toHaveLength(1)
  const events = sent[0]!.type === 'run.events' ? sent[0]!.payload.events : []
  expect(events.map(event => event.seq)).toEqual([1])
  outbox.ack(id, 1)
  outbox.flush()
  outbox.ack(id, 2)
  outbox.flush()
  outbox.ack(id, 3)
  outbox.flush()
  const all = sent.flatMap(frame => frame.type === 'run.events' ? frame.payload.events : [])
  expect(all.map(event => event.seq)).toEqual([1, 2, 3, 4, 5])
  expect(all.at(-1)).toMatchObject({ kind: 'dropped', lines: 16, bytes: 2880 })
})

it('replays an evicted range and the recovered terminal event before removing its journal entry', () => {
  const clock = new FakeClock(1000)
  const id = runId(1000), task = taskId(1000)
  const acked: string[] = []
  const outbox = new RunOutbox(clock, { runBufferBytes: 1024, totalBufferBytes: 1024 }, run => acked.push(run))
  outbox.recover(id, task, { kind: 'finished', seq: 8, ts: 1000, status: 'failed', errorCode: 'WORKER_RESTARTED',
    durationMs: 0, exitCode: null, signal: null, summary: '' })
  const sent: Parameters<SendRunFrame>[0][] = []
  outbox.ack(id, 4)
  outbox.attach(frame => { sent.push(frame); return true }, 2048, 1024)
  outbox.flush()
  expect(sent[0]).toEqual({ type: 'run.gap', payload: { runId: id, fromSeq: 5, toSeq: 7 } })
  expect(sent[1]).toMatchObject({ type: 'run.events', payload: { events: [{ seq: 8, kind: 'finished' }] } })
  expect(acked).toEqual([])
  outbox.ack(id, 8)
  expect(acked).toEqual([id])
})
