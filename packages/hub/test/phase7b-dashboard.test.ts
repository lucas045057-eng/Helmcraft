import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import { expect, it } from 'vitest'
import { FakeWorker, openHarness } from './pi/harness.js'
import { ADMIN_TOKEN, useAdminToken } from './pi/rest.js'
import { dispatch, requester, mockPrompt } from './pi/phase7.js'

it('UX-14 approves verification, follows the live result, and operates both repair controls', async () => {
  useAdminToken()
  const socket = createServer()
  await new Promise<void>(r => socket.listen(0, '127.0.0.1', r))
  const port = (socket.address() as AddressInfo).port
  await new Promise<void>(r => socket.close(() => r()))
  const origin = 'http://127.0.0.1:' + port
  const { hub, cleanup } = await openHarness({ server: { port },
    dashboard: { allowedOrigins: [origin], distDir: fileURLToPath(new URL('../../dashboard/dist/site/', import.meta.url)) } })
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const worker = await FakeWorker.connect(hub, { workerId: 'verify-ui', headers: { 'X-Agent-Hub-Capabilities': 'blackboard.v1,verify.v1' } })
    const task = await hub.ctx.orchestrator.createTask({ adapter: 'mock', profile: 'edit', prompt: mockPrompt, workspaceId: 'sandbox' }, requester)
    const page = await browser.newPage()
    await page.goto(origin + '/tasks/' + task.id)
    await page.getByTestId('login-token').fill(ADMIN_TOKEN)
    await page.getByTestId('login-submit').click()
    await page.getByTestId('action-approve').click()
    await page.locator('select[name=harness]').selectOption('board_verify')
    await page.getByTestId('approve-submit').click()
    const run = await dispatch(worker, task.id)
    expect(run.harness?.verify).toEqual({ autoFixMaxRetries: 0 })
    const started = { kind: 'verify', phase: 'started', attempt: 1, commands: ['typecheck'], ts: Date.now(), seq: 2 }
    worker.events(run.runId, task.id, [{ kind: 'started', seq: 1, ts: Date.now(), pid: 1, effectiveProfile: 'edit', adapter: 'mock', commandSummary: 'mock' }, started])
    const panel = page.getByTestId('verification-panel')
    await pw(panel.getByTestId('verification-badge')).toHaveText('验证中')
    worker.events(run.runId, task.id, [{ ...started, seq: 3, phase: 'result', status: 'failed',
      results: [{ id: 'typecheck', status: 'failed', exitCode: 2, signal: null, durationMs: 50, tail: 'missing export' }] },
    { kind: 'finished', seq: 4, ts: Date.now(), status: 'succeeded', signal: null, exitCode: 0, summary: 'done', durationMs: 100,
      verification: { status: 'failed', attempts: 1, failed: ['typecheck'] } }])
    await pw(panel).toContainText('missing export')
    await pw(page.getByTestId('task-card-' + task.taskNo).getByTestId('verification-badge')).toHaveText('验证失败')
    await page.getByTestId('verification-fix-switch').click()
    await pw(page.getByTestId('handoff-intent')).toHaveValue('fix')
    await page.locator('dialog').getByRole('button', { name: '关闭' }).click()
    const post = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/handoff'))
    await page.getByTestId('verification-fix-same').click()
    const response = await post
    expect(response.status()).toBe(201)
    expect(response.request().headers()['idempotency-key']).toBeTruthy()
    expect(await response.json()).toMatchObject({ adapter: 'mock', handoff: { intent: 'fix', fromRunId: run.runId } })
  } finally { await browser.close(); await cleanup() }
}, 60000)
