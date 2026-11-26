import { stableHash, TokenBucket } from '@agent-hub/common'
import { setTimeout as delay } from 'node:timers/promises'
import type { HubConfig } from '../../config/schema.js'
import type { CardJson, FeishuTransport } from './transport.js'

type CardSettings = HubConfig['feishu']['card']
export interface DesiredCard { card: CardJson; version: number; terminal: boolean }
interface Entry {
  desired: DesiredCard; hash: string; sentHash: string | null; lastPatch: number; high: boolean
  until: number; failures: number; busy: boolean; touched: number; stopped: boolean
  timer?: ReturnType<typeof setTimeout> | undefined
}
interface Callbacks {
  sent(id: string, hash: string, version: number): void
  dead(id: string): Promise<void>
  warn(error: unknown): void
}
export function errorKind(error: unknown) {
  const e = error as { status?: number; code?: number; message?: string; response?: { status?: number; data?: { code?: number; msg?: string } } } | null
  const code = Number(e?.response?.data?.code ?? e?.code)
  if (e?.response?.status === 429 || e?.status === 429 || [429, 99991400, 230020].includes(code)) return 'rate'
  if ([230011, 230012, 230017, 230031, 200000, 200310].includes(code) ||
    /recalled|withdrawn|cannot be updated|not editable|message.*expired|dead.card/i.test(e?.response?.data?.msg ?? e?.message ?? '')) return 'dead'
  return 'other'
}

export class CardUpdater {
  private readonly entries = new Map<string, Entry>()
  private readonly held = new Set<string>()
  private readonly bucket: TokenBucket
  private limited: number[] = []
  private reducedUntil = 0
  private paused = false
  private closed = false
  constructor(private transport: Pick<FeishuTransport, 'patchCard'>, private config: CardSettings, private callbacks: Callbacks) {
    this.bucket = new TokenBucket(config.globalPatchQps, 10, { monotonic: Date.now })
  }
  configure(config: CardSettings) {
    this.config = config
    this.bucket.setRate(config.globalPatchQps / (this.reducedUntil > Date.now() ? 2 : 1))
    for (const [id, e] of this.entries) this.schedule(id, e)
  }
  setPaused(paused: boolean) {
    this.paused = paused
    for (const [id, e] of this.entries) this.schedule(id, e)
  }
  desire(id: string, desired: DesiredCard, high: boolean, sentHash: string | null = null, lastPatch = 0) {
    if (this.closed) return
    const hash = stableHash(desired.card)
    const prior = this.entries.get(id)
    if (prior && prior.desired.version > desired.version) return
    const e = prior ?? { desired, hash, sentHash, lastPatch, high, until: 0, failures: 0, busy: false, touched: 0, stopped: false }
    if (e.stopped && e.hash !== hash) { e.stopped = false; e.failures = 0 }
    e.desired = desired
    e.hash = hash
    e.high ||= high
    e.touched = Date.now()
    this.entries.delete(id)
    this.entries.set(id, e)
    if (this.entries.size > 2000) {
      const clean = [...this.entries].filter(([, entry]) => !entry.busy && entry.hash === entry.sentHash)
      this.forget(clean.find(([, entry]) => entry.desired.terminal)?.[0] ?? clean[0]?.[0] ?? this.entries.keys().next().value!)
    }
    this.schedule(id, e)
  }
  markSent(id: string, desired: DesiredCard) {
    this.desire(id, desired, false)
    const e = this.entries.get(id)
    if (!e) return
    const hash = stableHash(desired.card)
    e.sentHash = hash
    e.lastPatch = Date.now()
    this.callbacks.sent(id, hash, desired.version)
    this.schedule(id, e)
  }
  hold(id: string) {
    this.held.add(id)
    clearTimeout(this.entries.get(id)?.timer)
    return () => {
      this.held.delete(id)
      const entry = this.entries.get(id)
      if (entry) this.schedule(id, entry)
    }
  }
  forget(id: string) {
    clearTimeout(this.entries.get(id)?.timer)
    this.entries.delete(id)
  }
  private schedule(id: string, e: Entry) {
    clearTimeout(e.timer)
    if (this.closed || e.busy || this.held.has(id)) return
    if (e.sentHash === e.hash || this.paused || e.stopped) {
      if (e.sentHash === e.hash) e.high = false
      if (e.desired.terminal) e.timer = setTimeout(() => this.forget(id), Math.max(0, e.touched + 600000 - Date.now()))
      return
    }
    const interval = e.high ? this.config.minPatchIntervalHighMs : this.config.minPatchIntervalMs
    const delay = Math.max(e.lastPatch + interval, e.until) - Date.now()
    e.timer = setTimeout(() => { void this.patch(id, e).catch(error => this.callbacks.warn(error)) }, Math.max(0, delay))
  }
  private async patch(id: string, e: Entry) {
    if (this.paused || this.closed || e.busy || e.hash === e.sentHash) return
    const now = Date.now()
    if (this.reducedUntil && now >= this.reducedUntil) {
      this.reducedUntil = 0
      this.bucket.setRate(this.config.globalPatchQps)
    }
    if (!this.bucket.take()) { e.until = now + 50 + Math.random() * 100; this.schedule(id, e); return }
    e.busy = true
    const { desired, hash, high } = e
    e.high = false
    try {
      await this.transport.patchCard(id, desired.card)
      if (this.closed || this.entries.get(id) !== e) return
      e.sentHash = hash
      e.lastPatch = Date.now()
      e.failures = 0
      e.until = 0
      this.callbacks.sent(id, hash, desired.version)
    } catch (error) {
      if (this.closed || this.entries.get(id) !== e) return
      e.high ||= high
      const kind = errorKind(error)
      if (kind === 'dead') { this.forget(id); await this.callbacks.dead(id); return }
      if (kind === 'rate') {
        this.limited = [...this.limited.filter(at => at > now - 60000), now].slice(-3)
        if (this.limited.length === 3) {
          this.reducedUntil = now + 300000
          this.bucket.setRate(this.config.globalPatchQps / 2)
        }
      }
      e.until = Date.now() + Math.min(30000, 2000 * 2 ** e.failures++)
      if (kind === 'other' && e.failures >= 5) { e.stopped = true; this.callbacks.warn(error) }
    } finally {
      e.busy = false
      if (this.entries.get(id) === e) this.schedule(id, e)
    }
  }
  async flush(ms = 2900) {
    const end = Date.now() + Math.min(ms, 3000)
    while (!this.paused && !this.closed && Date.now() < end &&
      [...this.entries.values()].some(e => e.desired.terminal && !e.stopped && e.sentHash !== e.hash)) {
      await new Promise(resolve => setTimeout(resolve, Math.min(25, end - Date.now())))
    }
  }
  close() {
    this.closed = true
    for (const id of this.entries.keys()) this.forget(id)
  }
}

// Send quotas are shared by replies and direct sends and independent of PATCH.
export class MessageSender {
  private readonly global = new TokenBucket(5, 5, { monotonic: Date.now })
  private readonly chats = new Map<string, number>()
  private readonly stop = new AbortController()
  async send<T>(chat: string, fn: () => Promise<T>, idempotent = false, stillWanted?: () => boolean): Promise<T> {
    let retries = 0
    const { signal } = this.stop
    while (!signal.aborted) {
      if (stillWanted && !stillWanted()) throw new Error('Feishu message superseded')
      const now = Date.now()
      const wait = (this.chats.get(chat) ?? 0) - now
      if (wait <= 0 && this.global.take()) {
        for (const [key, until] of this.chats) {
          if (until > now) break
          this.chats.delete(key)
        }
        this.chats.set(chat, now + 1000)
        try { return await fn() }
        catch (error) {
          const kind = errorKind(error)
          const response = (error as { response?: { status?: number } } | null)?.response
          if (!idempotent || kind === 'dead' || (kind !== 'rate' && response && (response.status ?? 0) < 500) || retries >= 5) throw error
          await delay(Math.min(30000, 2000 * 2 ** retries++), undefined, { signal })
          continue
        }
      }
      await delay(wait > 0 ? Math.min(wait, 1000) : 100, undefined, { signal })
    }
    throw new Error('Feishu channel closed')
  }
  close() { this.stop.abort() }
}
