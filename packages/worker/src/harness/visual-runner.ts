import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createRedactor, type Clock } from '@agent-hub/common'
import { projectOf, type RunEvent, type VisualCheckShot } from '@agent-hub/protocol'
import type { VisualTarget, Workspace } from '../config/schema.js'
import { buildEnvironment } from '../security/env.js'
import { resolveWorkspaceSubdir } from '../security/workspace.js'
import { trackVerificationTree } from '../runner/kill-tree.js'
import type { Journal } from '../runner/journal.js'
import { superviseVerification } from './verify-cleanup.js'
import { resolveVerifyCommand } from './verify-runner.js'

const MAX_IMAGE_BYTES = 350_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BODY_STRIP_HEADERS = new Set(['content-length', 'content-type', 'transfer-encoding', 'host', 'connection'])

export interface VisualRouteResponse {
  status(): number
  headers(): Record<string, string>
  dispose?(): Promise<void>
}

export interface VisualRouteLike {
  request(): { url(): string; method?(): string; resourceType?(): string; headers?(): Record<string, string> }
  continue(): Promise<void>
  abort(): Promise<void>
  fetch?(options?: { url?: string; method?: string; postData?: string | Buffer; headers?: Record<string, string>; maxRedirects?: number; timeout?: number }): Promise<VisualRouteResponse>
  fulfill?(options: { response: VisualRouteResponse; headers?: Record<string, string> }): Promise<void>
}

export interface VisualRouteOptions {
  requestFetch?: (url: string, options: { method: string; headers?: Record<string, string>; maxRedirects: number; timeout: number }) => Promise<VisualRouteResponse>
  onDocumentRedirect?: (requestUrl: string, targetUrl: URL) => boolean
}

export async function handleVisualRoute(route: VisualRouteLike, allowedOrigin: string, timeoutMs: number, options?: VisualRouteOptions): Promise<void> {
  let reqUrl: URL
  try {
    reqUrl = new URL(route.request().url())
  } catch {
    await route.abort()
    return
  }
  if (['data:', 'blob:', 'about:'].includes(reqUrl.protocol)) {
    await route.continue()
    return
  }
  if (reqUrl.origin !== allowedOrigin || (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:')) {
    await route.abort()
    return
  }
  if (typeof route.fetch !== 'function' || typeof route.fulfill !== 'function') {
    await route.abort()
    return
  }
  try {
    const allowed = new URL(allowedOrigin)
    const allowedWsOrigin = `${allowed.protocol === 'https:' ? 'wss:' : 'ws:'}//${allowed.host}`
    const confinementCsp = `connect-src ${allowedOrigin} ${allowedWsOrigin} data: blob:; worker-src ${allowedOrigin} blob:`
    let currentUrl = reqUrl
    let method = (route.request().method?.() ?? 'GET').toUpperCase()
    let dropBody = false
    const isDocument = route.request().resourceType?.() === 'document'
    for (let hop = 0; hop <= 5; hop++) {
      let res: VisualRouteResponse
      if (hop === 0) {
        res = await route.fetch({ maxRedirects: 0, timeout: timeoutMs })
      } else if (dropBody) {
        const cleanHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(route.request().headers?.() ?? {})) {
          const lower = k.toLowerCase()
          if (!lower.startsWith(':') && !BODY_STRIP_HEADERS.has(lower)) cleanHeaders[k] = v
        }
        res = options?.requestFetch
          ? await options.requestFetch(currentUrl.toString(), { method, headers: cleanHeaders, maxRedirects: 0, timeout: timeoutMs })
          : await route.fetch({ url: currentUrl.toString(), method, postData: '', headers: cleanHeaders, maxRedirects: 0, timeout: timeoutMs })
      } else {
        res = await route.fetch({ url: currentUrl.toString(), method, maxRedirects: 0, timeout: timeoutMs })
      }
      const status = res.status()
      if (REDIRECT_STATUSES.has(status)) {
        const resHeaders = res.headers()
        const location = resHeaders.location ?? resHeaders.Location
        await res.dispose?.().catch(() => undefined)
        if (!location || hop === 5) {
          await route.abort()
          return
        }
        let target: URL
        try {
          target = new URL(location, currentUrl)
        } catch {
          await route.abort()
          return
        }
        if (target.origin !== allowedOrigin || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
          await route.abort()
          return
        }
        if (isDocument) {
          options?.onDocumentRedirect?.(reqUrl.toString(), target)
          await route.abort()
          return
        }
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          dropBody = true
        }
        currentUrl = target
        continue
      }
      const headers = { ...res.headers() }
      const existingKey = Object.keys(headers).find(k => k.toLowerCase() === 'content-security-policy')
      headers[existingKey ?? 'content-security-policy'] = existingKey
        ? `${headers[existingKey]}, ${confinementCsp}`
        : confinementCsp
      await route.fulfill({ response: res, headers })
      return
    }
    await route.abort()
  } catch {
    await route.abort()
  }
}

export interface VisualWebSocketRouteLike {
  url(): string
  connectToServer(): unknown
  close(options?: { code?: number; reason?: string }): Promise<void>
}

export async function handleVisualWebSocket(ws: VisualWebSocketRouteLike, allowedOrigin: string): Promise<void> {
  try {
    const allowed = new URL(allowedOrigin)
    const wsUrl = new URL(ws.url())
    const matchingScheme = (wsUrl.protocol === 'ws:' && allowed.protocol === 'http:') ||
      (wsUrl.protocol === 'wss:' && allowed.protocol === 'https:')
    if (matchingScheme && wsUrl.host === allowed.host) {
      ws.connectToServer()
      return
    }
  } catch {
    // Block malformed or cross-origin WebSocket URLs.
  }
  await ws.close({ code: 1008, reason: 'Cross-origin WebSocket blocked' }).catch(() => undefined)
}

async function withDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Visual capture aborted')
  if (ms <= 0) throw new Error('Visual capture deadline exceeded')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Visual capture deadline exceeded')), ms)
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Visual capture aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

export interface VisualCaptureInput {
  baseUrl: string
  routes: string[]
  viewport: { width: number; height: number }
  timeoutMs: number
  signal: AbortSignal
}

export interface VisualCaptureShotRaw {
  routeIndex?: number
  route: string
  url: string
  statusCode: number | null
  blankPage: boolean
  consoleErrors: string[]
  pageErrors: string[]
  durationMs: number
  captureFailed?: boolean
  mimeType?: 'image/jpeg' | 'image/png'
  imageBuffer?: Buffer
}

export interface VisualBackend {
  capture(input: VisualCaptureInput): Promise<{ shots: VisualCaptureShotRaw[]; unavailableReason?: string }>
}

export interface VisualRunContext {
  root: string
  runId: string
  clock: Clock
  signal: AbortSignal
  force: AbortSignal
  warn(message: string, code?: string): void
  journal: Pick<Journal, 'process'>
  useJobObject: boolean
  patterns: string[]
  knownSecrets: Record<string, string>
  beginHold?: () => () => void
  onCleanupUnconfirmed?: () => void
}

export function resolveVisualConfig(visual: Workspace['harness']['visual'], subdir?: string): VisualTarget {
  const dir = projectOf(subdir)
  const override = dir ? visual.subdirOverrides[dir] : undefined
  if (!override) return visual
  const url = override.url ?? visual.url
  const startCommand = override.startCommand ?? visual.startCommand
  return {
    enabled: override.enabled ?? visual.enabled,
    routes: override.routes ?? visual.routes,
    viewport: override.viewport ?? visual.viewport,
    captureBefore: override.captureBefore ?? visual.captureBefore,
    startupTimeoutMs: override.startupTimeoutMs ?? visual.startupTimeoutMs,
    captureTimeoutMs: override.captureTimeoutMs ?? visual.captureTimeoutMs,
    failOnConsoleError: override.failOnConsoleError ?? visual.failOnConsoleError,
    failOnPageError: override.failOnPageError ?? visual.failOnPageError,
    failOnBlankPage: override.failOnBlankPage ?? visual.failOnBlankPage,
    ...(url !== undefined && { url }),
    ...(startCommand !== undefined && { startCommand }),
  }
}

async function startVisualConfinementProxy(allowedOrigin: string): Promise<{ port: number; close(): Promise<void> }> {
  const allowed = new URL(allowedOrigin)
  if (allowed.protocol !== 'http:') {
    throw new Error('Visual confinement proxy supports loopback http targets only')
  }
  const allowedPort = Number(allowed.port || 80)
  const allowedConnectHost = allowed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const allowedHostHeader = allowed.host.toLowerCase()
  const allowedHostWithPort = allowed.hostname.startsWith('[') ? `[${allowedConnectHost}]:${allowedPort}` : `${allowedConnectHost}:${allowedPort}`
  const allowedWsOrigin = `ws://${allowed.host}`
  const confinementCsp = `connect-src ${allowedOrigin} ${allowedWsOrigin} data: blob:; worker-src ${allowedOrigin} blob:`
  const sockets = new Set<Socket>()

  const server = createHttpServer((req, res) => {
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(403)
      res.end()
      return
    }
    if (allowed.protocol !== 'http:' || target.protocol !== 'http:' || target.origin !== allowedOrigin) {
      res.writeHead(403)
      res.end()
      return
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: allowed.host }
    delete headers['proxy-connection']
    delete headers['proxy-authorization']
    const upstream = httpRequest({
      hostname: allowedConnectHost,
      port: allowedPort,
      path: target.pathname + target.search,
      method: req.method ?? 'GET',
      headers,
    }, upRes => {
      const status = upRes.statusCode ?? 502
      const locHeader = upRes.headers.location
      const location = Array.isArray(locHeader) ? locHeader[0] : locHeader
      if (REDIRECT_STATUSES.has(status) && location !== undefined) {
        let locUrl: URL | undefined
        try {
          locUrl = new URL(location, target)
        } catch {
          locUrl = undefined
        }
        if (!locUrl || locUrl.protocol !== allowed.protocol || locUrl.origin !== allowedOrigin) {
          upRes.resume()
          res.destroy()
          return
        }
      }
      const respHeaders: Record<string, string | string[] | undefined> = { ...upRes.headers }
      if (!REDIRECT_STATUSES.has(status)) {
        const existingKey = Object.keys(respHeaders).find(k => k.toLowerCase() === 'content-security-policy')
        const existingVal = existingKey ? respHeaders[existingKey] : undefined
        const existingStr = Array.isArray(existingVal) ? existingVal.join(', ') : existingVal
        respHeaders[existingKey ?? 'content-security-policy'] = existingStr
          ? `${existingStr}, ${confinementCsp}`
          : confinementCsp
      }
      res.writeHead(status, respHeaders)
      upRes.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy()
    })
    req.pipe(upstream)
  })

  server.on('connection', sock => {
    sockets.add(sock)
    sock.once('close', () => sockets.delete(sock))
  })

  server.on('connect', (req, clientSock, head) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(req.url ?? '')
    const host = m?.[1]?.replace(/^\[|\]$/gu, '').toLowerCase() ?? ''
    const port = m ? Number(m[2]) : 0
    if (host !== allowedConnectHost || port !== allowedPort) {
      clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSock.destroy()
      return
    }
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let clientBuf = Buffer.from(head)
    let closed = false
    let upstream: Socket | undefined
    const abortTunnel = () => {
      if (closed) return
      closed = true
      clearTimeout(handshakeTimer)
      clientSock.off('data', onClientHandshake)
      upstream?.destroy()
      clientSock.destroy()
    }
    const handshakeTimer = setTimeout(abortTunnel, 5000)
    clientSock.once('error', abortTunnel)
    clientSock.once('close', abortTunnel)

    const inspectClientHandshake = () => {
      if (closed) return
      if (clientBuf.length > 0 && clientBuf[0] === 0x16) {
        abortTunnel()
        return
      }
      if (clientBuf.length > 16 * 1024) {
        abortTunnel()
        return
      }
      const headerEnd = clientBuf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      clientSock.pause()
      clientSock.off('data', onClientHandshake)
      const headerBlock = clientBuf.subarray(0, headerEnd).toString('latin1')
      const lines = headerBlock.split('\r\n')
      const reqMatch = /^GET\s+(\S+)\s+HTTP\/1\.1$/u.exec(lines[0] ?? '')
      if (!reqMatch || !reqMatch[1]!.startsWith('/') || reqMatch[1]!.startsWith('//')) {
        abortTunnel()
        return
      }
      const hdrs: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon <= 0) { abortTunnel(); return }
        const k = line.slice(0, colon).trim().toLowerCase()
        const v = line.slice(colon + 1).trim()
        hdrs[k] = hdrs[k] ? `${hdrs[k]}, ${v}` : v
      }
      const hostHdr = hdrs['host']?.toLowerCase()
      const connTokens = (hdrs['connection'] ?? '').toLowerCase().split(',').map(s => s.trim())
      if (
        (hdrs['upgrade']?.toLowerCase() !== 'websocket') ||
        !connTokens.includes('upgrade') ||
        !hdrs['sec-websocket-key'] ||
        (hostHdr !== allowedHostHeader && hostHdr !== allowedHostWithPort)
      ) {
        abortTunnel()
        return
      }
      const upSock = netConnect(allowedPort, allowedConnectHost, () => {
        if (closed) { upSock.destroy(); return }
        upSock.write(clientBuf)
      })
      upstream = upSock
      sockets.add(upSock)
      upSock.once('close', () => {
        sockets.delete(upSock)
        abortTunnel()
      })
      upSock.once('error', abortTunnel)
      let upBuf = Buffer.alloc(0)
      const onUpstreamHandshake = (chunk: Buffer) => {
        upBuf = Buffer.concat([upBuf, chunk])
        if (upBuf.length > 16 * 1024) { abortTunnel(); return }
        const upEnd = upBuf.indexOf('\r\n\r\n')
        if (upEnd === -1) return
        upSock.off('data', onUpstreamHandshake)
        const upStatusLine = upBuf.subarray(0, upBuf.indexOf('\r\n')).toString('latin1')
        if (!/^HTTP\/1\.1 101\b/iu.test(upStatusLine)) {
          abortTunnel()
          return
        }
        clearTimeout(handshakeTimer)
        clientSock.off('close', abortTunnel)
        upSock.off('close', abortTunnel)
        clientSock.once('close', () => { if (!upSock.destroyed) upSock.destroy() })
        upSock.once('close', () => { if (!clientSock.destroyed) clientSock.destroy() })
        clientSock.write(upBuf)
        upSock.pipe(clientSock)
        clientSock.pipe(upSock)
        clientSock.resume()
      }
      upSock.on('data', onUpstreamHandshake)
    }

    const onClientHandshake = (chunk: Buffer) => {
      clientBuf = Buffer.concat([clientBuf, chunk])
      inspectClientHandshake()
    }
    clientSock.on('data', onClientHandshake)
    if (clientBuf.length) inspectClientHandshake()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: async () => {
      for (const sock of sockets) sock.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const defaultBackend: VisualBackend = {
  async capture(input) {
    let pw: {
      chromium?: {
        launch(opts: Record<string, unknown>): Promise<{
          newContext(opts: Record<string, unknown>): Promise<{
            route?(pattern: string, fn: (route: VisualRouteLike) => Promise<void> | void): Promise<void>
            routeWebSocket?(pattern: string | RegExp, fn: (ws: VisualWebSocketRouteLike) => Promise<void> | void): Promise<void>
            on?(event: string, fn: (arg: unknown) => void): void
            newPage(): Promise<{
              setDefaultTimeout(ms: number): void
              on(event: string, fn: (arg: unknown) => void): void
              route?(pattern: string, fn: (route: VisualRouteLike) => Promise<void> | void): Promise<void>
              url?(): string
              opener?(): Promise<unknown>
              goto(url: string, opts: Record<string, unknown>): Promise<{ status(): number } | null>
              waitForTimeout(ms: number): Promise<void>
              evaluate<T>(fn: () => T): Promise<T>
              screenshot(opts: Record<string, unknown>): Promise<Buffer>
              close(): Promise<void>
            }>
            close(): Promise<void>
          }>
          close(): Promise<void>
        }>
      }
    }
    try {
      const mod = ['play', 'wright'].join('')
      pw = (await import(mod)) as typeof pw
    } catch {
      return { shots: [], unavailableReason: 'VISUAL_UNAVAILABLE' }
    }
    if (!pw.chromium) return { shots: [], unavailableReason: 'VISUAL_UNAVAILABLE' }
    const allowedOrigin = new URL(input.baseUrl).origin
    const proxy = await startVisualConfinementProxy(allowedOrigin)
    let browser: Awaited<ReturnType<NonNullable<typeof pw.chromium>['launch']>> | undefined
    const shots: VisualCaptureShotRaw[] = []
    const plannedRoutes = input.routes.slice(0, 6)
    const overallDeadline = Date.now() + input.timeoutMs * Math.max(1, plannedRoutes.length)
    const recordMissingShots = (msg: string) => {
      for (const [idx, route] of plannedRoutes.entries()) {
        if (shots.some(s => s.routeIndex === idx)) continue
        shots.push({
          routeIndex: idx,
          route,
          url: input.baseUrl.slice(0, 512),
          statusCode: null,
          blankPage: true,
          consoleErrors: [],
          pageErrors: [msg],
          durationMs: 0,
          captureFailed: true,
        })
      }
    }
    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=LocalNetworkAccessChecks',
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        '--proxy-bypass-list=<-loopback>',
      ],
    }
    let onAbort: (() => void) | undefined
    try {
      for (const opts of [launchOpts, { ...launchOpts, channel: 'chrome' }, { ...launchOpts, channel: 'msedge' }]) {
        try {
          browser = await pw.chromium.launch(opts)
          break
        } catch {
          browser = undefined
        }
      }
      if (!browser) return { shots: [], unavailableReason: 'VISUAL_UNAVAILABLE' }
      onAbort = () => { void browser?.close().catch(() => undefined) }
      input.signal.addEventListener('abort', onAbort, { once: true })
      const context = await browser.newContext({ viewport: input.viewport, serviceWorkers: 'block' })
      try {
        if (typeof context.routeWebSocket !== 'function') {
          return { shots: [], unavailableReason: 'VISUAL_UNAVAILABLE' }
        }
        context.on?.('page', pageArg => {
          const pg = pageArg as { opener?(): Promise<unknown>; close?(): Promise<void> }
          if (typeof pg.opener === 'function') {
            void pg.opener().then(opener => {
              if (opener) return pg.close?.()
            }).catch(() => undefined)
          }
        })
        await context.routeWebSocket(/.*/, ws => handleVisualWebSocket(ws, allowedOrigin))
        for (const [idx, route] of plannedRoutes.entries()) {
          if (input.signal.aborted || Date.now() >= overallDeadline) {
            shots.push({
              routeIndex: idx,
              route,
              url: input.baseUrl.slice(0, 512),
              statusCode: null,
              blankPage: true,
              consoleErrors: [],
              pageErrors: [input.signal.aborted ? 'Visual capture aborted' : 'Visual capture deadline exceeded'],
              durationMs: 0,
              captureFailed: true,
            })
            continue
          }
          let targetUrl: URL
          try {
            targetUrl = new URL(route, input.baseUrl)
          } catch {
            shots.push({
              routeIndex: idx, route, url: input.baseUrl.slice(0, 512), statusCode: null, blankPage: true,
              consoleErrors: [], pageErrors: ['Invalid visual route'], durationMs: 0, captureFailed: true,
            })
            continue
          }
          if (targetUrl.origin !== allowedOrigin || (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:')) {
            shots.push({
              routeIndex: idx, route, url: targetUrl.toString().slice(0, 512), statusCode: null, blankPage: true,
              consoleErrors: [], pageErrors: ['Visual route leaves configured loopback origin'], durationMs: 0, captureFailed: true,
            })
            continue
          }
          const remainingMs = () => Math.min(input.timeoutMs, Math.max(1, overallDeadline - Date.now()))
          const consoleErrors: string[] = []
          const pageErrors: string[] = []
          const started = Date.now()
          let statusCode: number | null = null
          let blankPage = true
          let imageBuffer: Buffer | undefined
          let captureFailed = false
          let finalUrl = targetUrl.toString()
          let page: Awaited<ReturnType<typeof context.newPage>> | undefined
          try {
            page = await context.newPage()
            page.setDefaultTimeout(Math.max(1000, remainingMs()))
            page.on('popup', popup => {
              void (popup as { close?(): Promise<void> }).close?.().catch(() => undefined)
            })
            page.on('console', msg => {
              const m = msg as { type?(): string; text?(): string }
              if (m.type?.() === 'error' && consoleErrors.length < 25) consoleErrors.push(String(m.text?.() ?? '').slice(0, 4096))
            })
            page.on('pageerror', err => {
              if (pageErrors.length < 25) pageErrors.push(String(err instanceof Error ? err.message : err).slice(0, 4096))
            })
            const resp = await withDeadline(page.goto(targetUrl.toString(), {
              waitUntil: 'domcontentloaded',
              timeout: Math.max(1000, remainingMs()),
            }), remainingMs(), input.signal)
            const landedUrl = page.url?.()
            if (landedUrl) {
              const landedOrigin = new URL(landedUrl).origin
              if (landedOrigin !== allowedOrigin) throw new Error('Cross-origin navigation blocked')
              finalUrl = landedUrl
            }
            statusCode = resp?.status() ?? null
            await withDeadline(page.waitForTimeout(Math.min(350, remainingMs())), remainingMs(), input.signal)
            blankPage = await withDeadline(page.evaluate(() => {
              const doc = (globalThis as { document?: { body?: { innerText?: string; querySelector?: (s: string) => unknown } } }).document
              const text = doc?.body?.innerText?.trim() ?? ''
              const hasMedia = !!doc?.body?.querySelector?.('canvas,svg,img,video')
              return !text.length && !hasMedia
            }), remainingMs(), input.signal)
            let buf = await withDeadline(page.screenshot({ type: 'jpeg', quality: 75, fullPage: true }), remainingMs(), input.signal)
            if (buf.length > MAX_IMAGE_BYTES) {
              buf = await withDeadline(page.screenshot({ type: 'jpeg', quality: 45, fullPage: true }), remainingMs(), input.signal)
            }
            if (buf.length <= MAX_IMAGE_BYTES) imageBuffer = buf
          } catch (err) {
            captureFailed = true
            statusCode = null
            imageBuffer = undefined
            pageErrors.push(err instanceof Error ? err.message.slice(0, 4096) : 'Navigation failed')
          } finally {
            await page?.close().catch(() => undefined)
          }
          shots.push({
            routeIndex: idx,
            route, url: finalUrl.slice(0, 512), statusCode, blankPage, consoleErrors, pageErrors,
            durationMs: Math.max(0, Date.now() - started),
            ...(captureFailed && { captureFailed: true }),
            ...(imageBuffer && { mimeType: 'image/jpeg' as const, imageBuffer }),
          })
        }
      } catch (err) {
        recordMissingShots(err instanceof Error ? err.message.slice(0, 4096) : 'Visual capture failed')
      } finally {
        await context.close().catch(() => undefined)
      }
    } catch (err) {
      recordMissingShots(err instanceof Error ? err.message.slice(0, 4096) : 'Visual context creation failed')
    } finally {
      if (onAbort) input.signal.removeEventListener('abort', onAbort)
      await browser?.close().catch(() => undefined)
      await proxy.close().catch(() => undefined)
    }
    return { shots }
  },
}

async function isReachable(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
    await res.body?.cancel().catch(() => undefined)
    return res.status < 500
  } catch {
    return false
  }
}

export const MISSING_ROUTE_ERROR = 'Visual route missing from capture result'

export function isVisualShotFailed(shot: VisualCheckShot, config: VisualTarget): boolean {
  return shot.statusCode === null ||
    shot.pageErrors.includes(MISSING_ROUTE_ERROR) ||
    shot.statusCode >= 500 ||
    (config.failOnBlankPage && shot.blankPage) ||
    (config.failOnConsoleError && shot.consoleErrors.length > 0) ||
    (config.failOnPageError && shot.pageErrors.length > 0)
}

export async function runVisualCheck(
  ctx: VisualRunContext,
  config: VisualTarget,
  phase: 'before' | 'after',
  backend: VisualBackend = defaultBackend,
): Promise<Omit<Extract<RunEvent, { kind: 'visual' }>, 'seq' | 'ts'>> {
  if (!config.enabled || !config.url) {
    return { kind: 'visual', phase, status: 'skipped', reason: 'NOT_CONFIGURED', shots: [] }
  }
  const serverBuild = config.startCommand ? buildEnvironment(process.env, config.startCommand) : undefined
  const mergedSecrets: Record<string, string> = { ...ctx.knownSecrets }
  if (serverBuild) {
    let seq = 0
    for (const [k, v] of Object.entries(serverBuild.knownSecrets)) {
      if (!v) continue
      let key = k
      while (Object.prototype.hasOwnProperty.call(mergedSecrets, key)) {
        key = `${k}_VISUAL_${seq++}`
      }
      mergedSecrets[key] = v
    }
  }
  const stopServerAbort = new AbortController()
  let serverTerminal: Promise<{ cleanupConfirmed?: boolean }> | undefined
  let confirmHold: (() => void) | undefined
  let captureStarted = false
  const scrub = createRedactor(mergedSecrets, ctx.patterns)
  const expectedRoutes = config.routes.slice(0, 6)
  try {
    const alreadyUp = await isReachable(config.url, ctx.signal)
    if (!alreadyUp && config.startCommand && serverBuild) {
      const cmd = config.startCommand
      const resolved = resolveVerifyCommand(cmd.argv[0]!)
      if (resolved.status !== 'ready') {
        return { kind: 'visual', phase, status: 'skipped', reason: 'SERVER_EXE_MISSING', shots: [] }
      }
      const cwd = resolveWorkspaceSubdir(ctx.root, cmd.cwd)
      confirmHold = ctx.beginHold?.()
      const child = (() => {
        try {
          return spawn(resolved.exe.command, [...resolved.exe.prefixArgs, ...cmd.argv.slice(1)], {
            cwd, env: serverBuild.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', shell: false,
          })
        } catch {
          return undefined
        }
      })()
      if (!child?.pid) {
        if (child) {
          child.once('error', () => undefined)
          child.stdout.destroy()
          child.stderr.destroy()
        }
        confirmHold?.()
        confirmHold = undefined
        return { kind: 'visual', phase, status: 'skipped', reason: 'SERVER_START_FAILED', shots: [] }
      }
      child.stdout.resume()
      child.stderr.resume()
      try {
        const tree = trackVerificationTree(child, ctx.useJobObject, () =>
          ctx.warn('Windows Job Object unavailable for visual server cleanup', 'PROCESS_TREE_FALLBACK'))
        serverTerminal = superviseVerification(child, tree, AbortSignal.any([ctx.signal, stopServerAbort.signal]), ctx.force)
        try {
          ctx.journal.process({ runId: ctx.runId, role: 'verify', pid: child.pid, ...(tree.startTime && { pidStartTime: tree.startTime }) })
        } catch {
          ctx.warn('Visual server journal write failed')
        }
      } catch (err) {
        try { child.kill('SIGKILL') } catch { /* Ignore kill failure */ }
        if (confirmHold) ctx.onCleanupUnconfirmed?.()
        confirmHold = undefined
        throw err
      }
      const waitUntil = ctx.clock.monotonic() + Math.min(config.startupTimeoutMs, cmd.timeoutMs)
      let ready = false
      while (!ctx.signal.aborted && ctx.clock.monotonic() < waitUntil) {
        if (child.exitCode !== null || child.signalCode !== null) break
        if (await isReachable(config.url, ctx.signal)) { ready = true; break }
        await delay(250, undefined, { signal: ctx.signal }).catch(() => undefined)
      }
      if (!ready) {
        return { kind: 'visual', phase, status: 'skipped', reason: 'SERVER_NOT_READY', shots: [] }
      }
    }
    captureStarted = true
    const { shots: rawShots, unavailableReason } = await backend.capture({
      baseUrl: config.url,
      routes: expectedRoutes,
      viewport: config.viewport,
      timeoutMs: config.captureTimeoutMs,
      signal: ctx.signal,
    })
    if (unavailableReason) {
      return { kind: 'visual', phase, status: 'skipped', reason: unavailableReason, shots: [] }
    }
    const rawSlice = rawShots.slice(0, 6)
    const seenIndices = new Set<number>()
    const resolvedShotIndices = rawSlice.map(shot => {
      if (shot.routeIndex !== undefined && shot.routeIndex >= 0 && shot.routeIndex < expectedRoutes.length) {
        seenIndices.add(shot.routeIndex)
        return shot.routeIndex
      }
      const matched = expectedRoutes.findIndex((r, idx) => r === shot.route && !seenIndices.has(idx))
      if (matched >= 0) {
        seenIndices.add(matched)
        return matched
      }
      return undefined
    })
    const missingAny = expectedRoutes.some((_, idx) => !seenIndices.has(idx))
    const incompleteAny = missingAny || rawSlice.some(s => s.captureFailed || s.statusCode === null)
    const shots: VisualCheckShot[] = rawSlice.map((shot, i) => ({
      ...(resolvedShotIndices[i] !== undefined && { routeIndex: resolvedShotIndices[i] }),
      route: scrub(shot.route).slice(0, 256),
      url: scrub(shot.url).slice(0, 512),
      statusCode: shot.statusCode,
      blankPage: shot.blankPage,
      consoleErrors: shot.consoleErrors.map(line => scrub(line).slice(0, 500)).slice(0, 20),
      pageErrors: shot.pageErrors.map(line => scrub(line).slice(0, 500)).slice(0, 20),
      durationMs: shot.durationMs,
      ...(shot.imageBuffer && shot.mimeType && {
        mimeType: shot.mimeType,
        imageBase64: shot.imageBuffer.toString('base64'),
      }),
    }))
    for (const [idx, missingRoute] of expectedRoutes.entries()) {
      if (seenIndices.has(idx) || shots.length >= 6) continue
      shots.push({
        routeIndex: idx,
        route: scrub(missingRoute).slice(0, 256),
        url: scrub(new URL(missingRoute, config.url).toString()).slice(0, 512),
        statusCode: null,
        blankPage: true,
        consoleErrors: [],
        pageErrors: [MISSING_ROUTE_ERROR],
        durationMs: 0,
      })
    }
    const failed = incompleteAny || shots.some(shot => isVisualShotFailed(shot, config))
    const reason = missingAny ? 'ROUTES_MISSING' : incompleteAny ? 'CAPTURE_INCOMPLETE' : undefined
    return { kind: 'visual', phase, status: failed ? 'failed' : 'passed', ...(reason && { reason }), shots }
  } catch (err) {
    if (captureStarted) {
      const msg = scrub(err instanceof Error ? err.message : 'Visual capture failed').slice(0, 500)
      return {
        kind: 'visual',
        phase,
        status: 'failed',
        reason: 'CAPTURE_INCOMPLETE',
        shots: expectedRoutes.map((route, idx) => ({
          routeIndex: idx,
          route: scrub(route).slice(0, 256),
          url: scrub(new URL(route, config.url).toString()).slice(0, 512),
          statusCode: null,
          blankPage: true,
          consoleErrors: [],
          pageErrors: [msg],
          durationMs: 0,
        })),
      }
    }
    return { kind: 'visual', phase, status: 'skipped', reason: 'VISUAL_ERROR', shots: [] }
  } finally {
    if (serverTerminal) {
      stopServerAbort.abort()
      const term = await serverTerminal.catch(() => undefined)
      if (term?.cleanupConfirmed) confirmHold?.()
      else if (confirmHold) ctx.onCleanupUnconfirmed?.()
    } else {
      confirmHold?.()
    }
  }
}

export function visualFailureTail(event: Extract<RunEvent, { kind: 'visual' }>): string {
  const lines: string[] = []
  for (const shot of event.shots) {
    if (shot.statusCode && shot.statusCode >= 500) lines.push(`${shot.route}: HTTP ${shot.statusCode}`)
    if (shot.blankPage) lines.push(`${shot.route}: blank page rendered (no text/canvas/svg/img)`)
    for (const err of shot.consoleErrors.slice(0, 5)) lines.push(`${shot.route} [console.error]: ${err}`)
    for (const err of shot.pageErrors.slice(0, 5)) lines.push(`${shot.route} [pageerror]: ${err}`)
  }
  return lines.join('\n').slice(0, 4096)
}
