import { AdapterId } from '@agent-hub/protocol'
import type { AdapterCapability } from '@agent-hub/protocol'
import type { WorkerConfig } from '../config/schema.js'
import type { CliAdapter, ProbeResult } from './types.js'
import { claudeCodeAdapter } from './claude-code.js'
import { codexAdapter } from './codex.js'
import { geminiAdapter } from './gemini.js'
import { mockAdapter } from './mock.js'
import { opencodeAdapter } from './opencode.js'
import { antigravityAdapter } from './antigravity.js'
const noFeatures = { resume: false, liveInput: false, structuredOutput: false }
const defaultAdapters = [claudeCodeAdapter, codexAdapter, geminiAdapter, opencodeAdapter, antigravityAdapter, mockAdapter]

async function probeWithTimeout(adapter: CliAdapter, config: WorkerConfig['adapters'][AdapterId]): Promise<ProbeResult> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<ProbeResult>(resolve => {
        timeout = setTimeout(() => {
          resolve({ status: 'error', error: 'Adapter probe timed out after 5 s' })
          controller.abort()
        }, 5000)
      }),
      Promise.resolve().then(() => adapter.probe(controller.signal, config)),
    ])
  } catch {
    return { status: 'error', error: 'Adapter probe failed' }
  } finally {
    clearTimeout(timeout)
  }
}

export class AdapterRegistry {
  private config: WorkerConfig
  private readonly probes = new Map<AdapterId, { adapter: CliAdapter | undefined; result: ProbeResult }>()
  private readonly pending = new Map<AdapterId, Promise<void>>()
  private readonly queue: Array<() => void> = []
  private probing = 0
  constructor(config: WorkerConfig, private readonly adapters: CliAdapter[] = defaultAdapters) { this.config = config }
  update(config: WorkerConfig) {
    if (this.config === config) return
    this.config = config
    this.probes.clear()
    this.pending.clear()
  }
  async probe(requested?: AdapterId[]) {
    const config = this.config
    const ids = requested ?? [...AdapterId.options]
    await Promise.all(ids.filter(id => config.adapters[id].enabled).map(id => {
      const existing = this.pending.get(id)
      if (existing) return existing
      const pending = this.schedule(async () => {
        if (this.config !== config) return
        const adapter = this.adapters.find(candidate => candidate.id === id)
        const result: ProbeResult = adapter ? await probeWithTimeout(adapter, config.adapters[id])
          : { status: 'missing', error: 'Adapter unavailable' }
        if (this.config === config) this.probes.set(id, { adapter, result })
      }).finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id) })
      this.pending.set(id, pending)
      return pending
    }))
    return this.capabilities()
  }
  private schedule(job: () => Promise<void>) {
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        this.probing++
        void job().then(resolve, reject).finally(() => {
          this.probing--
          this.queue.shift()?.()
        })
      }
      if (this.probing < 2) start()
      else this.queue.push(start)
    })
  }
  get(id: AdapterId) { return this.probes.get(id) }
  capabilities(): AdapterCapability[] {
    return AdapterId.options.flatMap(id => {
      const probe = this.probes.get(id)
      if (!probe) return []
      const { adapter, result } = probe
      return [{ id, status: result.status, features: adapter?.features ?? noFeatures,
        ...(result.version && { version: result.version }), ...(result.error && { error: result.error }),
        ...(result.exe && { binPath: result.exe.command.slice(0, 512) }) }]
    })
  }
}
