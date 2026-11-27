import { Readable } from 'node:stream'
import type { Context } from 'cordis'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { ulid } from '@agent-hub/common'
import * as api from '@agent-hub/protocol'
import type { Actor, Scope } from '@agent-hub/protocol'
import { HubError } from '../../services/errors.js'
import { describeFibers } from '../../kernel/lifecycle.js'
import { guardAsync } from '../../kernel/safe.js'
import { taskRuns } from '../store-sqlite/schema.js'
import { logEntryEnd } from './log-follow.js'
import { installDashboardWs } from './ws-hub.js'
import { listAudit } from './audit.js'
import { runView, owner } from '../orchestrator/views.js'
import { controlProject, rebaselineProject } from '../orchestrator/personal-controls.js'
import { projectReports, projectViews } from '../orchestrator/personal-status.js'
import { addMethodExample, createMethod, deleteMethod, getMethod, listMethods, removeMethodExample, suggestFor, updateMethod } from '../orchestrator/methods.js'

export const name = 'dashboard-api'
export const inject = ['http', 'auth', 'orchestrator', 'workers', 'store', 'clock', 'policy']
export interface DashboardConfig { publicUrl: string; workerPath: string; allowInsecureCookie?: boolean; status?: () => { configError: string | null; restartRequired: boolean } }
export const Config = z.strictObject({ publicUrl: z.url(), workerPath: z.string(), allowInsecureCookie: z.boolean().optional(),
  status: z.custom<NonNullable<DashboardConfig['status']>>(value => typeof value === 'function').optional() })

const parse = <T>(schema: z.ZodType<T>, input: unknown) => {
  const result = schema.safeParse(input)
  if (!result.success) throw new HubError('VALIDATION_FAILED', 400, { issues: result.error.issues })
  return result.data
}
function cookie(req: FastifyRequest) {
  return req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('ah_sid='))?.slice(7)
}
function header(req: FastifyRequest, key: string) {
  const value = req.headers[key]
  return typeof value === 'string' ? value : undefined
}
export function apply(ctx: Context, config: DashboardConfig) {
  const { http, auth, orchestrator, workers, store } = ctx
  const secureCookie = (req: FastifyRequest) => req.protocol === 'https' || !config.allowInsecureCookie
  function authenticate(req: FastifyRequest, res: FastifyReply, scope: Scope) {
    const bearer = req.headers.authorization
    const sid = cookie(req)
    const session = bearer ? null : auth.verifySession(sid)
    const principal = bearer ? auth.verifyApiToken(/^Bearer (\S+)$/.exec(bearer)?.[1]) : session?.principal
    if (!principal) throw new HubError('UNAUTHENTICATED', 401)
    if (session && req.method !== 'GET') auth.verifyMutation(session, req.headers.origin, header(req, 'x-csrf-token'))
    const granted = principal.scopes.includes(scope) || principal.scopes.includes('admin') ||
      (scope === 'read' && principal.scopes.includes('operate'))
    if (!granted) throw new HubError('FORBIDDEN', 403)
    if (session?.renewed) res.header('Set-Cookie', auth.cookie(sid!, session.expiresAt, secureCookie(req)))
    return { principal, session, actor: principal.via === 'session' ? owner : { ...owner, channel: 'api' } as Actor }
  }
  type Handler = (req: FastifyRequest, res: FastifyReply, params: Record<string, string>, actor: Actor) => unknown
  const route = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, scope: Scope | null, fn: Handler) => {
    ctx.effect(() => http.route(method, '/api/v1' + path, (req, res, params) =>
      fn(req, res, params, scope === null ? owner : authenticate(req, res, scope).actor)), method + ' ' + path)
  }
  const ref = (params: Record<string, string>) => parse(api.TaskPath, params).ref
  const workerId = (params: Record<string, string>) => parse(api.WorkerPath, params).id
  const requireWorker = (id: string) => { const worker = workers.get(id); if (!worker) throw new HubError('WORKER_NOT_FOUND', 404); return worker }
  const detail = (id: string, actor: Actor) => {
    const task = orchestrator.getTask(id, actor)
    if (!task) throw new HubError('TASK_NOT_FOUND', 404)
    return api.TaskDetail.parse(task)
  }
  const idempotency = (req: FastifyRequest) => ({ idempotencyKey: parse(api.IdempotencyKey.optional(), req.headers['idempotency-key']) })
  route('POST', '/auth/login', null, (req, res) => {
    const session = auth.login(parse(api.LoginRequest, req.body).token, { ip: req.ip, userAgent: req.headers['user-agent'] })
    res.header('Set-Cookie', auth.cookie(session.sessionId, session.expiresAt, secureCookie(req)))
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt }
  })
  route('POST', '/auth/logout', 'read', (req, res) => {
    const sid = cookie(req)
    if (sid && !req.headers.authorization) { auth.logout(sid); res.header('Set-Cookie', auth.cookie('', 0, secureCookie(req))) }
    return res.code(204).send()
  })
  route('GET', '/auth/me', null, (req, res) => {
    const { principal, session } = authenticate(req, res, 'read')
    return { principal, ...(session && { csrfToken: session.csrfToken }) }
  })
  const overview = () => {
    const view = orchestrator.overview()
    Object.assign(view.hub, config.status?.(), { draining: !http.accepting || view.hub.draining })
    return api.Overview.parse(view)
  }
  installDashboardWs(ctx, overview)
  route('GET', '/overview', 'read', overview)
  route('GET', '/projects', 'read', () => api.ProjectOverview.array().parse(orchestrator.listProjects()))
  route('GET', '/system/metrics', 'admin', () => {
    const view = orchestrator.overview()
    return { workersOnline: view.workersOnline, workersTotal: view.workersTotal, queueLength: view.counts.queued,
      tasks: view.counts, ...store.ingest.metrics, ...store.health(), ...store.retention, ...orchestrator.metrics(), ...workers.metrics(),
      droppedLogBytesTotal: workers.list().reduce((sum, w) => sum + w.droppedLogBytesTotal, 0) }
  })
  route('GET', '/system/fibers', 'admin', () => describeFibers(ctx))
  route('GET', '/tasks', 'read', (req, _res, _params, actor) => api.TaskListResponse.parse(orchestrator.listTasks(parse(api.TaskListQuery, req.query), actor)))
  route('GET','/personal/projects','read',()=>projectViews(store.repos))
  const projectId=(params:Record<string,string>)=>parse(api.PersonalPlanRequest.shape.projectId,params.id)
  for(const action of ['pause','resume','stop'] as const) {
    route('POST','/personal/projects/:id/'+action,'operate',async (_req,res,params,actor)=>{
      await controlProject(ctx,projectId(params),action,actor)
      return res.code(204).send()
    })
  }
  route('POST', '/personal/projects/:id/rebaseline', 'operate', async (_req, _res, params) =>
    rebaselineProject(ctx, projectId(params)))
  route('GET','/personal/projects/:id/reports','read',(_req,res,params)=>{
    res.header('Cache-Control','no-store')
    return store.tx(db=>projectReports(db,projectId(params),ctx.clock.now()))
  })
  route('POST', '/personal/preflight', 'operate', req => orchestrator.preflightProject(parse(api.AutopilotPreflightRequest, req.body)))
  route('POST', '/personal/autopilot', 'operate', async (req, res, _params, actor) => {
    const result = await orchestrator.startAutopilot(parse(api.AutopilotStartRequest, req.body), actor)
    return res.code(201).send(result)
  })
  route('POST', '/personal/plans', 'operate', async (req, res, _params, actor) => {
    const plan = parse(api.PersonalPlanRequest, req.body)
    const task = await orchestrator.createTask({ prompt: '生成项目任务计划 ' + plan.projectId, workspaceId: plan.binding.workspaceId,
      requiredWorkerId: plan.binding.workerId, ...api.personalRoleSettings.main, timeoutMs: 30 * 60_000 },
    actor, { personalPlan: plan })
    return res.code(201).send(api.TaskDetail.parse(task))
  })
  route('POST', '/tasks', 'operate', async (req, res, _params, actor) => {
    const task = await orchestrator.createTask(parse(api.CreateTaskRequest, req.body), actor, idempotency(req))
    return res.code(201).send(api.TaskDetail.parse(task))
  })
  route('GET', '/tasks/:ref', 'read', (_req, _res, params, actor) => detail(ref(params), actor))
  for (const action of ['approve', 'reject', 'cancel', 'retry', 'input'] as const) {
    route('POST', '/tasks/:ref/' + action, 'operate', async (req, _res, params, actor) => {
      const id = ref(params), body = req.body ?? {}
      switch (action) {
        case 'approve': await orchestrator.approve(id, actor, parse(api.ApproveTaskRequest, body)); break
        case 'reject': await orchestrator.reject(id, actor, parse(api.RejectTaskRequest, body)); break
        case 'cancel': await orchestrator.cancel(id, actor, parse(api.CancelTaskRequest, body)); break
        case 'retry': await orchestrator.retry(id, actor, parse(api.RetryTaskRequest, body)); break
        case 'input': await orchestrator.provideInput(id, actor, parse(api.TaskInputRequest, body)); break
      }
      return detail(id, actor)
    })
  }
  route('POST', '/tasks/:ref/handoff', 'operate', async (req, res, params, actor) => res.code(201)
    .send(api.TaskDetail.parse(await orchestrator.handoff(ref(params), actor, parse(api.HandoffTaskRequest, req.body), idempotency(req)))))
  route('GET', '/tasks/:ref/handoff-preview', 'read', (req, _res, params, actor) =>
    api.HandoffPreview.parse(orchestrator.handoffPreview(ref(params), actor, parse(api.HandoffPreviewQuery, req.query))))
  route('GET', '/tasks/:ref/runs/:runId/harness', 'read', (_req, _res, params) => {
    const path = parse(api.RunPath, params)
    return api.RunHarnessView.parse(orchestrator.runHarness(path.ref, path.runId))
  })
  route('GET', '/tasks/:ref/runs/:runId/artifacts', 'read', (_req, _res, params) => {
    const path = parse(api.RunPath, params)
    return api.RunArtifactView.array().parse(orchestrator.listRunArtifacts(path.ref, path.runId))
  })
  route('GET', '/artifacts/:id', 'read', (_req, res, params) => {
    const id = parse(api.ArtifactId, params.id)
    const row = store.artifacts.get(id)
    const data = row && store.artifacts.readBytes(row)
    if (!row || !data) throw new HubError('TASK_NOT_FOUND', 404, { reason: 'ARTIFACT_NOT_FOUND' })
    const safeInlineImage = ['image/png', 'image/jpeg', 'image/webp'].includes(row.mimeType)
    res
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, no-store')
    if (!safeInlineImage) {
      res.header('Content-Disposition', 'attachment')
      return res.type('application/octet-stream').send(data)
    }
    return res.type(row.mimeType).send(data)
  })
  route('GET', '/briefings', 'read', req => {
    const q = (req.query ?? {}) as Record<string, string | undefined>
    const workerIdFilter = q.workerId ? parse(api.WorkerId, q.workerId) : undefined
    const workspaceId = q.workspaceId ? parse(api.WorkspaceId, q.workspaceId) : undefined
    const limit = q.limit && /^\d+$/.test(q.limit) ? Math.min(50, Number(q.limit)) : 20
    return api.ProjectBriefingView.array().parse(orchestrator.listBriefings({
      ...(workerIdFilter && { workerId: workerIdFilter }),
      ...(workspaceId && { workspaceId }),
      ...(q.subdir !== undefined && { subdir: q.subdir }),
      limit,
    }))
  })
  route('POST', '/briefings/run', 'operate', req => {
    const filter = parse(api.RunBriefingRequest, req.body ?? {})
    return api.ProjectBriefingView.array().parse(orchestrator.runBriefing('manual', filter))
  })
  route('POST', '/briefings/:id/actions/:index/dispatch', 'operate', async (_req, res, params, actor) => {
    const id = parse(api.BriefingId, params.id)
    const index = /^\d+$/.test(params.index ?? '') ? Number(params.index) : 0
    if (index < 1 || index > 10) throw new HubError('VALIDATION_FAILED', 400)
    const task = await orchestrator.dispatchBriefingAction(id, index, actor)
    return res.code(201).send(api.TaskDetail.parse(task))
  })
  route('GET', '/workspaces', 'read', () => orchestrator.listWorkspacePointers())
  route('POST', '/workspaces/:workerId/:workspaceId/accept', 'operate', (req, _res, params, actor) =>
    orchestrator.acceptRun(parse(api.WorkerId, params.workerId), parse(api.WorkspaceId, params.workspaceId), actor, parse(api.AcceptRunRequest, req.body)))
  route('POST', '/tasks/:ref/followup', 'operate', async (req, res, params, actor) => res.code(201)
    .send(api.TaskDetail.parse(await orchestrator.followUp(ref(params), actor, parse(api.FollowupTaskRequest, req.body), idempotency(req)))))
  route('POST', '/tasks/:ref/deliver-result', 'operate', async (req, _res, params, actor) =>
    api.TaskDetail.parse(await orchestrator.deliverResult(ref(params), actor, parse(api.DeliverResultRequest, req.body))))
  route('GET', '/tasks/:ref/runs/:runId/logs', 'read', (req, _res, params) => {
    const { ref, runId } = parse(api.RunPath, params)
    return api.LogsResponse.parse(orchestrator.logs(ref, runId, parse(api.LogsQuery, req.query)))
  })
  route('GET', '/tasks/:ref/runs/:runId/logs.txt', 'read', (_req, res, params) => {
    const { ref, runId } = parse(api.RunPath, params)
    const first = orchestrator.logs(ref, runId, { afterSeq: 0, limit: 500 })
    function* lines() {
      let page = first
      while (true) {
        for (const entry of page.entries) {
          if (entry.seq > first.lastSeq) return
          if (entry.text !== null) yield entry.text.endsWith('\n') ? entry.text : entry.text + '\n'
          else yield '[' + entry.kind + '] ' + JSON.stringify(entry.data) + '\n'
        }
        if (!page.hasMore) break
        const afterSeq = logEntryEnd(page.entries.at(-1)!)
        if (afterSeq >= first.lastSeq) break
        page = orchestrator.logs(ref, runId, { afterSeq, limit: 500 })
      }
    }
    return res.header('Content-Disposition', 'attachment; filename="' + runId + '-logs.txt"')
      .header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(Readable.from(lines(), { objectMode: false }))
  })
  route('GET', '/audit', 'admin', (req) => api.AuditResponse.parse(listAudit(store.repos, parse(api.AuditQuery, req.query))))
  route('GET', '/config/policies', 'admin', (_req, res) => {
    res.header('X-Policy-Revision', String(ctx.policy.revision()))
    return api.PoliciesResponse.parse(ctx.policy.listRules())
  })
  // 个人方法库（docs/specs/10-method-library.md）
  const methodId = (params: Record<string, string>) => {
    if (!api.MethodId.safeParse(params.id).success) throw new HubError('VALIDATION_FAILED', 404, { reason: 'METHOD_NOT_FOUND' })
    return params.id!
  }
  // 各 Worker 上报的 CLI 订阅额度（面板顶部额度栏）
  route('GET', '/quotas', 'read', () => api.QuotaOverviewResponse.parse(store.tx(db =>
    (db.prepare('SELECT worker_id, quota_json FROM adapter_quota ORDER BY adapter, worker_id').all() as Array<{ worker_id: string; quota_json: string }>)
      .flatMap(row => {
        const quota = api.AdapterQuota.safeParse(JSON.parse(row.quota_json))
        return quota.success ? [{ ...quota.data, workerId: row.worker_id }] : []
      }))))
  route('GET', '/methods', 'read', req => api.MethodListResponse.parse(store.tx(db =>
    listMethods(db, typeof (req.query as Record<string, unknown>).q === 'string' ? (req.query as { q: string }).q : undefined))))
  route('POST', '/methods', 'admin', (req, res, _params, actor) =>
    res.code(201).send(store.tx(db => createMethod(db, req.body, actor, ctx.clock.now()))))
  route('POST', '/methods/suggest', 'read', req =>
    api.MethodSuggestResponse.parse(store.tx(db => suggestFor(db, parse(api.MethodSuggestRequest, req.body).prompt))))
  route('GET', '/methods/:id', 'read', (_req, _res, params) => store.tx(db => getMethod(db, methodId(params))))
  route('PUT', '/methods/:id', 'admin', (req, _res, params, actor) => {
    const { expectedRevision, ...body } = (req.body ?? {}) as { expectedRevision?: number }
    return store.tx(db => updateMethod(db, methodId(params), body, actor, ctx.clock.now(), expectedRevision))
  })
  route('DELETE', '/methods/:id', 'admin', (_req, res, params, actor) => {
    store.tx(db => deleteMethod(db, methodId(params), actor, ctx.clock.now()))
    return res.code(204).send()
  })
  route('POST', '/methods/:id/examples', 'admin', (req, _res, params, actor) =>
    store.tx(db => addMethodExample(db, methodId(params), req.body, actor, ctx.clock.now())))
  route('DELETE', '/methods/:id/examples/:exampleId', 'admin', (_req, _res, params, actor) =>
    store.tx(db => removeMethodExample(db, methodId(params), params.exampleId!, actor, ctx.clock.now())))
  route('PUT', '/config/policies', 'admin', (req, _res, _params, actor) => {
    const { rules, expectedRevision } = parse(api.ReplacePoliciesRequest, req.body)
    return { revision: ctx.policy.replaceRules(rules, actor, expectedRevision) }
  })
  route('GET', '/api-tokens', 'admin', () => api.ApiTokensResponse.parse(auth.listApiTokens()))
  route('POST', '/api-tokens', 'admin', (req, res, _params, actor) => res.code(201).header('Cache-Control', 'no-store')
    .send(api.CreateApiTokenResponse.parse(auth.issueApiToken(parse(api.CreateApiTokenRequest, req.body), actor))))
  route('DELETE', '/api-tokens/:id', 'admin', (_req, res, params, actor) => {
    auth.revokeApiToken(params.id!, actor)
    return res.code(204).send()
  })
  route('GET', '/workers', 'read', () => api.WorkerListResponse.parse(workers.list()))
  route('GET', '/workers/:id', 'read', (_req, _res, params) => {
    const id = workerId(params)
    return api.WorkerDetail.parse({ ...requireWorker(id), recentRuns: store.repos.select().from(taskRuns)
      .where(eq(taskRuns.workerId, id)).orderBy(desc(taskRuns.dispatchedAt)).limit(20).all().map(run => runView(run, store.repos)) })
  })
  route('POST', '/workers/:id/drain', 'operate', async (req, _res, params, actor) => {
    const id = workerId(params)
    await workers.setDrain(id, parse(api.DrainWorkerRequest, req.body).drain, actor)
    return requireWorker(id)
  })
  route('POST', '/workers/:id/probe', 'operate', (req, res, params) => {
    const id = workerId(params)
    requireWorker(id)
    if (!workers.isOnline(id)) throw new HubError('WORKER_OFFLINE', 409)
    const ts = ctx.clock.now()
    const payload = parse(api.WorkerProbe, req.body ?? {})
    void guardAsync(ctx, workers.send(id, { v: 1, id: ulid(ts), ts, type: 'worker.probe', payload }), 'worker probe')
    return res.code(202).send()
  })
  route('POST', '/workers/:id/revoke', 'admin', async (req, _res, params, actor) => {
    const id = workerId(params)
    if (parse(api.RevokeWorkerRequest, req.body).confirm !== id) throw new HubError('VALIDATION_FAILED', 400)
    await workers.revoke(id, actor)
    return requireWorker(id)
  })
  route('POST', '/workers/enroll-tokens', 'admin', (req, _res, _params, actor) => {
    const { suggestedWorkerId } = parse(api.EnrollTokenRequest, req.body ?? {})
    const result = auth.createEnrollToken(actor, suggestedWorkerId)
    const hub = new URL(config.workerPath, config.publicUrl)
    hub.protocol = hub.protocol === 'https:' ? 'wss:' : 'ws:'
    const command = 'agent-worker enroll --hub ' + JSON.stringify(hub.toString()) + ' --token ' + result.token +
      (suggestedWorkerId ? ' --worker-id ' + suggestedWorkerId : '')
    return { ...result, command }
  })
  route('POST', '/worker-enroll', null, (req, res) => {
    const result = auth.enroll(parse(api.WorkerEnrollRequest, req.body), req.ip)
    const worker = workers.get(result.workerId)
    if (worker) ctx.emit('worker/updated', worker, null)
    return res.code(201).send(result)
  })
}
