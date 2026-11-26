import { expect, it } from 'vitest'
import type { TaskSummary } from '@agent-hub/protocol'
import { recentChains } from '../src/Today.js'

const now = Date.UTC(2026, 10, 26, 12)
const hour = 3600_000
const task = (taskNo: number, over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 't' + taskNo, taskNo, version: 1, title: 'task ' + taskNo, status: 'succeeded', priority: 0,
  requester: { type: 'owner', id: 'ou' }, origin: { source: 'feishu' }, adapter: 'codex', workspaceId: 'w', profile: 'edit',
  workerId: 'w1', attempt: 1, maxAttempts: 3, parentTaskId: null, lastProgress: null, scheduleHint: null, workerConnection: null,
  graceUntil: null, errorCode: null, resultDeliveryStatus: 'not_required', createdAt: now - hour, updatedAt: now - hour,
  startedAt: now - hour, finishedAt: now - hour, allowedActions: [], ...over,
}) as TaskSummary

it('shows only the last 24 hours, newest first, capped at five', () => {
  const tasks = [task(1, { finishedAt: now - 30 * hour }), ...[2, 3, 4, 5, 6, 7].map(n => task(n, { finishedAt: now - (10 - n) * hour }))]
  expect(recentChains(tasks, now).map(c => c.latest.taskNo)).toEqual([7, 6, 5, 4, 3])
})

it('merges a follow-up chain into one entry showing the latest round and the round count', () => {
  const tasks = [task(10, { finishedAt: now - 5 * hour }), task(11, { parentTaskId: 't10', finishedAt: now - 3 * hour }),
    task(12, { parentTaskId: 't11', finishedAt: now - hour, status: 'failed' }), task(13, { finishedAt: now - 2 * hour })]
  expect(recentChains(tasks, now).map(c => [c.latest.taskNo, c.rounds])).toEqual([[12, 3], [13, 1]])
})

it('leaves running and waiting tasks out of the completed list', () => {
  const tasks = [task(20, { status: 'running', finishedAt: null }), task(21, { status: 'awaiting_approval', finishedAt: null }), task(22)]
  expect(recentChains(tasks, now).map(c => c.latest.taskNo)).toEqual([22])
})
