import type { ErrorCode } from '@agent-hub/protocol'
const messages: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: '请求参数无效', UNAUTHENTICATED: '请登录', CSRF_FAILED: '请求来源校验失败',
  FORBIDDEN: '无权限', HUB_SHUTTING_DOWN: 'Hub 正在关闭', RATE_LIMITED: '请求过于频繁',
  TASK_NOT_FOUND: '任务不存在', RUN_NOT_FOUND: '运行记录不存在', WORKER_NOT_FOUND: 'Worker 不存在',
  VERSION_CONFLICT: '任务版本已变化', INVALID_TRANSITION: '当前状态不允许此操作', INTERNAL: '内部错误',
}
export class HubError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number, readonly details?: Record<string, unknown>, readonly retryAfter?: number) {
    super(messages[code] ?? code)
  }
}
