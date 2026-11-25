import type { Actor, ApiTokenView, CreateApiTokenRequest, CreateApiTokenResponse, Principal, Scope, WorkerEnrollRequest } from '@agent-hub/protocol'
export interface ReqMeta { ip: string; userAgent?: string | undefined }
export interface Session { sessionId: string; csrfToken: string; expiresAt: number }
export interface SessionAuth { principal: Principal; csrfToken: string; expiresAt: number; renewed: boolean }
export interface AuthService {
  login(adminToken: string, meta: ReqMeta): Session
  verifySession(cookie: string | undefined, touch?: boolean): SessionAuth | null
  verifyApiToken(bearer: string | undefined, touch?: boolean): Principal | null
  originAllowed(origin?: string): boolean
  verifyMutation(auth: SessionAuth, origin?: string, csrf?: string): void
  logout(sessionId: string): void
  cookie(sessionId: string, expiresAt: number, secure?: boolean): string
  createApiToken(name: string, scopes: Scope[]): string
  issueApiToken(input: CreateApiTokenRequest, actor: Actor): CreateApiTokenResponse
  listApiTokens(): ApiTokenView[]
  revokeApiToken(id: string, actor: Actor): void
  createEnrollToken(actor: Actor, suggestedWorkerId?: string): { token: string; expiresAt: number }
  enroll(input: WorkerEnrollRequest, ip: string): { workerId: string; keyFingerprint: string }
}
