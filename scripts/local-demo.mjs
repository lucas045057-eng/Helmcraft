import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../packages/hub/dist/app.js'
import { WorkerConfigSchema } from '../packages/worker/dist/config/schema.js'
import { loadIdentity } from '../packages/worker/dist/identity.js'
import { startWorker } from '../packages/worker/dist/app.js'

const adapter = process.argv[2] ?? 'mock'
if (!['mock', 'codex'].includes(adapter)) throw new Error('Usage: pnpm demo [mock|codex]')
const dir = mkdtempSync(join(tmpdir(), 'agent-hub-demo-'))
const workspace = join(dir, 'sandbox')
mkdirSync(workspace)
const token = randomBytes(32).toString('base64url')
process.env.HUB_ADMIN_TOKEN_SHA256 = createHash('sha256').update(token).digest('hex')
const origin = 'http://127.0.0.1:8080'
const hub = await createHub({ server: { host: '127.0.0.1', publicUrl: origin, allowInsecureWorker: true },
  storage: { path: join(dir, 'hub.sqlite') }, dashboard: { allowedOrigins: [origin, 'http://localhost:8080'] } })
let worker
try {
  const workerId = 'local-demo'
  const identity = loadIdentity(join(dir, 'identity.key'), true)
  const enrollment = hub.ctx.auth.createEnrollToken({ type: 'owner', id: 'demo', channel: 'dashboard' }, workerId)
  hub.ctx.auth.enroll({ workerId, publicKey: identity.publicKey, token: enrollment.token, hostname: 'localhost', os: process.platform }, '127.0.0.1')
  const config = WorkerConfigSchema.parse({ workerId, hub: { url: 'ws://127.0.0.1:8080/ws/worker' },
    adapters: { [adapter]: { enabled: true } },
    workspaces: [{ id: 'sandbox', label: 'Local demo', path: workspace, allowedAdapters: [adapter], maxProfile: 'readonly' }] })
  worker = await startWorker(config, { identity, stateDir: join(dir, 'worker') })
  console.log('Dashboard:', origin, '\nLogin token:', token, '\nWorkspace:', workspace, '\nAdapter:', adapter)
} catch (error) { await hub.close(); throw error }
let closing
const stop = () => { closing ??= worker.close().finally(() => hub.close()); return closing }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
