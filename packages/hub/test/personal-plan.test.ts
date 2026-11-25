import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { recordPlanResult } from '../src/plugins/orchestrator/personal-plan.js'
import { login, openHarness, ORIGIN, rest, settings, useAdminToken } from './pi/rest.js'

const binding = { workerId: 'plan-worker', workspaceId: 'sandbox', root: '/work/project', branch: 'main',
  remote: 'origin', ref: 'refs/heads/main', destination: '1'.repeat(64), executables: { main: '/bin/main', reviewer: '/bin/review', advisor: '/bin/advice' } }
const payload = { binding, projectId: 'example', sources: ['README.md'] }

it.each([true, false])('correlates and persists one ordered plan, verified receipt=%s', async valid => {
  useAdminToken()
  const { hub, cleanup } = await openHarness(settings, { listen: false })
  try {
    const call = rest(hub), db = hub.ctx.store.repos
    const { cookie, csrfToken } = await login(call)
    const post = (body: typeof payload) => call('POST', '/api/v1/personal/plans', { cookie, csrf: csrfToken, origin: ORIGIN, payload: body })
    expect((await call('POST', '/api/v1/personal/plans', { payload })).status).toBe(401)
    const first = await post(payload)
    expect(first.status, first.body).toBe(201)
    const { id } = first.json<{id: string}>()
    expect((await post(payload)).json()).toMatchObject({ id })
    expect((await post({ ...payload, sources: ['SPEC.md'] })).status).toBe(409)
    expect((await post({ ...payload, projectId: 'other' })).status).toBe(409)
    const item = { title: 'deliver', requirements: ['README.md:L1'], acceptanceRefs: ['README.md:L2'], checks: ['core'] }
    const summary = JSON.stringify({ items: ['B', 'A'].map(key => ({ ...item, id: key })), head: '1'.repeat(40),
      sourceDigest: '2'.repeat(64), tasksDigest: '3'.repeat(64), checksDigest: '4'.repeat(64) })
    const digest = createHash('sha256').update(summary).digest('hex')
    const event = { seq: 1, ts: 200, kind: 'finished' as const, status: 'succeeded' as const, durationMs: 100,
      exitCode: 0, signal: null, summary, personalResultDigest: valid ? digest : '0'.repeat(64) }
    for (let i = 0; i < 2; i++) hub.ctx.store.tx(tx => recordPlanResult(tx, id, 'run-1', event, 300))
    expect(db.prepare('SELECT phase,active_ms,plan_run_id FROM personal_projects').get()).toEqual({
      phase: valid ? 'plan_ready' : 'blocked', active_ms: 100, plan_run_id: 'run-1' })
    expect(db.prepare('SELECT item_id FROM personal_items ORDER BY ordinal').all()).toEqual(valid ? [{ item_id: 'B' }, { item_id: 'A' }] : [])
  } finally { await cleanup() }
})
