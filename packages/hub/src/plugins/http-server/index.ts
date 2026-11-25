import Fastify from 'fastify'
import proxyAddr from '@fastify/proxy-addr'
import type { TLSSocket } from 'node:tls'
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify'
import { Context, Service } from 'cordis'
import { ulid } from '@agent-hub/common'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { HttpService, RouteHandler, StaticHandler, UpgradeHandler } from '../../services/http.js'
import { HubConfigSchema } from '../../config/schema.js'
import { onHotUpdate } from '../../kernel/hot-update.js'
import { HubError } from '../../services/errors.js'

export interface HttpConfig { host: string; port: number; trustProxy: string[]; allowInsecureWorker: boolean }
interface Route { method: string; parts: string[]; handler: RouteHandler }
export class HttpServer extends Service implements HttpService {
  static inject = ['clock']
  static Config = HubConfigSchema.shape.server
  readonly app: FastifyInstance
  accepting = false
  private readonly routes: Route[] = []
  private readonly upgrades = new Map<string, UpgradeHandler>()
  private readyCheck = () => true
  private fallback: StaticHandler | undefined
  private trust: (addr: string, index: number) => boolean
  constructor(ctx: Context, private readonly config: HttpConfig) {
    super(ctx, 'http')
    this.trust = proxyAddr.compile(config.trustProxy)
    this.app = Fastify({ trustProxy: (address, index) => this.trust(address, index), bodyLimit: 256 * 1024,
      requestIdHeader: false, genReqId: () => ulid(ctx.clock.now()) })
  }
  [Service.init]() {
    this.app.addHook('onRequest', async (req: FastifyRequest, res: FastifyReply) => {
      res.header('X-Request-Id', req.id)
      if (!this.accepting && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) throw new HubError('HUB_SHUTTING_DOWN', 503)
    })
    this.app.setErrorHandler((error: FastifyError, req: FastifyRequest, res: FastifyReply) => {
      const tooLarge = 'statusCode' in error && error.statusCode === 413
      const badRequest = 'statusCode' in error && error.statusCode === 400
      const fault = error instanceof HubError ? error : tooLarge ? new HubError('PAYLOAD_TOO_LARGE', 413)
        : badRequest ? new HubError('VALIDATION_FAILED', 400) : new HubError('INTERNAL', 500)
      if (fault.retryAfter !== undefined) res.header('Retry-After', fault.retryAfter)
      if (fault.status >= 500 && fault.status !== 503) this.ctx.logger.error('request %s failed', req.id)
      void res.code(fault.status).send({ error: { code: fault.code, message: fault.message, requestId: req.id,
        ...(fault.details && { details: fault.details }) } })
    })
    this.app.get('/healthz', async () => ({ ok: true }))
    this.app.get('/readyz', async (_req: FastifyRequest, res: FastifyReply) => {
      const ready = this.accepting && this.readyCheck()
      res.code(ready ? 200 : 503)
      return { ready }
    })
    this.app.setNotFoundHandler((req, res) => this.fallback?.(req, res) ?? res.code(404).send())
    this.app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/*', handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!this.readyCheck()) throw new HubError('HUB_SHUTTING_DOWN', 503)
      let parts: string[]
      try { parts = req.url.split('?')[0]!.split('/').map(decodeURIComponent) }
      catch { throw new HubError('VALIDATION_FAILED', 400) }
      for (const route of this.routes) {
        if (route.method !== req.method || route.parts.length !== parts.length) continue
        const params: Record<string, string> = {}
        if (!route.parts.every((part, index) => {
          if (!part.startsWith(':')) return part === parts[index]
          params[part.slice(1)] = parts[index]!
          return true
        })) continue
        return route.handler(req, reply, params)
      }
      return reply.code(404).send({ error: { code: 'VALIDATION_FAILED', message: '接口不存在', requestId: req.id } })
    } })
    const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const handler = this.upgrades.get(req.url?.split('?')[0] ?? '')
      if (handler && this.accepting) handler(req, socket, head)
      else socket.end('HTTP/1.1 ' + (this.accepting ? '404 Not Found' : '503 Service Unavailable') + '\r\nConnection: close\r\n\r\n')
    }
    this.ctx.effect(() => {
      this.app.server.on('upgrade', upgrade)
      return async () => {
        this.app.server.off('upgrade', upgrade)
        this.app.server.closeAllConnections()
        await this.app.close()
      }
    }, 'http:server')
    onHotUpdate<HttpConfig>(this.ctx, ['trustProxy'], next => { this.trust = proxyAddr.compile(next.trustProxy) })
  }
  route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: RouteHandler) {
    const parts = path.split('/')
    if (this.routes.some(route => route.method === method && route.parts.join('/') === path)) throw new Error('Duplicate route: ' + path)
    const entry = { method, parts, handler }
    this.routes.push(entry)
    return () => { const index = this.routes.indexOf(entry); if (index >= 0) this.routes.splice(index, 1) }
  }
  staticFallback(handler: StaticHandler) {
    if (this.fallback) throw new Error('Duplicate static fallback')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }
  upgrade(path: string, handler: UpgradeHandler) {
    if (this.upgrades.has(path)) throw new Error('Duplicate upgrade path: ' + path)
    this.upgrades.set(path, handler)
    return () => { this.upgrades.delete(path) }
  }
  clientIp(req: IncomingMessage) {
    return proxyAddr(req, this.trust) ?? req.socket.remoteAddress ?? ''
  }
  workerTransportAllowed(req: IncomingMessage) {
    return this.config.allowInsecureWorker || (req.socket as TLSSocket).encrypted === true ||
      (this.trust(req.socket.remoteAddress ?? '', 0) && req.headers['x-forwarded-proto'] === 'https')
  }
  listen() { return this.app.listen({ host: this.config.host, port: this.config.port }) }
  setReadyCheck(check: () => boolean) { this.readyCheck = check }
  setAccepting(accepting: boolean) { this.accepting = accepting }
}
