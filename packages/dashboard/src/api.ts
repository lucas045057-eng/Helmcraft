import { API_PREFIX, ApiError, TaskDetail, HandoffPreview, RunHarnessView, WorkspacePointerView } from '@agent-hub/protocol'

let csrf: string | undefined
export const setCsrf = (token?: string) => { csrf = token }
export const sessionExpired = new EventTarget()

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message)
  }
}

export async function request<T>(path: string, schema: { parse(value: unknown): T }, options?: RequestInit): Promise<T> {
  return (await requestWithHeaders(path, schema, options)).data
}

export async function requestWithHeaders<T>(path: string, schema: { parse(value: unknown): T }, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (options.method && options.method !== 'GET' && csrf) headers.set('X-CSRF-Token', csrf)
  const response = await fetch(API_PREFIX + path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') sessionExpired.dispatchEvent(new Event('expired'))
    const fault = ApiError.safeParse(await response.json().catch(() => null))
    if (fault.success) throw new RequestError(response.status, fault.data.error.code, fault.data.error.message, fault.data.error.details)
    throw new RequestError(response.status, 'HTTP_ERROR', '请求失败 (' + response.status + ')')
  }
  return { data: schema.parse(response.status === 204 || response.status === 202 ? undefined : await response.json()), headers: response.headers }
}

export const emptyResponse = { parse: () => undefined }
export const json = (method: 'POST' | 'PUT' | 'DELETE', body?: object): RequestInit =>
  ({ method, ...(body !== undefined && { body: JSON.stringify(body) }) })
export const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败'
export function searchParams(values: Record<string, string | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  return '?' + params.toString()
}


export function handoffTask(ref: string, input: import('@agent-hub/protocol').HandoffTaskRequest, key: string) {
  return request('/tasks/' + encodeURIComponent(ref) + '/handoff', TaskDetail, { ...json('POST', input), headers: { 'Idempotency-Key': key } })
}
export function handoffPreview(ref: string, query: import('@agent-hub/protocol').HandoffPreviewQuery, signal?: AbortSignal) {
  return request('/tasks/' + encodeURIComponent(ref) + '/handoff-preview' + searchParams(query), HandoffPreview, { signal: signal ?? null })
}
export function runHarness(ref: string, runId: string, signal?: AbortSignal) {
  return request('/tasks/' + encodeURIComponent(ref) + '/runs/' + encodeURIComponent(runId) + '/harness', RunHarnessView, { signal: signal ?? null })
}
export function listWorkspacePointers() { return request('/workspaces', WorkspacePointerView.array()) }
export function acceptWorkspaceRun(worker: string, workspace: string, input: import('@agent-hub/protocol').AcceptRunRequest) {
  return request('/workspaces/' + encodeURIComponent(worker) + '/' + encodeURIComponent(workspace) + '/accept', WorkspacePointerView, json('POST', input))
}
