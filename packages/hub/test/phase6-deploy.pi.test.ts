/**
 * Pi 独立验收 · Phase 6 · 部署产物与运维文档审计
 *
 * 以真实配置 Schema 解析示例配置，并对 Dockerfile / compose / Caddyfile / .env 模板 /
 * Windows 计划任务脚本 / OPERATIONS.md / README.md 做安全与一致性断言（非 root、无硬编码密钥、
 * 长连接反代参数、stop_grace_period ≥ shutdownTimeoutMs、trustProxy 与 Compose 子网一致等）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { HubConfigSchema } from '../src/config/schema.js'
import { WorkerConfigSchema } from '../../worker/src/config/schema.js'

const deploy = new URL('../../../deploy/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, deploy), 'utf8')
const root = new URL('../../../', import.meta.url)

// 明显是真实凭据/私钥的特征（示例与文档中必须为 0 次）。
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/, /AHK[A-Za-z0-9_-]{22,}/, /ahk_[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:APP_SECRET|APP_ID|TOKEN_SHA256|SESSION_SECRET)[ \t]*[:=][ \t]*["']?[A-Za-z0-9+/=_-]{8,}/,
  /\bou_[0-9a-f]{32}\b/,
]

it('deploy/Dockerfile：多阶段构建、运行时非 root、无硬编码密钥、健康检查与正确入口', () => {
  const dockerfile = read('Dockerfile')
  expect(dockerfile).toMatch(/^FROM node:24-bookworm AS workspace$/m)
  expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim AS runtime$/m)
  expect(dockerfile).toContain('pnpm install --frozen-lockfile')
  expect(dockerfile).toContain('--filter @agent-hub/hub... install --prod --frozen-lockfile')
  expect(dockerfile).toContain('-r build')
  // 非 root：`USER node` 出现在运行阶段且没有回落 root。
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'))
  expect(runtime).toMatch(/^USER node$/m)
  expect(runtime).not.toMatch(/^USER root$/m)
  expect(runtime).toMatch(/^ENV NODE_ENV=production$/m)
  expect(runtime).toContain('chown node:node /data')
  // 健康检查 / 入口 / 运行时资产（迁移、备份 worker、面板静态资源）
  expect(runtime).toContain('HEALTHCHECK')
  expect(runtime).toContain('/healthz')
  expect(runtime).toMatch(/^CMD \["node","packages\/hub\/dist\/main\.js","\/app\/hub\.yaml"\]$/m)
  for (const asset of ['packages/hub/migrations', 'packages/hub/maintenance', 'packages/dashboard/dist/site']) {
    expect(runtime).toContain(asset)
  }
  expect(runtime).not.toContain('privileged')
  expect(dockerfile).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED')
  expect(dockerfile).not.toContain('--insecure')
  for (const pattern of secretPatterns) expect(pattern.test(dockerfile)).toBe(false)
})

it('deploy/docker-compose.yml：优雅停机时限、仅内网暴露 8080、卷只读挂载、trustProxy 子网一致', () => {
  const compose = parseYaml(read('docker-compose.yml')) as {
    services: Record<string, Record<string, unknown>>
    networks?: { default?: { ipam?: { config?: Array<{ subnet?: string }> } } }
  }
  const hub = compose.services.hub!
  const caddy = compose.services.caddy!
  expect(hub.stop_grace_period).toBe('20s')
  expect(hub.env_file).toBe('.env')
  expect(hub.expose).toEqual(['8080'])
  expect(hub).not.toHaveProperty('ports')
  expect(hub.restart).toBe('unless-stopped')
  expect(hub.volumes).toEqual(expect.arrayContaining(['./data:/data', './hub.yaml:/app/hub.yaml:ro']))
  expect(caddy.image).toBe('caddy:2')
  expect(caddy.ports).toEqual(['80:80', '443:443'])
  expect(caddy.volumes).toEqual(expect.arrayContaining(['./Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy_data:/data']))
  expect(caddy.depends_on).toEqual(['hub'])
  for (const service of Object.values(compose.services)) {
    expect(service).not.toHaveProperty('privileged')
    expect(service).not.toHaveProperty('network_mode')
    expect(service).not.toHaveProperty('cap_add')
    expect(service.user).toBeUndefined() // 非 root 由 Dockerfile `USER node` 保证
  }
  for (const pattern of secretPatterns) expect(pattern.test(read('docker-compose.yml'))).toBe(false)

  // stop_grace_period ≥ server.shutdownTimeoutMs（默认 15 s），否则会强杀导致 WAL 未落盘。
  const hubConfig = HubConfigSchema.parse(parseYaml(read('hub.example.yaml')))
  const grace = Number(/^(\d+)s$/.exec(String(hub.stop_grace_period))![1]) * 1000
  expect(grace).toBeGreaterThanOrEqual(hubConfig.server.shutdownTimeoutMs)
  // Caddy 与 Hub 同处 Compose 默认子网，且该子网就是 trustProxy 白名单。
  const subnet = compose.networks?.default?.ipam?.config?.[0]?.subnet
  expect(subnet).toBe('172.29.60.0/24')
  expect(hubConfig.server.trustProxy).toEqual([subnet])
})

it('deploy/Caddyfile：WebSocket 长连接参数（flush_interval -1、read_timeout 0）', () => {
  const caddy = read('Caddyfile')
  expect(caddy).toContain('reverse_proxy hub:8080')
  expect(caddy).toContain('flush_interval -1')
  expect(caddy).toContain('read_timeout 0')
  expect(caddy).toContain('encode zstd gzip')
  expect(caddy).not.toMatch(/auto_https\s+off/)
  expect(caddy).not.toMatch(/tls\s+internal/)
})

it('deploy/.env.example：四项必需变量为空占位、附带安全的生成命令、无真实密钥', () => {
  const text = read('.env.example')
  const entries = text.split(/\r?\n/).filter(line => /^[A-Z0-9_]+=/.test(line))
    .map(line => line.split('=') as [string, string])
  const map = new Map(entries)
  for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'HUB_ADMIN_TOKEN_SHA256', 'HUB_SESSION_SECRET']) {
    expect(map.has(key)).toBe(true)
    expect(map.get(key)).toBe('')
  }
  // 生成命令必须是随机口令 + SHA-256（不写死任何口令）。
  expect(text).toContain('randomBytes(32)')
  expect(text).toContain("createHash('sha256')")
  expect(text).not.toContain('HUB_ADMIN_TOKEN_SHA256=0')
  for (const pattern of secretPatterns) expect(pattern.test(text.replace(/^#.*$/gm, ''))).toBe(false)
})

it('例子配置可被真实 Schema 解析，且与规格默认值 / 部署文档一致', () => {
  const hub = HubConfigSchema.parse(parseYaml(read('hub.example.yaml')))
  expect(hub.server).toMatchObject({ host: '0.0.0.0', port: 8080, publicUrl: 'https://hub.example.com',
    allowInsecureWorker: false, timezone: 'Asia/Shanghai', shutdownTimeoutMs: 15_000 })
  expect(hub.storage.path).toBe('/data/hub.sqlite')
  expect(hub.logs).toMatchObject({ maxDbBytes: 10 * 1024 ** 3, maxBytesPerRun: 20 << 20,
    retentionDays: { succeeded: 30, other: 90 } })
  expect(hub.retention).toMatchObject({ sliceRows: 5000, sliceIntervalMs: 10_000, backupDir: '/data/backup' })
  expect(hub.workers).toMatchObject({ path: '/ws/worker', gracePeriodMs: 90_000, maxFrameBytes: 1 << 20,
    maxInFlightBytes: 4 << 20, handshakeTimeoutMs: 5000, ackIntervalMs: 200 })
  expect(hub.dashboard.allowedOrigins).toEqual([new URL(hub.server.publicUrl).origin])
  expect(hub.feishu.enabled).toBe(true)
  expect(hub.feishu.ownerOpenIds).toEqual([])
  expect(hub.feishu.requesterPolicy).toBe('allowlist')
  expect(hub.feishu.approvalTarget).toBe('owner_p2p')
  // 示例中不得出现真实飞书凭据（凭据只从环境变量注入）。
  const hubText = read('hub.example.yaml')
  for (const pattern of secretPatterns) expect(pattern.test(hubText)).toBe(false)

  const worker = WorkerConfigSchema.parse(parseYaml(read('worker.example.yaml')))
  expect(worker.hub.url).toBe('wss://hub.example.com' + hub.workers.path)
  expect(worker.hub.identityPath).toBe('identity.key') // 相对路径，不入库、不写绝对路径
  expect(worker.security.useJobObject).toBe(true)
  expect(worker.maxConcurrency).toBe(2)
  expect(worker.workspaces).toHaveLength(1)
  expect(worker.workspaces[0]).toMatchObject({ id: 'sandbox', allowedAdapters: ['codex'], maxProfile: 'edit' })
  expect(Object.values(worker.adapters).filter(adapter => adapter.enabled).map(() => true)).toEqual([true])
  const workerText = read('worker.example.yaml')
  expect(workerText).not.toMatch(/^\s*token\s*:/m)
  expect(workerText).not.toContain('-----BEGIN')
  for (const pattern of secretPatterns) expect(pattern.test(workerText)).toBe(false)
})

it.runIf(process.platform === 'win32')('deploy/windows 计划任务脚本：语法有效、版本门禁、不删除身份/工作区、无内嵌口令', () => {
  const install = read('windows/install-worker.ps1')
  const uninstall = read('windows/uninstall-worker.ps1')
  for (const action of ['install', 'uninstall']) {
    const script = fileURLToPath(new URL('windows/' + action + '-worker.ps1', deploy))
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$errors=$null; $tokens=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:WORKER_PS_FILE,[ref]$tokens,[ref]$errors); if ($errors.Count) { throw ($errors -join [Environment]::NewLine) }'],
    { env: { ...process.env, WORKER_PS_FILE: script }, windowsHide: true })
  }
  expect(install).toContain("$ErrorActionPreference = 'Stop'")
  expect(install).toContain('22.12.0')
  expect(install).toContain('doctor')
  expect(install).toContain('--check-hub')
  expect(install).toContain('install-task')
  expect(uninstall).toContain('uninstall-task')
  // 只改计划任务，不删除身份/私钥/工作区/日志。
  for (const script of [install, uninstall]) {
    expect(script).not.toMatch(/Remove-Item|rm\s+-rf|del\s+/i)
    expect(script).not.toContain('--token')
    expect(script).not.toMatch(/ahk_|identity\.key.*-Force/s)
    for (const pattern of secretPatterns) expect(pattern.test(script)).toBe(false)
  }
  // 安装脚本必须使用仓库内 CLI 绝对路径或 npm shim，不能拼接执行用户输入。
  expect(install).toMatch(/packages\\worker\\bin\\agent-worker\.mjs/)
  expect(install).toContain('Resolve-Path')
})

it('dockerignore：构建上下文排除 .env / data / node_modules / dist / 测试', () => {
  const ignore = readFileSync(new URL('Dockerfile.dockerignore', deploy), 'utf8')
  expect(ignore).toMatch(/^\*\*$/m)
  expect(ignore).toContain('**/node_modules')
  expect(ignore).toContain('**/dist')
  expect(ignore).toContain('!packages/*/src/**')
  expect(ignore).toContain('!packages/hub/migrations/**')
  expect(ignore).toContain('!packages/hub/maintenance/**')
  const positive = ignore.split(/\r?\n/).filter(line => line.startsWith('!')).join('\n')
  for (const forbidden of ['.env', 'deploy/data', 'test/', 'packages/hub/test']) expect(positive).not.toContain(forbidden)
})

it('docs/OPERATIONS.md 与 README.md：运维必需章节、关键参数与规格一致且无真实凭据', () => {
  const operations = readFileSync(new URL('docs/OPERATIONS.md', root), 'utf8')
  for (const heading of ['## 1. 在 VPS 上启动 Hub', '## 2. 接入飞书开放平台', '## 3. Windows Worker 常驻',
    '## 4. Worker、密钥与热更新', '## 5. 数据保留、备份与恢复', '## 6. 日志与故障定位']) {
    expect(operations).toContain(heading)
  }
  for (const key of ['flush_interval -1', 'read_timeout 0', 'integrity_check', 'foreign_key_check', '/healthz', '/readyz',
    'storageLevel', 'warning', 'critical', '4401', '4403', '4409', '4426', '4429', 'umask 077', 'chmod 600 .env',
    'UID 1000', 'VACUUM INTO', 'hub-YYYY-MM-DD.sqlite', 'revoke', 'drain', 'enroll',
    '保留日志 30 天', '其他终态保留 90 天', '元数据保留 365 天', '飞书去重键 7 天', '幂等键 24 小时', '过期后 7 天']) {
    expect(operations, 'OPERATIONS.md 缺少: ' + key).toContain(key)
  }
  // 恢复流程必须在替换数据卷前校验快照完整性。
  expect(operations.indexOf('PRAGMA integrity_check')).toBeLessThan(operations.indexOf('mv "$file" "$old/"'))

  const readme = readFileSync(new URL('README.md', root), 'utf8')
  for (const key of ['pnpm -r build', 'pnpm test', 'pnpm lint', 'pnpm depcheck', 'node packages/hub/dist/main.js',
    'Node.js 24', 'docs/OPERATIONS.md', 'docs/ARCHITECTURE.md', 'Windows', 'pnpm demo mock']) {
    expect(readme, 'README.md 缺少: ' + key).toContain(key)
  }
  for (const pattern of secretPatterns) {
    expect(pattern.test(operations.replace(/^#.*$/gm, ''))).toBe(false)
    expect(pattern.test(readme)).toBe(false)
  }
})
