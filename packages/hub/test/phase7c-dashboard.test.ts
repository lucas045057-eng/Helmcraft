import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import { expect, it } from 'vitest'
import { FakeWorker, openHarness } from './pi/harness.js'
import { ADMIN_TOKEN, useAdminToken } from './pi/rest.js'
import { dispatch, finish, owner, requester } from './pi/phase7.js'

it('F11 accepts a successful write without a harness summary through the drawer', async () => {
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
    const worker = await FakeWorker.connect(hub, { workerId: 'pointer-ui' })
    const task = await hub.ctx.orchestrator.createTask({ adapter: 'mock', profile: 'edit', prompt: 'ordinary', workspaceId: 'sandbox' }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner)
    const run = await dispatch(worker, task.id)
    await finish(hub, worker, run)
    expect(hub.ctx.orchestrator.getTask(task.id)?.runs[0]?.harness).toBeUndefined()
    const page = await browser.newPage()
    await page.goto(origin + '/tasks/' + task.id)
    await page.getByTestId('login-token').fill(ADMIN_TOKEN)
    await page.getByTestId('login-submit').click()
    const button = page.getByTestId('pointer-accept')
    await pw(button).toBeVisible()
    page.once('dialog', dialog => dialog.accept())
    await button.click()
    await pw(button).toHaveCount(0)
    expect(hub.ctx.store.repos.pointers.get('pointer-ui', 'sandbox')?.lastAcceptedRunId).toBe(run.runId)
  } finally { await browser.close(); await cleanup() }
}, 30000)
