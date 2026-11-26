import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { FakeClock, runId, taskId } from '@agent-hub/common'
import { RunAttachment, RunDispatch, RunEvent } from '@agent-hub/protocol'
import type { HarnessDirective } from '@agent-hub/protocol'
import { WorkerConfigSchema } from '../src/config/schema.js'
import { downgradeEvent } from '../src/harness/downgrade.js'
import { diffManifest, scanManifest } from '../src/harness/manifest.js'
import { sensitivePaths, commandFilePaths, inspectCommandFiles, inspectCommands } from '../src/harness/tamper.js'
import { resolveVerifyCommand } from '../src/harness/verify-runner.js'
import { handleVisualRoute, handleVisualWebSocket, resolveVisualConfig, runVisualCheck, visualFailureTail, type VisualBackend } from '../src/harness/visual-runner.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import { Journal } from '../src/runner/journal.js'
import { RunManager } from '../src/runner/run-manager.js'
import { RunOutbox } from '../src/tunnel/outbox.js'

describe('visual harness & inbound attachment staging', () => {
  let base: string
  let root: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'visual-harness-'))
    root = join(base, 'workspace')
    mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('validates loopback URLs, P17 shell restrictions, and merges subdirOverrides', () => {
    const parsed = WorkerConfigSchema.parse({
      workerId: 'w-vis',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          visual: {
            enabled: false,
            url: 'http://127.0.0.1:4173',
            routes: ['/'],
            subdirOverrides: {
              Forma: { enabled: true, routes: ['/board', '/editor'] },
            },
          },
        },
      }],
    })
    const formaVisual = resolveVisualConfig(parsed.workspaces[0]!.harness.visual, 'Forma')
    expect(formaVisual.enabled).toBe(true)
    expect(formaVisual.url).toBe('http://127.0.0.1:4173')
    expect(formaVisual.routes).toEqual(['/board', '/editor'])

    expect(() => WorkerConfigSchema.parse({
      workerId: 'w-vis',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        harness: { visual: { enabled: true, url: 'http://example.com' } },
      }],
    })).toThrow()

    expect(() => WorkerConfigSchema.parse({
      workerId: 'w-vis',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        harness: { visual: { enabled: true, url: 'https://127.0.0.1:4443' } },
      }],
    })).toThrow(/loopback http/u)

    expect(() => WorkerConfigSchema.parse({
      workerId: 'w-vis',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        harness: {
          visual: {
            enabled: true,
            url: 'http://127.0.0.1:4173',
            startCommand: { argv: ['pwsh', '-c', 'echo hi'] },
          },
        },
      }],
    })).toThrow('VERIFY_SHELL_FORBIDDEN')
  })

  it('redacts secrets, flags blank/console failures, and gracefully skips when playwright is unavailable', async () => {
    const clock = new FakeClock(1000)
    const ctx = {
      root,
      runId: runId(),
      clock,
      signal: new AbortController().signal,
      force: new AbortController().signal,
      warn: () => undefined,
      journal: { process: () => undefined },
      useJobObject: process.platform === 'win32',
      patterns: [],
      knownSecrets: { MY_API_SECRET: 'super-secret-xyz' },
    }
    const cfg = WorkerConfigSchema.parse({
      workerId: 'w-vis',
      hub: { url: 'ws://127.0.0.1:9' },
      workspaces: [{
        id: 'app', path: root, label: 'App', maxProfile: 'full', allowedAdapters: ['mock'],
        harness: { visual: { enabled: true, url: 'http://127.0.0.1:4179', routes: ['/'] } },
      }],
    }).workspaces[0]!.harness.visual

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const targetCfg = { ...cfg, url: `http://127.0.0.1:${port}` }
    try {
      const failBackend: VisualBackend = {
        async capture() {
          return {
            shots: [{
              route: '/',
              url: `${targetCfg.url}/`,
              statusCode: 200,
              blankPage: true,
              consoleErrors: ['leaked super-secret-xyz in console'],
              pageErrors: [],
              durationMs: 42,
              mimeType: 'image/jpeg',
              imageBuffer: Buffer.from('jpeg-fake'),
            }],
          }
        },
      }
      const failed = await runVisualCheck(ctx, targetCfg, 'after', failBackend)
      expect(failed.status).toBe('failed')
      expect(failed.shots[0]!.consoleErrors[0]).not.toContain('super-secret-xyz')
      expect(visualFailureTail({ seq: 1, ts: 1000, ...failed })).toContain('blank page rendered')

      const unavailableBackend: VisualBackend = {
        async capture() {
          return { shots: [], unavailableReason: 'VISUAL_UNAVAILABLE' }
        },
      }
      const skipped = await runVisualCheck(ctx, targetCfg, 'after', unavailableBackend)
      expect(skipped).toMatchObject({ kind: 'visual', phase: 'after', status: 'skipped', reason: 'VISUAL_UNAVAILABLE' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('starts a loopback dev server via startCommand and cleans up the server process tree after capture', async () => {
    const clock = new FakeClock(1000)
    const portProbe = createServer()
    await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve))
    const port = (portProbe.address() as AddressInfo).port
    await new Promise<void>(resolve => portProbe.close(() => resolve()))

    let spawnedPid = 0
    const serverScript = [
      'const http = require("node:http");',
      'const s = http.createServer((_req, res) => { res.writeHead(200); res.end("hello"); });',
      `s.listen(${port}, "127.0.0.1", () => console.log("PID:" + process.pid));`,
      'setInterval(() => {}, 10000);',
    ].join(' ')

    const cfg = WorkerConfigSchema.parse({
      workerId: 'w-srv',
      hub: { url: 'ws://127.0.0.1:9' },
      workspaces: [{
        id: 'app', path: root, label: 'App', maxProfile: 'full', allowedAdapters: ['mock'],
        harness: {
          visual: {
            enabled: true,
            url: `http://127.0.0.1:${port}`,
            routes: ['/'],
            startupTimeoutMs: 10_000,
            startCommand: { argv: [process.execPath, '-e', serverScript] },
          },
        },
      }],
    }).workspaces[0]!.harness.visual

    const ctx = {
      root,
      runId: runId(),
      clock,
      signal: new AbortController().signal,
      force: new AbortController().signal,
      warn: () => undefined,
      journal: {
        process(entry: { pid: number }) { spawnedPid = entry.pid },
      },
      useJobObject: process.platform === 'win32',
      patterns: [],
      knownSecrets: {},
    }
    const okBackend: VisualBackend = {
      async capture({ baseUrl, routes }) {
        const res = await fetch(new URL(routes[0]!, baseUrl))
        const body = await res.text()
        expect(body).toBe('hello')
        return {
          shots: [{
            route: '/', url: baseUrl + '/', statusCode: res.status, blankPage: false,
            consoleErrors: [], pageErrors: [], durationMs: 15, mimeType: 'image/jpeg', imageBuffer: Buffer.from('img'),
          }],
        }
      },
    }
    const result = await runVisualCheck(ctx, cfg, 'after', okBackend)
    expect(result.status).toBe('passed')
    expect(spawnedPid).toBeGreaterThan(0)
    // Confirm the supervised dev server process actually terminated
    await expect(fetch(`http://127.0.0.1:${port}`).catch(() => 'closed')).resolves.toBe('closed')
  }, 15_000)

  it('stages inbound attachments inside tempDir, emits before/after visual events, and triggers autofix on visual failure', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const tempRoot = join(base, 'run-temp')
    const clock = new FakeClock(1000)
    const c = WorkerConfigSchema.parse({
      workerId: 'test-worker',
      hub: { url: 'ws://127.0.0.1:9999' },
      adapters: { mock: { enabled: true } },
      harness: { enabled: true },
      workspaces: [{
        id: 'repo',
        path: root,
        label: 'Repo',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          blackboard: true,
          visual: { enabled: true, url: `http://127.0.0.1:${port}`, routes: ['/'] },
        },
      }],
    })
    const registry = new AdapterRegistry(c)
    await registry.probe(['mock'])

    let afterCalls = 0
    const backend: VisualBackend = {
      async capture({ baseUrl }) {
        afterCalls++
        // Call 1 = before, Call 2 = after round 0 (fail -> autofix), Call 3 = after round 1 (pass)
        const failRound0 = afterCalls === 2
        return {
          shots: [{
            route: '/',
            url: baseUrl + '/',
            statusCode: 200,
            blankPage: false,
            consoleErrors: failRound0 ? ['TypeError: chart container null'] : [],
            pageErrors: [],
            durationMs: 20,
            mimeType: 'image/jpeg',
            imageBuffer: Buffer.from(`shot-${afterCalls}`),
          }],
        }
      },
    }

    const manager = new RunManager(c, registry, clock, new Journal(join(base, 'journal'), clock), join(base, 'logs'), () => undefined, tempRoot, backend)
    const events: RunEvent[] = []
    manager.outbox.attach(frame => {
      if (frame.type === 'run.events') events.push(...frame.payload.events.map(e => RunEvent.parse(e)))
      return true
    }, 1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1', 'visual.v1'])

    try {
      const directive: HarnessDirective = {
        v: 1, trust: 'owner', board: 'write', inject: 'fresh', bootstrap: false,
        verify: { autoFixMaxRetries: 1 },
      }
      const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'ui.txt', content: 'v1' }])).toString('base64url')
      const fixOps = Buffer.from(JSON.stringify([{ op: 'write', path: 'ui.txt', content: 'v2' }])).toString('base64url')
      const cmd = RunDispatch.parse({
        runId: runId(),
        taskId: taskId(),
        taskNo: 1,
        attempt: 1,
        workspaceId: 'repo',
        adapter: 'mock',
        profile: 'edit',
        prompt: `#scenario:fs harness=1 ops=${ops} fixOps=${fixOps}\nfix layout`,
        attachments: [RunAttachment.parse({
          id: 'art_' + '0'.repeat(26),
          kind: 'image',
          name: 'mockup.png',
          mimeType: 'image/png',
          encoding: 'base64',
          data: Buffer.from('png-data').toString('base64'),
        })],
        timeoutMs: 300_000,
        idleTimeoutMs: 20_000,
        notAfter: 300_000,
        origin: { source: 'dashboard', actorType: 'owner' },
        harness: directive,
      })

      manager.accept(cmd, 1000)()
      await manager.awaitRuns()

      const visuals = events.filter((e): e is Extract<RunEvent, { kind: 'visual' }> => e.kind === 'visual')
      expect(visuals.map(v => `${v.phase}:${v.status}`)).toEqual(['before:passed', 'after:failed', 'after:passed'])

      const fin = events.find((e): e is Extract<RunEvent, { kind: 'finished' }> => e.kind === 'finished')
      expect(fin?.status).toBe('succeeded')
      expect(fin?.verification?.status).toBe('passed')
      expect(fin?.verification?.autoFix).toEqual({ attempts: 1, stoppedBy: 'PASSED' })

      // Attachment was NOT leaked into workspace root and tempDir was cleaned up after run
      expect(existsSync(join(root, 'mockup.png'))).toBe(false)
      expect(readdirSync(tempRoot)).toEqual([])
    } finally {
      manager.cancelAll()
      await manager.awaitRuns()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 20_000)

  it('guards visual startCommand paths via tamper manifest, rejects protocol-relative routes, clamps >20 pageErrors, redacts server secrets, and downgrades visual events without visual.v1', async () => {
    const startScript = join(root, 'scripts', 'preview.mjs')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(startScript, 'console.log("hi")')

    const parsed = WorkerConfigSchema.parse({
      workerId: 'w-sec',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          visual: {
            enabled: true,
            url: 'http://127.0.0.1:4173',
            startCommand: { argv: [process.execPath, 'scripts/preview.mjs'] },
          },
        },
      }],
    })
    const sensitive = sensitivePaths(root, parsed.workspaces[0]!.harness)
    expect(sensitive('scripts/preview.mjs')).toBe(true)

    expect(() => WorkerConfigSchema.parse({
      workerId: 'w-sec',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: { visual: { enabled: true, url: 'http://127.0.0.1:4173', routes: ['//evil.example/x'] } },
      }],
    })).toThrow()

    const clock = new FakeClock(5000)
    const errors = Array.from({ length: 25 }, (_, i) => `err-${i} with SECRET_XYZ`)
    let holdEnded = false
    const result = await runVisualCheck({
      root,
      runId: runId(),
      clock,
      signal: new AbortController().signal,
      force: new AbortController().signal,
      warn: () => undefined,
      journal: { process: () => undefined },
      useJobObject: false,
      patterns: [],
      knownSecrets: { TOKEN: 'SECRET_XYZ' },
      beginHold: () => () => { holdEnded = true },
    }, {
      enabled: true,
      url: 'http://127.0.0.1:59999',
      routes: ['/'],
      viewport: { width: 800, height: 600 },
      captureBefore: false,
      startupTimeoutMs: 1000,
      captureTimeoutMs: 5000,
      failOnConsoleError: false,
      failOnPageError: true,
      failOnBlankPage: true,
    }, 'after', {
      capture: async () => ({
        shots: [{
          route: '/',
          url: 'http://127.0.0.1:59999/',
          statusCode: 200,
          blankPage: false,
          consoleErrors: [],
          pageErrors: errors,
          durationMs: 5,
        }],
      }),
    })
    expect(holdEnded).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.shots[0]?.pageErrors).toHaveLength(20)
    expect(result.shots[0]?.pageErrors[0]).not.toContain('SECRET_XYZ')

    const fullVisual: RunEvent = {
      kind: 'visual',
      seq: 2,
      ts: 5001,
      phase: 'after',
      status: 'passed',
      shots: [{
        route: '/',
        url: 'http://127.0.0.1:59999/',
        statusCode: 200,
        blankPage: false,
        consoleErrors: [],
        pageErrors: [],
        durationMs: 5,
      }],
    }
    expect(downgradeEvent(fullVisual, ['blackboard.v1', 'verify.v1'])).toEqual({
      kind: 'progress',
      seq: 2,
      ts: 5001,
      phase: 'visual.after',
      detail: 'passed',
    })
    expect(downgradeEvent(fullVisual, ['blackboard.v1', 'verify.v1', 'visual.v1'])).toBe(fullVisual)
  })

  it('splits multi-route visual captures into per-route events and caps visual-only autoFix retries by directive setting', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<main>ok</main>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const clock = new FakeClock(1000)
    const c = WorkerConfigSchema.parse({
      workerId: 'w-vis-2',
      hub: { url: 'ws://127.0.0.1:9999' },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'repo',
        path: root,
        label: 'Repo',
        maxProfile: 'edit',
        allowedAdapters: ['mock'],
        harness: {
          visual: { enabled: true, url: `http://127.0.0.1:${port}`, routes: ['/a', '/b'], captureBefore: false },
        },
      }],
    })
    const tempRoot = join(base, 'temp')
    const registry = new AdapterRegistry(c)
    await registry.probe(['mock'])
    const manager = new RunManager(
      c,
      registry,
      clock,
      new Journal(join(base, 'journal2'), clock),
      join(base, 'logs2'),
      () => undefined,
      tempRoot,
      {
        capture: async ({ routes, baseUrl }) => ({
          shots: routes.map(route => ({
            route,
            url: baseUrl + route,
            statusCode: 200,
            blankPage: route === '/b',
            consoleErrors: [],
            pageErrors: [],
            durationMs: 10,
            mimeType: 'image/jpeg',
            imageBuffer: Buffer.from(`img-${route}`),
          })),
        }),
      },
    )
    const events: RunEvent[] = []
    manager.outbox.attach(frame => {
      if (frame.type === 'run.events') events.push(...frame.payload.events.map(e => RunEvent.parse(e)))
      return true
    }, 1 << 20, 4 << 20, ['blackboard.v1', 'verify.v1', 'visual.v1'])

    try {
      const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'app.txt', content: 'v1' }])).toString('base64url')
      const cmd = RunDispatch.parse({
        runId: runId(),
        taskId: taskId(),
        taskNo: 1,
        attempt: 1,
        workspaceId: 'repo',
        adapter: 'mock',
        profile: 'edit',
        prompt: `#scenario:fs harness=1 ops=${ops}\nrender routes`,
        timeoutMs: 300_000,
        idleTimeoutMs: 20_000,
        notAfter: 300_000,
        origin: { source: 'dashboard', actorType: 'owner' },
        harness: { v: 1, trust: 'owner', board: 'write', inject: 'fresh', bootstrap: false, verify: { autoFixMaxRetries: 0 } },
      })
      manager.accept(cmd, 1000)()
      await manager.awaitRuns()

      const visuals = events.filter((e): e is Extract<RunEvent, { kind: 'visual' }> => e.kind === 'visual')
      expect(visuals.map(v => `${v.shots[0]?.route}:${v.status}`)).toEqual(['/a:passed', '/b:failed'])
      const fin = events.find((e): e is Extract<RunEvent, { kind: 'finished' }> => e.kind === 'finished')
      expect(fin?.verification?.status).toBe('failed')
      expect(fin?.verification?.autoFix).toBeUndefined()
    } finally {
      manager.cancelAll()
      await manager.awaitRuns()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 20_000)

  it('pins visual startCommand scripts inside excluded dirs (P0 #1), enforces redirect/route/secret/deadline bounds (P1 #1/#4/#5/#6/#13), preserves subdir overrides (P2 #1), and keeps visual metadata on small frames (P2 #2)', async () => {
    // P0 #1: startCommand file inside dist/ and manifest.exclude MUST still have a hashed baseline & trigger tamper on edit
    mkdirSync(join(root, 'dist'), { recursive: true })
    const excludedScript = join(root, 'dist', 'preview.mjs')
    writeFileSync(excludedScript, 'console.log("v1")')
    const cfg = WorkerConfigSchema.parse({
      workerId: 'w-p0',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          manifest: { exclude: ['dist/**'] },
          visual: {
            enabled: true,
            url: 'http://127.0.0.1:4173',
            routes: ['/'],
            startCommand: { argv: [process.execPath, 'dist/preview.mjs'] },
            subdirOverrides: {
              // P2 #1: omitted fields in subdirOverrides must NOT override workspace enabled=true to false
              web: { routes: ['/web'] },
            },
          },
        },
      }],
    })
    const harnessCfg = cfg.workspaces[0]!.harness
    expect(resolveVisualConfig(harnessCfg.visual, 'web').enabled).toBe(true)
    expect(resolveVisualConfig(harnessCfg.visual, 'web').routes).toEqual(['/web'])

    const pinned = commandFilePaths(root, harnessCfg)
    expect(pinned).toContain('dist/preview.mjs')
    const sens = sensitivePaths(root, harnessCfg)
    const pre = await scanManifest(root, harnessCfg.manifest, sens, pinned)
    writeFileSync(excludedScript, 'console.log("pwned")')
    const post = await scanManifest(root, harnessCfg.manifest, sens, pinned)
    const diff = diffManifest(pre, post, sens)
    expect(diff.tamper.total).toBeGreaterThanOrEqual(1)
    expect(diff.tamper.paths).toContain('dist/preview.mjs')

    // P1 #13: Unicode route expanding URL > 512 chars rejected at config schema parse
    const longUnicodeRoute = '/' + '中'.repeat(180)
    expect(() => WorkerConfigSchema.parse({
      workerId: 'w-url',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app', path: root, label: 'App', maxProfile: 'edit', allowedAdapters: ['mock'],
        harness: { visual: { enabled: true, url: 'http://127.0.0.1:4173', routes: [longUnicodeRoute] } },
      }],
    })).toThrow()

    // P1 #1: handleVisualRoute aborts cross-origin requests and cross-origin 302 redirects without following
    let aborted = 0
    let continued = 0
    let fulfilled = 0
    await handleVisualRoute({
      request: () => ({ url: () => 'https://evil.example/steal' }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
    }, 'http://127.0.0.1:4173', 2000)
    await handleVisualRoute({
      request: () => ({ url: () => 'http://127.0.0.1:4173/redirect' }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
      fetch: async () => ({ status: () => 302, headers: () => ({ location: 'https://evil.example/landing' }) }),
      fulfill: async () => { fulfilled++ },
    }, 'http://127.0.0.1:4173', 2000)
    await handleVisualRoute({
      request: () => ({ url: () => 'http://127.0.0.1:4173/ok' }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
      fetch: async opts => opts?.url?.endsWith('/local')
        ? { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }
        : { status: () => 302, headers: () => ({ location: '/local' }) },
      fulfill: async () => { fulfilled++ },
    }, 'http://127.0.0.1:4173', 2000)
    // Round 5 P1 #1: 2-hop redirect that escapes to another origin on hop 2 must abort instead of fulfilling
    await handleVisualRoute({
      request: () => ({ url: () => 'http://127.0.0.1:4173/hop1' }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
      fetch: async opts => opts?.url?.endsWith('/hop2')
        ? { status: () => 302, headers: () => ({ location: 'https://evil.example/steal' }) }
        : { status: () => 302, headers: () => ({ location: '/hop2' }) },
      fulfill: async () => { fulfilled++ },
    }, 'http://127.0.0.1:4173', 2000)
    // Round 6 P1 #2: Document redirect triggers onDocumentRedirect and aborts; POST -> 303 strips content headers & body via requestFetch
    let docRedirectTarget = ''
    let reqFetchCall: { url: string; method: string; headers?: Record<string, string> } | undefined
    await handleVisualRoute({
      request: () => ({ url: () => 'http://127.0.0.1:4173/redir-doc', resourceType: () => 'document' }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
      fetch: async () => ({ status: () => 302, headers: () => ({ location: '/catalog/page' }) }),
      fulfill: async () => { fulfilled++ },
    }, 'http://127.0.0.1:4173', 2000, {
      onDocumentRedirect: (_reqUrl, target) => { docRedirectTarget = target.pathname; return true },
    })
    await handleVisualRoute({
      request: () => ({
        url: () => 'http://127.0.0.1:4173/post-303',
        method: () => 'POST',
        resourceType: () => 'fetch',
        headers: () => ({ 'content-type': 'text/plain', 'content-length': '6', 'x-keep': 'yes', ':method': 'POST' }),
      }),
      continue: async () => { continued++ },
      abort: async () => { aborted++ },
      fetch: async () => ({ status: () => 303, headers: () => ({ location: '/after-303' }) }),
      fulfill: async () => { fulfilled++ },
    }, 'http://127.0.0.1:4173', 2000, {
      requestFetch: async (url, opts) => {
        reqFetchCall = { url, method: opts.method, ...(opts.headers && { headers: opts.headers }) }
        return { status: () => 200, headers: () => ({ 'content-type': 'text/plain' }) }
      },
    })
    expect({ aborted, continued, fulfilled, docRedirectTarget, reqFetchCall }).toEqual({
      aborted: 4,
      continued: 0,
      fulfilled: 2,
      docRedirectTarget: '/catalog/page',
      reqFetchCall: { url: 'http://127.0.0.1:4173/after-303', method: 'GET', headers: { 'x-keep': 'yes' } },
    })

    // P1 #4: beginHold throwing prevents child spawn
    const clock = new FakeClock(1000)
    await expect(runVisualCheck({
      root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
      warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      beginHold: () => { throw new Error('hold write failed') },
    }, {
      enabled: true, url: 'http://127.0.0.1:59998', routes: ['/'], viewport: { width: 800, height: 600 },
      captureBefore: false, startupTimeoutMs: 1000, captureTimeoutMs: 5000, failOnConsoleError: true, failOnPageError: true, failOnBlankPage: true,
      startCommand: { argv: [process.execPath, 'dist/preview.mjs'], timeoutMs: 5000, env: {}, passEnv: [] },
    }, 'after')).resolves.toMatchObject({ status: 'skipped', reason: 'VISUAL_ERROR' })

    // P1 #5 & P1 #6: missing route in partial capture fails visual check, and server secrets are redacted even when alreadyUp === true & key name collides
    const liveServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('up')
    })
    await new Promise<void>(resolve => liveServer.listen(0, '127.0.0.1', resolve))
    const livePort = (liveServer.address() as AddressInfo).port
    try {
      const partialRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [],
        knownSecrets: { API_KEY: 'ADAPTER_SECRET_1234' },
      }, {
        enabled: true, url: `http://127.0.0.1:${livePort}`, routes: ['/a', '/b'], viewport: { width: 800, height: 600 },
        captureBefore: false, startupTimeoutMs: 1000, captureTimeoutMs: 5000, failOnConsoleError: true, failOnPageError: true, failOnBlankPage: true,
        startCommand: { argv: [process.execPath, 'dist/preview.mjs'], timeoutMs: 5000, env: { API_KEY: 'SERVER_SECRET_5678' }, passEnv: [] },
      }, 'after', {
        capture: async ({ baseUrl }) => ({
          shots: [{
            route: '/a',
            url: `${baseUrl}/a`,
            statusCode: 200,
            blankPage: false,
            consoleErrors: ['leaked ADAPTER_SECRET_1234 and SERVER_SECRET_5678'],
            pageErrors: [],
            durationMs: 10,
          }],
        }),
      })
      expect(partialRes.status).toBe('failed')
      expect(partialRes.shots).toHaveLength(2)
      expect(partialRes.shots[0]?.consoleErrors[0]).not.toContain('ADAPTER_SECRET_1234')
      expect(partialRes.shots[0]?.consoleErrors[0]).not.toContain('SERVER_SECRET_5678')
      expect(partialRes.shots[1]?.route).toBe('/b')
      expect(partialRes.shots[1]?.pageErrors[0]).toContain('missing')
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()))
    }

    // P2 #2: Outbox fits oversized visual event inside 64 KiB window by stripping imageBase64 instead of emitting run.gap
    const outbox = new RunOutbox(clock, { runBufferBytes: 8 << 20, totalBufferBytes: 16 << 20 }, () => undefined)
    const sentFrames: unknown[] = []
    outbox.attach(frame => { sentFrames.push(frame); return true }, 64 * 1024, 1 << 20, ['blackboard.v1', 'verify.v1', 'visual.v1'])
    const rid = runId()
    outbox.register(rid, taskId())
    outbox.push(rid, {
      kind: 'visual', phase: 'after', status: 'failed',
      shots: [{
        route: '/heavy', url: 'http://127.0.0.1:4173/heavy', statusCode: 200, blankPage: true,
        consoleErrors: ['boom'], pageErrors: [], durationMs: 12,
        mimeType: 'image/jpeg', imageBase64: Buffer.alloc(90_000, 1).toString('base64'),
      }],
    })
    expect(sentFrames.some(f => (f as { type: string }).type === 'run.gap')).toBe(false)
    const evFrame = sentFrames.find(f => (f as { type: string }).type === 'run.events') as { payload: { events: RunEvent[] } }
    expect(evFrame.payload.events[0]).toMatchObject({ kind: 'visual', status: 'failed', phase: 'after' })
    const keptShot = (evFrame.payload.events[0] as Extract<RunEvent, { kind: 'visual' }>).shots[0]!
    expect(keptShot.imageBase64).toBeUndefined()
    expect(keptShot.consoleErrors).toEqual(['boom'])
  }, 20_000)

  it('pins -c configs for Vite, handles >256 char args, fails closed on unbaselined paths, enforces missing-route failure with checks disabled, and preserves all colliding secrets (Round 3 P0 & P1 #3/#9)', async () => {
    const deepDir = join(root, 'a'.repeat(130), 'b'.repeat(130))
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(deepDir, { recursive: true })
    const viteCfg = join(root, 'dist', 'vite.config.mjs')
    const longScript = join(deepDir, 'entry.mjs')
    writeFileSync(viteCfg, 'export default { server: { port: 4173 } }\n')
    writeFileSync(longScript, 'console.log("long")\n')
    const longRel = `${'a'.repeat(130)}/${'b'.repeat(130)}/entry.mjs`

    const parsed = WorkerConfigSchema.parse({
      workerId: 'w-r3-p0',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          manifest: { exclude: ['dist/**', 'a*/**'] },
          verify: { commands: [{ id: 'vite-build', argv: ['vite', '-c', 'dist/vite.config.mjs'] }] },
          visual: {
            enabled: true,
            url: 'http://127.0.0.1:4173',
            routes: ['/'],
            startCommand: { argv: [process.execPath, longRel] },
            subdirOverrides: {
              sub: { startCommand: { argv: ['vite', '--config=dist/vite.sub.mjs'] } },
            },
          },
        },
      }],
    })
    writeFileSync(join(root, 'dist', 'vite.sub.mjs'), 'export default {}\n')
    const harness = parsed.workspaces[0]!.harness
    const inspected = inspectCommandFiles(root, harness)
    expect(inspected.unbaselined).toBe(false)
    expect(inspected.paths).toEqual(expect.arrayContaining(['dist/vite.config.mjs', 'dist/vite.sub.mjs', longRel]))

    const sens = sensitivePaths(root, harness)
    const pre = await scanManifest(root, harness.manifest, sens, inspected.paths, inspected.unbaselined)
    writeFileSync(viteCfg, 'export default { server: { exec: "evil" } }\n')
    const post = await scanManifest(root, harness.manifest, sens, inspected.paths, inspected.unbaselined)
    expect(diffManifest(pre, post, sens).tamper.paths).toContain('dist/vite.config.mjs')

    // Outside workspace existing config file sets unbaselined -> scanManifest truncated=true
    const outsideFile = join(base, 'outside.config.mjs')
    writeFileSync(outsideFile, 'export default {}\n')
    const badCfg = WorkerConfigSchema.parse({
      workerId: 'w-r3-bad',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: { verify: { commands: [{ id: 'bad', argv: ['vite', '-c', '../outside.config.mjs'] }] } },
      }],
    })
    const badInspect = inspectCommandFiles(root, badCfg.workspaces[0]!.harness)
    expect(badInspect.unbaselined).toBe(true)
    const badScan = await scanManifest(root, badCfg.workspaces[0]!.harness.manifest, () => false, badInspect.paths, badInspect.unbaselined)
    expect(badScan.summary.truncated).toBe(true)

    // Missing routes + empty backend response must fail even with failOnBlankPage/failOnPageError disabled, and colliding secret values must all scrub
    const clock = new FakeClock(5000)
    const liveServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>(resolve => liveServer.listen(0, '127.0.0.1', resolve))
    const livePort = (liveServer.address() as AddressInfo).port
    try {
      const targetCfg = {
        enabled: true, url: `http://127.0.0.1:${livePort}`, routes: ['/a', '/b'], viewport: { width: 800, height: 600 },
        captureBefore: false, startupTimeoutMs: 1000, captureTimeoutMs: 5000,
        failOnConsoleError: true, failOnPageError: false, failOnBlankPage: false,
        startCommand: { argv: [process.execPath, longRel], timeoutMs: 5000, env: { API_KEY: 'SERVER_SECRET_9999' }, passEnv: [] },
      }
      const emptyRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      }, targetCfg, 'after', { capture: async () => ({ shots: [] }) })
      expect(emptyRes.status).toBe('failed')
      expect(emptyRes.reason).toBe('ROUTES_MISSING')
      expect(emptyRes.shots).toHaveLength(2)

      const collideRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [],
        knownSecrets: {
          API_KEY: 'ADAPTER_SECRET_1111',
          API_KEY_VISUAL_0: 'ADAPTER_COLLIDE_2222',
        },
      }, { ...targetCfg, routes: ['/a'] }, 'after', {
        capture: async ({ baseUrl }) => ({
          shots: [{
            route: '/a',
            url: `${baseUrl}/a`,
            statusCode: 200,
            blankPage: false,
            consoleErrors: ['err ADAPTER_SECRET_1111 ADAPTER_COLLIDE_2222 SERVER_SECRET_9999'],
            pageErrors: [],
            durationMs: 5,
          }],
        }),
      })
      expect(collideRes.status).toBe('failed')
      const redactedLine = collideRes.shots[0]?.consoleErrors[0] ?? ''
      expect(redactedLine).not.toContain('ADAPTER_SECRET_1111')
      expect(redactedLine).not.toContain('ADAPTER_COLLIDE_2222')
      expect(redactedLine).not.toContain('SERVER_SECRET_9999')
    } finally {
      await new Promise<void>(resolve => liveServer.close(() => resolve()))
    }
  })

  it('keeps newly started after-capture preview server alive after CLI exit aborts run.grace and preserves missing-route failures across split events (Round 3 P1 #2 & #3)', async () => {
    const probe = createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const previewPort = (probe.address() as AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => resolve()))

    const serverScript = join(root, 'preview-srv.mjs')
    writeFileSync(serverScript, [
      "import { createServer } from 'node:http'",
      `const port = ${previewPort}`,
      "const srv = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Preview Alive</h1>') })",
      "srv.listen(port, '127.0.0.1', () => {})",
    ].join('\n'))

    const clock = new FakeClock(20_000)
    const cfg = WorkerConfigSchema.parse({
      workerId: 'w-grace',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'edit',
        allowedAdapters: ['mock'],
        harness: {
          visual: {
            enabled: true,
            url: `http://127.0.0.1:${previewPort}`,
            routes: ['/a', '/b'],
            captureBefore: false,
            failOnBlankPage: false,
            failOnPageError: false,
            startupTimeoutMs: 8000,
            startCommand: { argv: [process.execPath, 'preview-srv.mjs'], timeoutMs: 10_000 },
          },
        },
      }],
    })
    const registry = new AdapterRegistry(cfg)
    await registry.probe(['mock'])
    const journal = new Journal(join(base, 'journal.json'), clock)
    const events: RunEvent[] = []

    let fetchedStatus: number | null = null
    const manager = new RunManager(cfg, registry, clock, journal, join(base, 'logs'), () => undefined, join(base, 'tmp'), {
      capture: async ({ baseUrl }) => {
        const res = await fetch(`${baseUrl}/a`)
        fetchedStatus = res.status
        return {
          shots: [{
            route: '/a',
            url: `${baseUrl}/a`,
            statusCode: res.status,
            blankPage: false,
            consoleErrors: [],
            pageErrors: [],
            durationMs: 10,
          }],
        }
      },
    })
    manager.outbox.attach(frame => {
      if (frame.type === 'run.events') events.push(...frame.payload.events.map(e => RunEvent.parse(e)))
      return true
    }, 64 * 1024, 1 << 20, ['blackboard.v1', 'verify.v1', 'visual.v1'])

    try {
      const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'changed.txt', content: 'hello' }])).toString('base64url')
      const cmd = RunDispatch.parse({
        runId: runId(),
        taskId: taskId(),
        taskNo: 1,
        attempt: 1,
        workspaceId: 'app',
        adapter: 'mock',
        profile: 'edit',
        prompt: `#scenario:fs harness=1 ops=${ops}\nchange workspace`,
        timeoutMs: 300_000,
        idleTimeoutMs: 20_000,
        notAfter: 300_000,
        origin: { source: 'dashboard', actorType: 'owner' },
        harness: { v: 1, trust: 'owner', board: 'write', inject: 'fresh', bootstrap: false, verify: { autoFixMaxRetries: 0 } },
      })
      manager.accept(cmd, 1000)()
      await manager.awaitRuns()

      expect(fetchedStatus).toBe(200)
      const visuals = events.filter((e): e is Extract<RunEvent, { kind: 'visual' }> => e.kind === 'visual')
      expect(visuals.map(v => `${v.shots[0]?.route}:${v.status}`)).toEqual(['/a:passed', '/b:failed'])
      const fin = events.find((e): e is Extract<RunEvent, { kind: 'finished' }> => e.kind === 'finished')
      expect(fin?.verification?.status).toBe('failed')
    } finally {
      manager.cancelAll()
      await manager.awaitRuns()
    }
  }, 20_000)

  it('captures a healthy loopback page in real Chromium while blocking popups, cross-origin HTTP, WebSockets, and Service Workers (Round 3 P1 #1 & #4)', async () => {
    let wsConnected = 0
    let wsClosedCode: number | undefined
    await handleVisualWebSocket({
      url: () => 'ws://127.0.0.1:4173/hmr',
      connectToServer: () => { wsConnected++; return {} },
      close: async opts => { wsClosedCode = opts?.code ?? 1000 },
    }, 'http://127.0.0.1:4173')
    await handleVisualWebSocket({
      url: () => 'wss://evil.example/exfil',
      connectToServer: () => { wsConnected++; return {} },
      close: async opts => { wsClosedCode = opts?.code ?? 1000 },
    }, 'http://127.0.0.1:4173')
    expect({ wsConnected, wsClosedCode }).toEqual({ wsConnected: 1, wsClosedCode: 1008 })

    let blockedHttpCount = 0
    let blockedWsCount = 0
    let sameOriginWsCount = 0
    let swHits = 0
    let rootLogoHits = 0
    let catalogLogoHits = 0
    let cssIconHits = 0
    let rootIconHits = 0
    let iframeInnerHits = 0
    let ok1Body = ''
    let post303AfterSeen = false
    let post303BodyLeaked = false
    let post303ContentType: string | undefined
    const blockedHttp = createServer((_req, res) => {
      blockedHttpCount++
      res.writeHead(200)
      res.end('evil')
    })
    await new Promise<void>(resolve => blockedHttp.listen(0, '127.0.0.1', resolve))
    const portB = (blockedHttp.address() as AddressInfo).port
    const blockedWss = new WebSocketServer({ server: blockedHttp })
    blockedWss.on('connection', () => { blockedWsCount++ })

    const allowedHttp = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')
        const pathname = parsed.pathname
        if (pathname === '/sw.js') {
          swHits++
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end('self.addEventListener("fetch", () => {})')
          return
        }
        if (pathname === '/popup') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<p>Popup</p>')
          return
        }
        if (pathname === '/redir-evil') {
          res.writeHead(302, { Location: `http://127.0.0.1:${portB}/from-redir` })
          res.end()
          return
        }
        if (pathname === '/hop1') {
          res.writeHead(302, { Location: '/hop2' })
          res.end()
          return
        }
        if (pathname === '/hop2') {
          res.writeHead(302, { Location: `http://127.0.0.1:${portB}/from-hop2` })
          res.end()
          return
        }
        if (pathname === '/ok1') {
          res.writeHead(302, { Location: '/ok2' })
          res.end()
          return
        }
        if (pathname === '/ok2') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('ok2')
          return
        }
        if (pathname === '/ok1-ack') {
          ok1Body = parsed.searchParams.get('v') ?? ''
          res.writeHead(200)
          res.end('ok')
          return
        }
        if (pathname === '/redirect-to-catalog') {
          res.writeHead(302, { Location: '/catalog/page' })
          res.end()
          return
        }
        if (pathname === '/catalog/page') {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<!doctype html><html><head><link rel="stylesheet" href="/old.css"></head><body><div class="box">Catalog</div><img src="logo.svg" alt="cat-logo" /><iframe src="/iframe-redir"></iframe></body></html>')
          return
        }
        if (pathname === '/old.css') {
          res.writeHead(302, { Location: '/styles/site.css' })
          res.end()
          return
        }
        if (pathname === '/styles/site.css') {
          res.writeHead(200, { 'Content-Type': 'text/css' })
          res.end('.box { background-image: url(icon.svg); }')
          return
        }
        if (pathname === '/styles/icon.svg') {
          cssIconHits++
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
          return
        }
        if (pathname === '/icon.svg') {
          rootIconHits++
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
          return
        }
        if (pathname === '/iframe-redir') {
          res.writeHead(302, { Location: '/iframe/inner' })
          res.end()
          return
        }
        if (pathname === '/iframe/inner') {
          iframeInnerHits++
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<p>Inner frame</p>')
          return
        }
        if (pathname === '/catalog/logo.svg') {
          catalogLogoHits++
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
          return
        }
        if (pathname === '/logo.svg') {
          rootLogoHits++
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
          return
        }
        if (pathname === '/p303') {
          res.writeHead(303, { Location: '/after-p303' })
          res.end()
          return
        }
        if (pathname === '/after-p303') {
          post303AfterSeen = true
          if (req.method !== 'GET' || body.length > 0) post303BodyLeaked = true
          post303ContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('after-p303')
          return
        }
        if (pathname === '/worker.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end([
            `try { new WebSocket('ws://' + self.location.host + '/ws?src=worker'); } catch {}`,
            `try { new WebSocket('ws://127.0.0.1:${portB}/ws-worker'); } catch {}`,
            `fetch('http://127.0.0.1:${portB}/from-worker').catch(() => {});`,
          ].join('\n'))
          return
        }
        if (pathname === '/shared-worker.js') {
          res.writeHead(200, { 'Content-Type': 'application/javascript' })
          res.end([
            `self.onconnect = () => {`,
            `  try { new WebSocket('ws://' + self.location.host + '/ws?src=shared'); } catch {}`,
            `  try { new WebSocket('ws://127.0.0.1:${portB}/ws-shared'); } catch {}`,
            `  fetch('http://127.0.0.1:${portB}/from-shared').catch(() => {});`,
            `};`,
          ].join('\n'))
          return
        }
        if (pathname === '/settle.js') {
          const start = Date.now()
          const check = () => {
            if ((sameOriginWsCount >= 4 && post303AfterSeen && ok1Body === 'ok2') || Date.now() - start >= 1800) {
              res.writeHead(200, { 'Content-Type': 'application/javascript' })
              res.end('window.__wsSettled = true')
            } else {
              setTimeout(check, 25)
            }
          }
          check()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<!doctype html><html><body>
          <h1>Healthy App Render</h1>
          <img src="/redir-evil" alt="redir" />
          <img src="/hop1" alt="hop1" />
          <script>
            fetch('/ok1').then(r => r.text()).then(v => fetch('/ok1-ack?v=' + encodeURIComponent(v))).catch(() => {});
            fetch('/p303', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '123456' }).catch(() => {});
            try { new WebSocket('ws://' + location.host + '/ws?src=page'); } catch {}
            try { new WebSocket('ws://127.0.0.1:${portB}/ws'); } catch {}
            fetch('https://127.0.0.1:${portA}/https-leak').catch(() => {});
            try { new WebSocket('wss://127.0.0.1:${portA}/wss-leak'); } catch {}
            fetch('http://127.0.0.1:${portB}/steal').catch(() => {});
            window.open('/popup');
            try { new Worker('/worker.js'); } catch {}
            try {
              const blob = new Blob([
                "try { new WebSocket('ws://127.0.0.1:${portA}/ws?src=blob'); } catch {} ; " +
                "try { new WebSocket('ws://127.0.0.1:${portB}/ws-blob'); } catch {} ; " +
                "fetch('http://127.0.0.1:${portB}/from-blob').catch(() => {});"
              ], { type: 'application/javascript' });
              new Worker(URL.createObjectURL(blob));
            } catch {}
            try { const sw = new SharedWorker('/shared-worker.js'); sw.port.start(); } catch {}
            try { navigator.serviceWorker?.register('/sw.js').catch(() => {}); } catch {}
          </script>
          <script src="/settle.js"></script>
        </body></html>`)
      })
    })
    let tlsClientErrHits = 0
    allowedHttp.on('clientError', () => { tlsClientErrHits++ })
    await new Promise<void>(resolve => allowedHttp.listen(0, '127.0.0.1', resolve))
    const portA = (allowedHttp.address() as AddressInfo).port
    const sameOriginSources = new Set<string>()
    const allowedWss = new WebSocketServer({ server: allowedHttp })
    allowedWss.on('connection', (socket, req) => {
      sameOriginWsCount++
      sameOriginSources.add(req.url ?? '')
      socket.close()
    })

    try {
      const clock = new FakeClock(30_000)
      const res = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      }, {
        enabled: true,
        url: `http://127.0.0.1:${portA}`,
        routes: ['/', '/redirect-to-catalog'],
        viewport: { width: 800, height: 600 },
        captureBefore: false,
        startupTimeoutMs: 5000,
        captureTimeoutMs: 15_000,
        failOnConsoleError: false,
        failOnPageError: true,
        failOnBlankPage: true,
      }, 'after')
      expect(res.status).toBe('passed')
      expect(res.shots).toHaveLength(2)
      expect(res.shots[0]?.routeIndex).toBe(0)
      expect(res.shots[0]?.statusCode).toBe(200)
      expect(res.shots[0]?.blankPage).toBe(false)
      expect(res.shots[0]?.pageErrors).toEqual([])
      expect(res.shots[0]?.imageBase64?.length).toBeGreaterThan(500)
      expect(res.shots[1]?.routeIndex).toBe(1)
      expect(res.shots[1]?.route).toBe('/redirect-to-catalog')
      expect(res.shots[1]?.url).toBe(`http://127.0.0.1:${portA}/catalog/page`)
      expect(res.shots[1]?.statusCode).toBe(200)
      expect(res.shots[1]?.blankPage).toBe(false)
      expect(ok1Body).toBe('ok2')
      expect(post303AfterSeen).toBe(true)
      expect(post303BodyLeaked).toBe(false)
      expect(post303ContentType).toBeUndefined()
      expect(catalogLogoHits).toBeGreaterThanOrEqual(1)
      expect(rootLogoHits).toBe(0)
      expect(cssIconHits).toBeGreaterThanOrEqual(1)
      expect(rootIconHits).toBe(0)
      expect(iframeInnerHits).toBeGreaterThanOrEqual(1)
      expect(blockedHttpCount).toBe(0)
      expect(blockedWsCount).toBe(0)
      expect(tlsClientErrHits).toBe(0)
      expect(swHits).toBe(0)
      expect(sameOriginSources).toEqual(new Set(['/ws?src=page', '/ws?src=worker', '/ws?src=blob', '/ws?src=shared']))

      const hopRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      }, {
        enabled: true,
        url: `http://127.0.0.1:${portA}`,
        routes: ['/hop1'],
        viewport: { width: 800, height: 600 },
        captureBefore: false,
        startupTimeoutMs: 5000,
        captureTimeoutMs: 15_000,
        failOnConsoleError: false,
        failOnPageError: true,
        failOnBlankPage: true,
      }, 'after')
      expect(hopRes.status).toBe('failed')
      expect(hopRes.shots[0]?.statusCode).toBeNull()
      expect(blockedHttpCount).toBe(0)
    } finally {
      blockedWss.close()
      allowedWss.close()
      await new Promise<void>(resolve => blockedHttp.close(() => resolve()))
      await new Promise<void>(resolve => allowedHttp.close(() => resolve()))
    }
  }, 30_000)

  it('pins file: URLs, fails closed on >8 MiB pinned files, fails incomplete deadline placeholders, scrubs visual route/url metadata, and isolates effective commands per run (Round 4 P0 & P1)', async () => {
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'valid'), { recursive: true })
    const preload = join(root, 'dist', 'preload.mjs')
    const outsideMod = join(base, 'outside-preload.mjs')
    const bigFile = join(root, 'dist', 'huge.mjs')
    writeFileSync(preload, 'export const ok = true\n')
    writeFileSync(outsideMod, 'export const evil = true\n')
    writeFileSync(bigFile, Buffer.alloc(9 * 1024 * 1024, 65))

    // P0 #1: file:// URL inside workspace pinned & outside workspace marks unbaselined
    const urlCfg = WorkerConfigSchema.parse({
      workerId: 'w-url-mod',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          manifest: { exclude: ['dist/**'] },
          verify: { commands: [{ id: 'preload', argv: ['node', '--import', pathToFileURL(preload).href, '-e', '0'] }] },
        },
      }],
    })
    const urlInspect = inspectCommandFiles(root, urlCfg.workspaces[0]!.harness)
    expect(urlInspect.unbaselined).toBe(false)
    expect(urlInspect.paths).toContain('dist/preload.mjs')

    const badUrlCfg = WorkerConfigSchema.parse({
      workerId: 'w-url-bad',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          verify: { commands: [{ id: 'preload', argv: ['node', `--import=${pathToFileURL(outsideMod).href}`, '-e', '0'] }] },
        },
      }],
    })
    expect(inspectCommandFiles(root, badUrlCfg.workspaces[0]!.harness).unbaselined).toBe(true)

    // P0 #2: >8 MiB pinned file without sha256 must mark manifest truncated=true (BOTH un-excluded main walk & excluded paths)
    const mainWalkBigFile = join(root, 'huge-mainwalk.mjs')
    writeFileSync(mainWalkBigFile, Buffer.alloc(9 * 1024 * 1024, 66))
    const bigCfg = WorkerConfigSchema.parse({
      workerId: 'w-big',
      hub: { url: 'ws://127.0.0.1:9999' },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'full',
        allowedAdapters: ['mock'],
        harness: {
          verify: {
            commands: [
              { id: 'big-excluded', argv: ['node', 'dist/huge.mjs'] },
              { id: 'big-main', argv: ['node', 'huge-mainwalk.mjs'] },
            ],
          },
        },
      }],
    })
    for (const cmd of bigCfg.workspaces[0]!.harness.verify.commands) {
      const oneSens = sensitivePaths(root, { ...bigCfg.workspaces[0]!.harness, verify: { ...bigCfg.workspaces[0]!.harness.verify, commands: [cmd] } })
      const oneInspect = inspectCommands(root, [cmd])
      const oneManifest = await scanManifest(root, bigCfg.workspaces[0]!.harness.manifest, oneSens, oneInspect.paths, oneInspect.unbaselined)
      if (cmd.id === 'big-main') {
        expect(oneManifest.entries.has('huge-mainwalk.mjs')).toBe(true)
        expect(oneManifest.entries.get('huge-mainwalk.mjs')?.sha256).toBeUndefined()
      }
      expect(oneManifest.summary.truncated).toBe(true)
    }

    // Round 5 P0 #1: Workspace-local .cmd shim resolves via resolveVerifyCommand & pins both shim and target script on Windows
    if (process.platform === 'win32') {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      const shimTarget = join(root, 'scripts', 'shim-tool.mjs')
      const shimCmd = join(root, 'scripts', 'shim-tool.cmd')
      writeFileSync(shimTarget, 'console.log("ok")\n')
      writeFileSync(shimCmd, `@echo off\r\nnode "%~dp0\\shim-tool.mjs" %*\r\n`)
      const shimInspect = inspectCommands(root, [{ argv: [shimCmd] }])
      expect(shimInspect.unbaselined).toBe(false)
      expect(shimInspect.paths).toEqual(expect.arrayContaining(['scripts/shim-tool.cmd', 'scripts/shim-tool.mjs']))
    }

    // P1 #1 & #6: deadline placeholder fails with failOnBlankPage/failOnPageError disabled, and route/url secrets are redacted after matching completeness
    const clock = new FakeClock(40_000)
    const srv = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    try {
      const secretRoute = '/?token=ADAPTER_SECRET_1111'
      const baseVisual = {
        enabled: true, url: `http://127.0.0.1:${port}`, routes: [secretRoute], viewport: { width: 800, height: 600 },
        captureBefore: false, startupTimeoutMs: 1000, captureTimeoutMs: 5000,
        failOnConsoleError: false, failOnPageError: false, failOnBlankPage: false,
      }
      const incompleteRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      }, baseVisual, 'after', {
        capture: async ({ baseUrl }) => ({
          shots: [{
            route: secretRoute, url: baseUrl, statusCode: null, blankPage: true,
            consoleErrors: [], pageErrors: ['Visual capture deadline exceeded'], durationMs: 0, captureFailed: true,
          }],
        }),
      })
      expect(incompleteRes.status).toBe('failed')
      expect(incompleteRes.reason).toBe('CAPTURE_INCOMPLETE')

      const secretRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [],
        knownSecrets: { API_TOKEN: 'ADAPTER_SECRET_1111' },
      }, baseVisual, 'after', {
        capture: async ({ baseUrl }) => ({
          shots: [{
            route: secretRoute, url: `${baseUrl}${secretRoute}`, statusCode: 200, blankPage: false,
            consoleErrors: [], pageErrors: [], durationMs: 5,
          }],
        }),
      })
      expect(secretRes.status).toBe('passed')
      expect(secretRes.shots[0]?.routeIndex).toBe(0)
      expect(secretRes.shots[0]?.route).not.toContain('ADAPTER_SECRET_1111')
      expect(secretRes.shots[0]?.url).not.toContain('ADAPTER_SECRET_1111')

      // Round 5 P1 #2: capture-time exception (after capture starts) fails with CAPTURE_INCOMPLETE instead of skipped
      const throwRes = await runVisualCheck({
        root, runId: runId(), clock, signal: new AbortController().signal, force: new AbortController().signal,
        warn: () => undefined, journal: { process: () => undefined }, useJobObject: false, patterns: [], knownSecrets: {},
      }, baseVisual, 'after', {
        capture: async () => { throw new Error('Target page, context or browser has been closed') },
      })
      expect(throwRes.status).toBe('failed')
      expect(throwRes.reason).toBe('CAPTURE_INCOMPLETE')
      expect(throwRes.shots).toHaveLength(1)
      expect(throwRes.shots[0]?.routeIndex).toBe(0)
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()))
    }

    // P1 #5: Broken unrelated subdirOverride/command does NOT mark manifest incomplete for valid run
    const isoCfg = WorkerConfigSchema.parse({
      workerId: 'w-iso-cmd',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'edit',
        allowedAdapters: ['mock'],
        harness: {
          verify: { commands: [{ id: 'valid-check', cwd: 'valid', argv: [process.execPath, '-e', '0'] }] },
          visual: {
            enabled: false,
            subdirOverrides: {
              broken: { startCommand: { argv: [process.execPath, 'missing.mjs'], cwd: 'MissingSubdir' } },
            },
          },
        },
      }],
    })
    const reg = new AdapterRegistry(isoCfg)
    await reg.probe(['mock'])
    const mgr = new RunManager(isoCfg, reg, clock, new Journal(join(base, 'j-iso'), clock), join(base, 'l-iso'), () => undefined, join(base, 't-iso'))
    const evs: RunEvent[] = []
    mgr.outbox.attach(f => {
      if (f.type === 'run.events') evs.push(...f.payload.events.map(e => RunEvent.parse(e)))
      return true
    }, 64 * 1024, 1 << 20, ['blackboard.v1', 'verify.v1'])
    const ops = Buffer.from(JSON.stringify([{ op: 'write', path: 'out.txt', content: 'ok' }])).toString('base64url')
    mgr.accept(RunDispatch.parse({
      runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, workspaceId: 'app', subdir: 'valid',
      adapter: 'mock', profile: 'edit', prompt: `#scenario:fs harness=1 ops=${ops}\nok`,
      timeoutMs: 300_000, idleTimeoutMs: 20_000, notAfter: 300_000, origin: { source: 'dashboard', actorType: 'owner' },
      harness: { v: 1, trust: 'owner', board: 'off', inject: 'fresh', bootstrap: false, verify: { autoFixMaxRetries: 0 } },
    }), 1000)()
    await mgr.awaitRuns()
    const wsEv = evs.find((e): e is Extract<RunEvent, { kind: 'workspace' }> => e.kind === 'workspace')
    expect(wsEv?.changes?.truncated).toBe(false)
    const finEv = evs.find((e): e is Extract<RunEvent, { kind: 'finished' }> => e.kind === 'finished')
    expect(finEv?.verification?.status, JSON.stringify(finEv?.verification)).toBe('passed')

    // Round 6 P0 #1 & Round 7 P0 #1 & Round 8 P1 #4: Runtime interpreter directory / implicit-extension entry points, Node 24 separate-operand flags (--v8-pool-size / --heapsnapshot-near-heap-limit), unknown bare flags, and Python -m modules
    mkdirSync(join(root, 'pkg-dir'), { recursive: true })
    writeFileSync(join(root, 'pkg-dir', 'index.js'), 'export const x = 1\n')
    expect(inspectCommands(root, [{ argv: ['node', 'pkg-dir'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', '--inspect', 'pkg-dir'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', '--inspect-brk', 'pkg-dir'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', '--v8-pool-size', '2', 'pkg-dir'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', '--heapsnapshot-near-heap-limit', '1', 'pkg-dir/index'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', '--unknown-future-flag', '2', 'pkg-dir'] }]).unbaselined).toBe(true)
    const v8PoolExplicit = inspectCommands(root, [{ argv: ['node', '--v8-pool-size', '2', 'pkg-dir/index.js'] }])
    expect(v8PoolExplicit.unbaselined).toBe(false)
    expect(v8PoolExplicit.paths).toContain('pkg-dir/index.js')
    expect(inspectCommands(root, [{ argv: ['node', '--import', './pkg-dir', '-e', '0'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['node', 'pkg-dir/index'] }]).unbaselined).toBe(true)
    const explicitEntry = inspectCommands(root, [{ argv: ['node', 'pkg-dir/index.js', '--test', 'pkg-dir'] }])
    expect(explicitEntry.unbaselined).toBe(false)
    expect(explicitEntry.paths).toContain('pkg-dir/index.js')

    writeFileSync(join(root, 'local_check.py'), 'print("ok")\n')
    mkdirSync(join(root, 'py_pkg'), { recursive: true })
    writeFileSync(join(root, 'py_pkg', '__init__.py'), '')
    writeFileSync(join(root, 'py_pkg', 'runner.py'), 'print("pkg")\n')
    writeFileSync(join(root, 'py_pkg', '__main__.py'), 'print("main")\n')
    const pyMod = inspectCommands(root, [{ argv: ['python', '-m', 'local_check'] }])
    expect(pyMod.unbaselined).toBe(false)
    expect(pyMod.paths).toContain('local_check.py')
    const pySubMod = inspectCommands(root, [{ argv: ['python', '-m', 'py_pkg.runner'] }])
    expect(pySubMod.unbaselined).toBe(false)
    expect(pySubMod.paths).toEqual(expect.arrayContaining(['py_pkg/__init__.py', 'py_pkg/runner.py']))
    expect(inspectCommands(root, [{ argv: ['python', '-m', 'py_pkg'] }]).unbaselined).toBe(true)
    expect(inspectCommands(root, [{ argv: ['python', '-m', 'unittest'] }]).unbaselined).toBe(false)

    // Round 6 P0 #2 & P1 #1 + Round 7 P0 #2 & P1 #1 + Round 8 P1 #5: PATH shim pinning, copied/hardlinked shell binary identity, and non-swallowed symlink assertions
    if (process.platform === 'win32') {
      mkdirSync(join(root, 'bin'), { recursive: true })
      const pathTarget = join(root, 'bin', 'path-tool.mjs')
      const pathCmd = join(root, 'bin', 'path-tool.cmd')
      writeFileSync(pathTarget, 'console.log("path ok")\n')
      writeFileSync(pathCmd, '@echo off\r\nnode "%~dp0\\path-tool.mjs" %*\r\n')
      const extBin = join(base, 'ext-bin')
      mkdirSync(extBin, { recursive: true })
      mkdirSync(join(root, 'docs'), { recursive: true })
      writeFileSync(join(extBin, 'docs.cmd'), '@echo off\r\npnpm docs %*\r\n')
      const prevPath = process.env.PATH ?? ''
      process.env.PATH = `${join(root, 'bin')};${extBin};${prevPath}`
      try {
        const pathInspect = inspectCommands(root, [{ argv: ['path-tool'] }])
        expect(pathInspect.unbaselined).toBe(false)
        expect(pathInspect.paths).toEqual(expect.arrayContaining(['bin/path-tool.cmd', 'bin/path-tool.mjs']))
        expect(inspectCommands(root, [{ argv: ['docs'] }]).unbaselined).toBe(false)
      } finally {
        process.env.PATH = prevPath
      }

      const shellDir = join(base, 'shell-shim')
      mkdirSync(shellDir, { recursive: true })
      const localCmdExe = join(shellDir, 'cmd.exe')
      writeFileSync(localCmdExe, '')
      const sneakyCmd = join(shellDir, 'sneaky.cmd')
      writeFileSync(sneakyCmd, '@echo off\r\n"%~dp0\\cmd.exe" %*\r\n')
      expect(resolveVerifyCommand(sneakyCmd)).toEqual({ status: 'error', error: 'VERIFY_SHELL_FORBIDDEN' })
      expect(inspectCommands(root, [{ argv: [sneakyCmd] }]).unbaselined).toBe(true)
      const aliasExe = join(shellDir, 'safe-alias.exe')
      let aliasSymlinkCreated = false
      try {
        symlinkSync(localCmdExe, aliasExe, 'file')
        aliasSymlinkCreated = true
      } catch {
        // Symlink creation may require Developer Mode on some Windows hosts
      }
      if (aliasSymlinkCreated) {
        expect(resolveVerifyCommand(aliasExe)).toEqual({ status: 'error', error: 'VERIFY_SHELL_FORBIDDEN' })
        expect(inspectCommands(root, [{ argv: [aliasExe] }]).unbaselined).toBe(true)
      }
    }
    const realShell = process.platform === 'win32'
      ? (process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'))
      : '/bin/sh'
    if (existsSync(realShell)) {
      const copiedShell = join(base, process.platform === 'win32' ? 'renamed-copy.exe' : 'renamed-copy')
      copyFileSync(realShell, copiedShell)
      expect(resolveVerifyCommand(copiedShell)).toEqual({ status: 'error', error: 'VERIFY_SHELL_FORBIDDEN' })
      expect(inspectCommands(root, [{ argv: [copiedShell] }]).unbaselined).toBe(true)
      const hardlinkShell = join(base, process.platform === 'win32' ? 'hardlink-shell.exe' : 'hardlink-shell')
      let hardlinkCreated = false
      try {
        linkSync(realShell, hardlinkShell)
        hardlinkCreated = true
      } catch {
        // Hardlinks across volumes or restricted paths may fail cleanly
      }
      if (hardlinkCreated) {
        expect(resolveVerifyCommand(hardlinkShell)).toEqual({ status: 'error', error: 'VERIFY_SHELL_FORBIDDEN' })
        expect(inspectCommands(root, [{ argv: [hardlinkShell] }]).unbaselined).toBe(true)
      }
    }

    // Round 6 P0 #3: captureBefore never launches an unbaselined visual startCommand before pre-manifest completes
    const markerFile = join(base, 'BEFORE_START_EXECUTED.txt')
    const outsideStartScript = join(base, 'outside-start-server.mjs')
    writeFileSync(outsideStartScript, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerFile)}, 'ran');\n`)
    const beforeCfg = WorkerConfigSchema.parse({
      workerId: 'w-before-gate',
      hub: { url: 'ws://127.0.0.1:9999' },
      harness: { enabled: true },
      adapters: { mock: { enabled: true } },
      workspaces: [{
        id: 'app',
        path: root,
        label: 'App',
        maxProfile: 'edit',
        allowedAdapters: ['mock'],
        harness: {
          visual: {
            enabled: true,
            captureBefore: true,
            url: 'http://127.0.0.1:59997',
            routes: ['/'],
            startCommand: { argv: [process.execPath, '../outside-start-server.mjs'] },
          },
        },
      }],
    })
    const regBefore = new AdapterRegistry(beforeCfg)
    await regBefore.probe(['mock'])
    const mgrBefore = new RunManager(beforeCfg, regBefore, clock, new Journal(join(base, 'j-bef'), clock), join(base, 'l-bef'), () => undefined, join(base, 't-bef'))
    const befEvents: RunEvent[] = []
    mgrBefore.outbox.attach(f => {
      if (f.type === 'run.events') befEvents.push(...f.payload.events.map(e => RunEvent.parse(e)))
      return true
    }, 64 * 1024, 1 << 20, ['blackboard.v1', 'verify.v1', 'visual.v1'])
    mgrBefore.accept(RunDispatch.parse({
      runId: runId(), taskId: taskId(), taskNo: 1, attempt: 1, workspaceId: 'app',
      adapter: 'mock', profile: 'edit', prompt: '#scenario:fs harness=1\ncheck',
      timeoutMs: 300_000, idleTimeoutMs: 20_000, notAfter: 300_000, origin: { source: 'dashboard', actorType: 'owner' },
      harness: { v: 1, trust: 'owner', board: 'off', inject: 'fresh', bootstrap: false, verify: { autoFixMaxRetries: 0 } },
    }), 1000)()
    await mgrBefore.awaitRuns()
    expect(existsSync(markerFile)).toBe(false)
    expect(befEvents.find(e => e.kind === 'visual' && e.phase === 'before')).toMatchObject({
      kind: 'visual', phase: 'before', status: 'skipped', reason: 'MANIFEST_INCOMPLETE',
    })
  })
})
