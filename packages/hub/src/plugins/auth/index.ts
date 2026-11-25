import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto'
import { Context, Service } from 'cordis'
import { Lru, ulid } from '@agent-hub/common'
import { Scope } from '@agent-hub/protocol'
import type { Actor, CreateApiTokenRequest, Principal, WorkerEnrollRequest } from '@agent-hub/protocol'
import { desc, eq } from 'drizzle-orm'
import { apiTokens, dashboardSessions, enrollTokens, workers } from '../store-sqlite/schema.js'
import { HubError } from '../../services/errors.js'
import type { AuthService, ReqMeta, SessionAuth } from '../../services/auth.js'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const scopes = [...Scope.options]
const tokenView = (row: typeof apiTokens.$inferSelect) => ({ id: row.id, name: row.name, scopes: Scope.array().parse(row.scopesJson),
  createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt })
export const secureEqual = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'))
export interface AuthConfig { allowedOrigins: string[]; sessionTtlMs: number }

export class Auth extends Service implements AuthService {
  static inject = ['store', 'clock']
  static Config = HubConfigSchema.shape.dashboard
  private loginFailures!: Lru<string, number[]>
  private enrollAttempts!: Lru<string, number[]>
  constructor(ctx: Context, private config: AuthConfig) { super(ctx, 'auth') }
  [Service.init]() {
    this.loginFailures = new Lru(10_000, 900_000, this.ctx.clock)
    this.enrollAttempts = new Lru(10_000, 3_600_000, this.ctx.clock)
    onHotUpdate<AuthConfig>(this.ctx, ['allowedOrigins', 'sessionTtlMs'], next => { this.config = next })
  }
  private attempts(cache: Lru<string, number[]>, ip: string, limit: number, window: number) {
    const now = this.ctx.clock.now()
    const attempts = (cache.get(ip) ?? []).filter(at => now - at < window)
    if (attempts.length >= limit) throw new HubError('RATE_LIMITED', 429, undefined, Math.ceil((attempts[0]! + window - now) / 1000))
    return () => { cache.set(ip, [...attempts, now]) }
  }
  login(token: string, meta: ReqMeta) {
    const addFailure = this.attempts(this.loginFailures, meta.ip, 5, 900_000)
    const digest = process.env.HUB_ADMIN_TOKEN_SHA256 ?? ''
    if (!/^[a-f0-9]{64}$/i.test(digest) || !timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(digest, 'hex'))) {
      addFailure()
      throw new HubError('UNAUTHENTICATED', 401)
    }
    this.loginFailures.delete(meta.ip)
    const sessionId = random(), csrfToken = random(), now = this.ctx.clock.now()
    const expiresAt = now + this.config.sessionTtlMs
    this.ctx.store.tx(db => db.insert(dashboardSessions).values({
      id: ulid(now), tokenHash: sha256(sessionId), csrfToken, createdAt: now, expiresAt,
      lastSeenAt: now, ip: meta.ip, userAgent: meta.userAgent ?? null,
    }).run())
    return { sessionId, csrfToken, expiresAt }
  }
  verifySession(cookie: string | undefined, touch = true): SessionAuth | null {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null
    const row = this.ctx.store.repos.select().from(dashboardSessions).where(eq(dashboardSessions.tokenHash, sha256(cookie))).get()
    const now = this.ctx.clock.now()
    if (!row || row.revokedAt !== null || row.expiresAt <= now) return null
    const renewed = touch && row.expiresAt - now < this.config.sessionTtlMs / 2
    const expiresAt = renewed ? now + this.config.sessionTtlMs : row.expiresAt
    if (touch) this.ctx.store.tx(db => db.update(dashboardSessions).set({ expiresAt, lastSeenAt: now }).where(eq(dashboardSessions.id, row.id)).run())
    return { principal: { type: 'owner', via: 'session', scopes }, csrfToken: row.csrfToken, expiresAt, renewed }
  }
  verifyApiToken(bearer: string | undefined, touch = true): Principal | null {
    if (!bearer || !/^ahk_[A-Za-z0-9_-]+$/.test(bearer)) return null
    const row = this.ctx.store.repos.select().from(apiTokens).where(eq(apiTokens.tokenHash, sha256(bearer))).get()
    if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= this.ctx.clock.now()) ||
        !Array.isArray(row.scopesJson)) return null
    if (touch) this.ctx.store.tx(db => db.update(apiTokens).set({ lastUsedAt: this.ctx.clock.now() }).where(eq(apiTokens.id, row.id)).run())
    return { type: 'owner', via: 'token', scopes: row.scopesJson.map(value => Scope.parse(value)) }
  }
  originAllowed(origin?: string) { return origin !== undefined && this.config.allowedOrigins.includes(origin) }
  verifyMutation(auth: SessionAuth, origin?: string, csrf?: string) {
    if (!this.originAllowed(origin) || !csrf || !secureEqual(csrf, auth.csrfToken)) throw new HubError('CSRF_FAILED', 403)
  }
  logout(cookie: string) {
    this.ctx.store.tx(db => db.update(dashboardSessions).set({ revokedAt: this.ctx.clock.now() }).where(eq(dashboardSessions.tokenHash, sha256(cookie))).run())
    this.ctx.emit('auth/revoked', sha256(cookie))
  }
  cookie(sessionId: string, expiresAt: number, secure = true) {
    return 'ah_sid=' + sessionId + '; HttpOnly' + (secure ? '; Secure' : '') + '; SameSite=Strict; Path=/; Max-Age=' +
      Math.max(0, Math.floor((expiresAt - this.ctx.clock.now()) / 1000))
  }
  createApiToken(name: string, granted: Scope[]) {
    return this.issueApiToken({ name, scopes: granted }, { type: 'system', id: 'hub', channel: 'system' }).token
  }
  issueApiToken(input: CreateApiTokenRequest, actor: Actor) {
    const now = this.ctx.clock.now(), token = 'ahk_' + random()
    if (input.expiresAt !== undefined && input.expiresAt <= now) throw new HubError('VALIDATION_FAILED', 400)
    return this.ctx.store.tx(db => {
      const row = db.insert(apiTokens).values({ id: ulid(now), name: input.name, tokenHash: sha256(token),
        scopesJson: Scope.array().min(1).parse(input.scopes), createdAt: now, expiresAt: input.expiresAt ?? null }).returning().get()
      db.audit.append({ ts: now, actorType: actor.type, actorId: actor.id, channel: actor.channel,
        action: 'token.created', targetType: 'token', targetId: row.id, detailJson: { scopes: input.scopes } })
      return { ...tokenView(row), token }
    })
  }
  listApiTokens() {
    return this.ctx.store.repos.select().from(apiTokens).orderBy(desc(apiTokens.createdAt), desc(apiTokens.id)).all().map(tokenView)
  }
  revokeApiToken(id: string, actor: Actor) {
    const hash = this.ctx.store.tx(db => {
      const row = db.select().from(apiTokens).where(eq(apiTokens.id, id)).get()
      if (!row || row.revokedAt !== null) return
      const now = this.ctx.clock.now()
      db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, id)).run()
      db.audit.append({ ts: now, actorType: actor.type, actorId: actor.id, channel: actor.channel,
        action: 'token.revoked', targetType: 'token', targetId: id })
      return row.tokenHash
    })
    if (hash) this.ctx.emit('auth/revoked', hash)
  }
  createEnrollToken(actor: Actor, suggestedWorkerId?: string) {
    const token = random(), now = this.ctx.clock.now(), expiresAt = now + 600_000
    this.ctx.store.tx(db => db.insert(enrollTokens).values({ tokenHash: sha256(token), suggestedWorkerId: suggestedWorkerId ?? null,
      createdBy: actor.id, createdAt: now, expiresAt }).run())
    return { token, expiresAt }
  }
  enroll(input: WorkerEnrollRequest, ip: string) {
    this.attempts(this.enrollAttempts, ip, 10, 3_600_000)()
    let publicKey: Buffer
    try {
      publicKey = Buffer.from(input.publicKey, 'base64')
      const key = createPublicKey({ key: publicKey, type: 'spki', format: 'der' })
      if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(publicKey)) throw new Error()
    } catch { throw new HubError('VALIDATION_FAILED', 400) }
    const keyFingerprint = createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
    const now = this.ctx.clock.now()
    this.ctx.store.tx(db => {
      const token = db.select().from(enrollTokens).where(eq(enrollTokens.tokenHash, sha256(input.token))).get()
      if (!token || token.usedAt !== null || token.expiresAt <= now || (token.suggestedWorkerId && token.suggestedWorkerId !== input.workerId)) {
        throw new HubError('UNAUTHENTICATED', 401)
      }
      if (db.select().from(workers).where(eq(workers.id, input.workerId)).get()) throw new HubError('INVALID_TRANSITION', 409)
      db.insert(workers).values({ id: input.workerId, displayName: input.workerId, publicKey: publicKey.toString('base64'),
        keyFingerprint, hostname: input.hostname, os: input.os, createdAt: now, updatedAt: now }).run()
      db.update(enrollTokens).set({ usedAt: now, usedByWorkerId: input.workerId }).where(eq(enrollTokens.tokenHash, token.tokenHash)).run()
    })
    return { workerId: input.workerId, keyFingerprint }
  }
}
