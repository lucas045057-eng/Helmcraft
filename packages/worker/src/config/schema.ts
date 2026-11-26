import { z } from 'zod'
import { isAbsolute, win32 } from 'node:path'
import { VerifyCommandId, AdapterId, Profile, WorkerId, WorkspaceId } from '@agent-hub/protocol'
import { adapterPassEnv } from '../security/env.js'

const positive = z.number().int().positive()
export const AdapterConfig = z.strictObject({
  enabled: z.boolean().default(false), command: z.string().optional(),
  passEnv: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).default({}),
  allowedExtraArgs: z.array(z.string().min(1).regex(/^\P{Cc}+$/u)).default([]),
  argsOverride: z.partialRecord(Profile, z.array(z.string())).default({}),
  stderrEncoding: z.enum(['utf8', 'gbk']).default('utf8'),
})
const forbiddenShells = new Set('cmd powershell pwsh bash sh zsh dash fish ksh csh tcsh wsl'.split(' '))
export const FORBIDDEN_SHELL_NAMES: readonly string[] = [...forbiddenShells]
export function isForbiddenShell(exe: string): boolean {
  const name = win32.basename(exe).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/u, '')
  return forbiddenShells.has(name)
}
export function validateVerifyArgv({ argv }: { argv: string[] }, ctx: z.RefinementCtx) {
  const exe = argv[0] ?? ''
  if (isForbiddenShell(exe)) ctx.addIssue({ code: 'custom', message: 'VERIFY_SHELL_FORBIDDEN' })
  const absolute = process.platform === 'win32' ? /^[A-Za-z]:[\\/]|^\\\\/.test(exe) : isAbsolute(exe)
  if ((!absolute && !/^[A-Za-z0-9_.-]+$/.test(exe)) || exe === '.' || exe === '..' || argv.some(arg => arg.includes('\0')))
    ctx.addIssue({ code: 'custom', message: 'Expected an executable name or absolute path and literal arguments' })
  if (Buffer.byteLength(argv.join(' ')) > 32768) ctx.addIssue({ code: 'custom', message: 'Verification command exceeds 32 KiB' })
}
const VerifyCommandConfig = z.strictObject({
  id: VerifyCommandId, argv: z.array(z.string().min(1).max(4096)).min(1).max(64), cwd: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).default({}),
  passEnv: z.array(z.string().min(1)).default([]),
}).superRefine(validateVerifyArgv)
const patterns = z.array(z.string().min(1).max(256)).max(64).default([])
const LoopbackUrl = z.url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
}, 'Visual target URL must use loopback http')
const VisualServerConfig = z.strictObject({
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  cwd: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).default({}),
  passEnv: z.array(z.string().min(1)).default([]),
}).superRefine(validateVerifyArgv)
const VisualRoutes = z.array(z.string().startsWith('/').max(256).refine(r => !r.startsWith('//') && !r.includes('\\'), 'Visual route must be a relative path')).min(1).max(6)
const VisualViewport = z.strictObject({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(240).max(2160),
})
export const VisualTargetConfig = z.strictObject({
  enabled: z.boolean().default(false),
  url: LoopbackUrl.optional(),
  routes: VisualRoutes.default(['/']),
  startCommand: VisualServerConfig.optional(),
  viewport: VisualViewport.extend({
    width: VisualViewport.shape.width.default(1280),
    height: VisualViewport.shape.height.default(800),
  }).prefault({}),
  captureBefore: z.boolean().default(true),
  startupTimeoutMs: z.number().int().min(1000).max(120_000).default(25_000),
  captureTimeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  failOnConsoleError: z.boolean().default(true),
  failOnPageError: z.boolean().default(true),
  failOnBlankPage: z.boolean().default(true),
})
const VisualTargetOverrideConfig = z.strictObject({
  enabled: z.boolean().optional(),
  url: LoopbackUrl.optional(),
  routes: VisualRoutes.optional(),
  startCommand: VisualServerConfig.optional(),
  viewport: VisualViewport.optional(),
  captureBefore: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  captureTimeoutMs: z.number().int().min(1000).max(60_000).optional(),
  failOnConsoleError: z.boolean().optional(),
  failOnPageError: z.boolean().optional(),
  failOnBlankPage: z.boolean().optional(),
})
export type VisualTarget = z.output<typeof VisualTargetConfig>
export const WorkspaceHarnessConfig = z.strictObject({
  blackboard: z.boolean().default(true),
  verify: z.strictObject({
    commands: z.array(VerifyCommandConfig).max(16).default([]), failFast: z.boolean().default(true),
    totalTimeoutMs: z.number().int().min(10000).max(14400000).default(1800000),
    maxAutoFixRetries: z.number().int().min(0).max(2).default(2),
  }).prefault({}),
  visual: VisualTargetConfig.extend({
    subdirOverrides: z.record(z.string().min(1).max(128), VisualTargetOverrideConfig).default({}),
  }).prefault({}).superRefine((val, ctx) => {
    const check = (baseUrl: string | undefined, routes: readonly string[], path: (string | number)[]) => {
      if (!baseUrl) return
      for (const route of routes) {
        try {
          if (new URL(route, baseUrl).toString().length > 512) {
            ctx.addIssue({ code: 'custom', path, message: 'Resolved visual route URL exceeds 512 characters' })
          }
        } catch {
          ctx.addIssue({ code: 'custom', path, message: 'Invalid visual route URL' })
        }
      }
    }
    check(val.url, val.routes, ['routes'])
    for (const [sub, ov] of Object.entries(val.subdirOverrides)) {
      check(ov.url ?? val.url, ov.routes ?? val.routes, ['subdirOverrides', sub, 'routes'])
    }
  }),
  tamper: z.strictObject({ extraPaths: patterns, replaceDefaults: z.boolean().default(false) }).prefault({}),
  manifest: z.strictObject({ exclude: patterns, maxFiles: z.number().int().min(1000).max(1000000).default(200000),
    maxScanMs: z.number().int().min(1000).max(120000).default(20000), readonlyCheck: z.boolean().default(true) }).prefault({}),
}).prefault({})
export type VerifyCommand = z.output<typeof VerifyCommandConfig>
export const WorkerConfigSchema = z.strictObject({
  harness: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
  workerId: WorkerId,
  hub: z.strictObject({ url: z.url().refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  }, 'Expected WSS or loopback WS'), identityPath: z.string().optional() }),
  maxConcurrency: z.number().int().min(1).max(32).default(2),
  shutdown: z.strictObject({ pipeDrainTimeoutMs: positive.max(60000).default(5000), drainTimeoutMs: z.number().int().nonnegative().default(0) }).prefault({}),
  tunnel: z.strictObject({ runBufferBytes: positive.default(8 << 20), totalBufferBytes: positive.default(64 << 20),
    flushIntervalMs: positive.default(100) }).prefault({}),
  localLogs: z.strictObject({ dir: z.string().optional(), maxBytesPerRun: positive.default(100 << 20),
    retentionDays: positive.default(14) }).prefault({}),
  security: z.strictObject({ allowedEnvOverrideKeys: z.array(z.string()).default([]), useJobObject: z.boolean().default(true) }).prefault({}),
  workspaces: z.array(z.strictObject({ id: WorkspaceId, label: z.string().max(128), path: z.string(),
    harness: WorkspaceHarnessConfig,
    allowedAdapters: z.array(AdapterId).nonempty(), maxProfile: Profile, strictProfile: z.boolean().default(false),
    maxConcurrent: z.number().int().min(1).max(16).default(2) })).max(128),
  adapters: z.partialRecord(AdapterId, AdapterConfig).default({}),
}).transform(config => ({
  ...config,
  workspaces: config.workspaces.map(workspace => ({ ...workspace, configExposed: false })),
  adapters: Object.fromEntries(AdapterId.options.map(id => {
    const adapter = config.adapters[id] ?? AdapterConfig.parse({})
    return [id, { ...adapter, passEnv: adapter.passEnv ?? adapterPassEnv[id] }]
  })) as Record<AdapterId, z.output<typeof AdapterConfig> & { passEnv: string[] }>,
}))
export type WorkerConfig = z.output<typeof WorkerConfigSchema>
export type Workspace = WorkerConfig['workspaces'][number]
