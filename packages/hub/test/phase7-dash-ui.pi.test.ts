import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright'
import { expect as pw } from 'playwright/test'
import { expect, it } from 'vitest'
import { startWorker } from '../../worker/src/app.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'
import { enrollWorker, eventually, openHarness, wsUrl } from './pi/harness.js'
import { ADMIN_TOKEN, useAdminToken } from './pi/rest.js'
import { owner, requester } from './pi/phase7.js'

it('opens real snapshots and diffs, accepts a Requester run, previews and submits its restoration handoff', async () => {
  useAdminToken()
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  const origin = 'http://127.0.0.1:' + port
  const { hub, dir, cleanup } = await openHarness({ server: { port },
    dashboard: { allowedOrigins: [origin], distDir: fileURLToPath(new URL('../../dashboard/dist/site/', import.meta.url)) } })
  const browser = await chromium.launch({ channel: 'chrome' })
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined
  try {
    const workerId = 'phase7-ui'
    const identity = await enrollWorker(hub, workerId)
    const path = join(dir, 'repo')
    mkdirSync(join(path, '.board'), { recursive: true })
    writeFileSync(join(path, '.board', 'HANDOFF.md'), 'before UI edit')
    worker = await startWorker(WorkerConfigSchema.parse({ workerId, hub: { url: wsUrl(hub.address!) },
      adapters: { mock: { enabled: true } }, workspaces: [{ id: 'sandbox', label: 'Sandbox', path, allowedAdapters: ['mock'], maxProfile: 'edit' }] }),
    { stateDir: join(dir, 'worker-state'), identity: { privateKey: identity.privateKey, publicKey: identity.publicKey, fingerprint: identity.fingerprint } })
    await eventually(() => hub.ctx.workers.get(workerId)?.connection === 'online')
    const ops = [{ op: 'write', path: '.board/HANDOFF.md', content: 'after UI edit' }]
    const task = await hub.ctx.orchestrator.createTask({ profile: 'edit', adapter: 'mock', workspaceId: 'sandbox',
      prompt: '#scenario:fs harness=1 ops=' + Buffer.from(JSON.stringify(ops)).toString('base64url') }, requester)
    await hub.ctx.orchestrator.approve(task.id, owner)
    await eventually(() => hub.ctx.orchestrator.getTask(task.id)?.status === 'succeeded', { timeoutMs: 15000 })

    const page = await browser.newPage()
    await page.goto(origin + '/tasks/' + task.id)
    await page.getByTestId('login-token').fill(ADMIN_TOKEN)
    await page.getByTestId('login-submit').click()
    await page.getByTestId('tech-details').locator('summary').click()
    const board = page.getByTestId('board-panel')
    await pw(board).toContainText('after UI edit')
    await board.getByRole('button', { name: 'DIFF', exact: true }).click()
    await pw(board).toContainText('-before UI edit')
    await pw(board).toContainText('+after UI edit')
    await pw(page.getByTestId('handoff-open')).toBeVisible()
    page.once('dialog', dialog => dialog.accept())
    await page.getByTestId('pointer-accept').click()
    await pw(page.getByTestId('pointer-indicator')).toContainText('lastAccepted #' + task.taskNo)
    await page.getByTestId('board-restore-task').click()
    await pw(page.getByTestId('handoff-prompt')).toHaveValue(/before UI edit/)
    await page.getByTestId('handoff-cli').selectOption('mock')
    await page.getByTestId('handoff-preview').getByRole('button', { name: '组合 Prompt' }).click()
    await pw(page.getByTestId('handoff-preview')).toContainText('before UI edit')
    const post = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/handoff'))
    await page.getByTestId('handoff-submit').click()
    expect((await post).headers()['idempotency-key']).toBeTruthy()
    await pw(page.getByTestId('mission-drawer').locator('h2')).toContainText('恢复为以下内容')
    expect(hub.ctx.orchestrator.getTask(task.id)!.children).toHaveLength(1)
  } finally { await browser.close(); await worker?.close(); await cleanup() }
}, 60000)
