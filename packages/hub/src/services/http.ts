import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void
export type RouteHandler = (req: FastifyRequest, reply: FastifyReply, params: Record<string, string>) => unknown
export type StaticHandler = (req: FastifyRequest, reply: FastifyReply) => unknown
export interface HttpService {
  readonly app: FastifyInstance
  readonly accepting: boolean
  staticFallback(handler: StaticHandler): () => void
  route(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, handler: RouteHandler): () => void
  upgrade(path: string, handler: UpgradeHandler): () => void
  clientIp(req: IncomingMessage): string
  workerTransportAllowed(req: IncomingMessage): boolean
  listen(): Promise<string>
  setReadyCheck(check: () => boolean): void
  setAccepting(accepting: boolean): void
}
