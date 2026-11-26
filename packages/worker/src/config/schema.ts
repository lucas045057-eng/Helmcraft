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
export function validateVerifyArgv({ argv }: { argv: string[] }, ctx: z.RefinementCtx) {
  const exe = argv[0] ?? ''
  const name = win32.basename(exe).toLowerCase().replace(/\.exe$/, '')
  if (forbiddenShells.has(name)) ctx.addIssue({ code: 'custom', message: 'VERIFY_SHELL_FORBIDDEN' })
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
export const WorkspaceHarnessConfig = z.strictObject({
  blackboard: z.boolean().default(true),
  verify: z.strictObject({
    commands: z.array(VerifyCommandConfig).max(16).default([]), failFast: z.boolean().default(true),
    totalTimeoutMs: z.number().int().min(10000).max(14400000).default(1800000),
    maxAutoFixRetries: z.number().int().min(0).max(2).default(2),
  }).prefault({}),
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
