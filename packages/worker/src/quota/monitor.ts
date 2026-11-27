import type { AdapterId, AdapterQuota } from '@agent-hub/protocol'
import type { AdapterRegistry } from '../adapters/registry.js'
import { antigravityQuota, claudeQuota, codexQuota, defaultQuotaEnv } from './probe.js'
import type { QuotaEnv, QuotaResult } from './probe.js'

const probes: Array<[AdapterId, (env: QuotaEnv) => Promise<QuotaResult | null>]> =
  [['claude-code', claudeQuota], ['codex', codexQuota], ['antigravity', antigravityQuota]]

/** 定时查询本机三家 CLI 的订阅额度；查询失败时保留上一次的数字并附上原因。 */
export class QuotaMonitor {
  private readonly latest = new Map<AdapterId, AdapterQuota>()
  private running: Promise<void> | undefined
  private lastAgyRefresh = 0
  constructor(private readonly registry: AdapterRegistry, private readonly now: () => number,
    private readonly env: (registry: AdapterRegistry) => QuotaEnv = registry => defaultQuotaEnv(registry.get('antigravity')?.result.exe)) {}
  list(): AdapterQuota[] { return [...this.latest.values()] }
  refresh() {
    this.running ??= this.run().finally(() => { this.running = undefined })
    return this.running
  }
  private async run() {
    const base = this.env(this.registry)
    // agy models 要几秒，过期时最多半小时让它刷新一次 token
    const refresh = base.refreshAntigravity
    const env: QuotaEnv = { ...base, ...(refresh && { refreshAntigravity: async () => {
      if (this.now() - this.lastAgyRefresh < 30 * 60_000) return
      this.lastAgyRefresh = this.now()
      await refresh()
    } }) }
    await Promise.all(probes.map(async ([adapter, probe]) => {
      if (this.registry.get(adapter)?.result.status !== 'ready') { this.latest.delete(adapter); return }
      const previous = this.latest.get(adapter)
      let result: QuotaResult | null
      try { result = await probe(env) } catch (error) {
        result = { windows: [], error: '查询失败：' + (error instanceof Error ? error.message : String(error)).slice(0, 120) }
      }
      if (!result) { this.latest.delete(adapter); return }
      const failed = result.error !== undefined && !result.windows.length
      this.latest.set(adapter, failed && previous
        ? { ...previous, error: result.error! }
        : { adapter, ...(result.plan && { plan: result.plan }), windows: result.windows, checkedAt: result.checkedAt ?? this.now(),
          ...(result.error && { error: result.error }) })
    }))
  }
}
