import './kernel/events.js'
import { Context } from 'cordis'
import type { Fiber } from 'cordis'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { SystemClock } from '@agent-hub/common'
import type { Clock } from './services/clock.js'
import { FiberState } from './kernel/fiber-state.js'
import { waitForActive } from './kernel/lifecycle.js'
import { installHubLogging } from './kernel/logging.js'
import { safeOn } from './kernel/safe.js'
import { HubConfigSchema } from './config/schema.js'
import type { HubConfig, HubConfigInput } from './config/schema.js'
import { watchHubConfig } from './config/watcher.js'
import { ClockSystem } from './plugins/clock-system/index.js'
import { HttpServer } from './plugins/http-server/index.js'
import { StoreSqlite } from './plugins/store-sqlite/index.js'
import { Auth } from './plugins/auth/index.js'
import { Policy } from './plugins/policy/index.js'
import { WorkerGatewayWs } from './plugins/worker-gateway-ws/index.js'
import { OrchestratorService } from './plugins/orchestrator/index.js'
import * as dashboardStatic from './plugins/dashboard-static/index.js'
import * as dashboard from './plugins/dashboard-api/index.js'
import * as retention from './plugins/retention/index.js'
import { auditLogs } from './plugins/store-sqlite/schema.js'
import { channelFeishu } from './plugins/channel-feishu/index.js'
import type { FeishuTransport } from './plugins/channel-feishu/transport.js'
import { supervise } from './kernel/supervisor.js'

export interface HubOptions { clock?: Clock; configPath?: string; listen?: boolean; readinessTimeoutMs?: number; log?: (line: string) => void; feishuTransport?: FeishuTransport }

async function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
    })])
  } finally { clearTimeout(timer) }
}

export async function createHub(input: HubConfigInput = {}, options: HubOptions = {}) {
  const config = HubConfigSchema.parse(input)
  const root = new Context()
  const clock = options.clock ?? new SystemClock()
  if (options.log) installHubLogging(root, clock, options.log)
  const sections = new Map<string, Fiber>()
  const status = { configError: null as string | null, restartRequired: false }
  const statusView = () => ({ ...status })
  const orchestratorConfig = (value: HubConfig) => ({ ...value.orchestrator, harness: value.harness, requesterReplyPolicy: value.feishu.requesterReplyPolicy, timezone: config.server.timezone })
  const authConfig = (value: HubConfig) => ({ allowedOrigins: value.dashboard.allowedOrigins, sessionTtlMs: value.dashboard.sessionTtlMs })
  const policyConfig = (value: HubConfig) => ({ ownerOpenIds: value.feishu.ownerOpenIds, requesterAllowlist: value.feishu.requesterAllowlist,
    requesterPolicy: value.feishu.requesterPolicy, allowedChatIds: value.feishu.allowedChatIds })
  const feishuConfig = (value: HubConfig) => ({ ...value.feishu, appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '', maxPromptChars: value.orchestrator.tasks.maxPromptChars, redactionPatterns: value.workers.redactionPatterns })
  const feishuPlugin = channelFeishu(config.server.publicUrl, options.feishuTransport, statusView)
  let unsupervise: (() => void) | undefined
  const critical = () => criticalFibers(sections)
  const retentionConfig = (value: HubConfig) => ({ ...value.retention, maxDbBytes: value.logs.maxDbBytes,
    retentionDays: value.logs.retentionDays, dbPath: config.storage.path, timezone: config.server.timezone })
  function mountFeishu(ctx: Context, value: HubConfig) {
    const fiber = ctx.use(feishuPlugin, feishuConfig(value)).ctx.fiber
    sections.set('feishu', fiber)
    unsupervise = supervise(ctx, [fiber])
    return fiber
  }
  const storeConfig = (value: HubConfig) => ({ ...value.storage, maxBytesPerRun: value.logs.maxBytesPerRun,
    redactionPatterns: value.workers.redactionPatterns })
  const distDir = config.dashboard.distDir ?? fileURLToPath(new URL('../../dashboard/dist/site', import.meta.url))
  const app = root.use(ctx => {
    sections.set('clock', ctx.use(ClockSystem, clock).ctx.fiber)
    sections.set('server', ctx.use(HttpServer, config.server).ctx.fiber)
    sections.set('storage', ctx.use(StoreSqlite, storeConfig(config)).ctx.fiber)
    sections.set('policy', ctx.use(Policy, policyConfig(config)).ctx.fiber)
    sections.set('auth', ctx.use(Auth, authConfig(config)).ctx.fiber)
    sections.set('workers', ctx.use(WorkerGatewayWs, config.workers).ctx.fiber)
    sections.set('orchestrator', ctx.use(OrchestratorService, orchestratorConfig(config)).ctx.fiber)
    sections.set('dashboard', ctx.use(dashboard, { publicUrl: config.server.publicUrl, workerPath: config.workers.path,
      allowInsecureCookie: config.server.allowInsecureWorker, status: statusView }).ctx.fiber)
    if (existsSync(distDir) && statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) ctx.use(dashboardStatic, { distDir })
    const retentionFiber = ctx.use(retention, retentionConfig(config)).ctx.fiber
    sections.set('retention', retentionFiber)
    supervise(ctx, [retentionFiber])
    if (config.feishu.enabled) mountFeishu(ctx, config)
  }).ctx.fiber

  let stopWatcher: (() => Promise<void>) | undefined
  let address: string | undefined
  try {
    await app.await()
    const ready = await waitForActive(root, critical(), options.readinessTimeoutMs === undefined ? {} : { timeoutMs: options.readinessTimeoutMs })
    if (!ready.success) throw new Error('Critical fibers unavailable: ' + JSON.stringify(ready))
    if (options.feishuTransport) await sections.get('feishu')?.await().catch(() => undefined)
    root.http.setReadyCheck(() => critical().every(fiber => fiber.state === FiberState.ACTIVE))
    if (options.listen !== false) address = await root.http.listen()
    root.http.setAccepting(true)
    const emitStatus = () => {
      const overview = root.orchestrator.overview()
      root.emit('hub/status', { ...overview.hub, ...status, feishu: overview.feishu })
    }
    safeOn(app.ctx, 'retention/level', emitStatus)
    if (options.configPath) {
      const applied = new Map<string, object>()
      const hot = (value: HubConfig) => ({ server: { ...config.server, trustProxy: value.server.trustProxy },
        storage: { ...storeConfig(value), path: config.storage.path }, auth: authConfig(value), policy: policyConfig(value), orchestrator: orchestratorConfig(value),
        feishu: feishuConfig(value), retention: retentionConfig(value),
        workers: { ...value.workers, path: config.workers.path, maxFrameBytes: config.workers.maxFrameBytes,
          maxInFlightBytes: config.workers.maxInFlightBytes, handshakeTimeoutMs: config.workers.handshakeTimeoutMs } })
      for (const [key, value] of Object.entries(hot(config))) applied.set(key, value)
      const reject = () => {
        status.configError = 'hub.yaml 配置无效'
        root.logger.error(status.configError)
        root.emit('hub/config-rejected', 'hub.yaml', status.configError)
        emitStatus()
      }
      stopWatcher = watchHubConfig(options.configPath, async next => {
        const allowed = hot(next)
        status.restartRequired = !isDeepStrictEqual(next.server, allowed.server) || next.storage.path !== config.storage.path ||
          !isDeepStrictEqual(next.workers, allowed.workers) || next.dashboard.distDir !== config.dashboard.distDir
        for (const [section, value] of Object.entries(allowed)) {
          const previous = applied.get(section)!
          if (isDeepStrictEqual(previous, value)) continue
          if (section === 'feishu' && !next.feishu.enabled) {
            unsupervise?.()
            await sections.get(section)?.dispose()
            sections.delete(section)
            root.emit('feishu/status', { state: 'disabled', since: root.clock.now() })
          } else if (section === 'feishu' && !sections.has(section)) mountFeishu(app.ctx, next)
          else await sections.get(section)!.update(value)
          applied.set(section, value)
          const keys = Object.keys(value).filter(key => !isDeepStrictEqual(Reflect.get(value, key), Reflect.get(previous, key)))
          root.store.tx(db => db.insert(auditLogs).values({ ts: root.clock.now(), actorType: 'system', actorId: 'hub',
            channel: 'system', action: 'config.applied', targetType: 'config', targetId: section, detailJson: { keys } }).run())
        }
        status.configError = null
        emitStatus()
      }, reject)
    }
  } catch (error) {
    await app.dispose()
    throw error
  }

  let stopping: Promise<void> | undefined
  function close() {
    if (stopping) return stopping
    root.http.setAccepting(false)
    const ingest = root.store.ingest
    stopping = deadline((async () => {
      await stopWatcher?.()
      try {
        try { await deadline(root.parallel('hub/drain'), 3000, 'Hub drain') }
        finally { await deadline(ingest.flush(), 5000, 'Hub ingest flush') }
      } finally { await app.dispose() }
    })(), config.server.shutdownTimeoutMs, 'Hub shutdown')
    return stopping
  }
  return { ctx: root, address, fibers: sections, close, config, status: statusView }
}
export type TestHub = Awaited<ReturnType<typeof createHub>>
export const createTestHub = createHub

function criticalFibers(sections: Map<string, Fiber>) {
  return [...sections].filter(([key]) => key !== 'feishu' && key !== 'retention').map(([, fiber]) => fiber)
}

export function onHubFailure(hub: TestHub, stop: () => void) {
  const critical = new Set(criticalFibers(hub.fibers))
  return safeOn(hub.ctx, 'internal/status', fiber => {
    if (critical.has(fiber) && fiber.state === FiberState.FAILED) stop()
  }, { global: true })
}
