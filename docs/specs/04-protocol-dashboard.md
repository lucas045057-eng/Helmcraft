# 04 · Hub ↔ Dashboard 协议规格（REST v1 + WebSocket）

> 对应代码：`packages/protocol/src/dashboard/{dto,rest,ws}.ts`、`packages/hub/src/plugins/dashboard-api/`、`packages/dashboard/src/api/`。
> 所有 DTO 以 Zod 定义于 `@agent-hub/protocol`，前后端共享；服务端通过可撤销子路由器的 Zod 校验中间件直接使用同一 Schema 做请求校验与响应序列化（见 01 §4.2）。

---

## 1. 鉴权

### 1.1 模式

| 模式 | 用途 | 机制 |
| :--- | :--- | :--- |
| **会话 Cookie**（主） | 浏览器面板 | `POST /api/v1/auth/login { token }` 校验 Owner 管理令牌（≥ 32 字节随机，由 Owner 自行生成保管；Hub 仅通过环境变量 `HUB_ADMIN_TOKEN_SHA256` 获得其 SHA-256 十六进制值，常量时间比较，明文不落盘）→ 签发会话 |
| **API Token** | 脚本 / CLI 自动化 | `Authorization: Bearer ahk_<base64url>`；在面板创建，Hub 存 SHA-256，可吊销，带 scope（`read` / `operate` / `admin`） |
| 飞书 OAuth SSO | backlog | — |

### 1.2 会话 Cookie

- 名称 `ah_sid`，值为 32 字节随机 base64url；DB `dashboard_sessions` 存其 SHA-256。
- 属性：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`（12 h，滑动续期：剩余 < 50% 时刷新）。
- **CSRF**：登录响应返回 `csrfToken`（与会话绑定），所有非 GET 请求必须带 `X-CSRF-Token` 头；同时校验 `Origin` ∈ `dashboard.allowedOrigins`。
- **登录限速**：每 IP 5 次失败 / 15 min → `429 RATE_LIMITED`（带 `Retry-After`）。
- WebSocket 升级：校验 Cookie 会话 + `Origin` 白名单 + `Sec-WebSocket-Protocol: agent-hub.dashboard.v1`；失败返回 HTTP 401/403 不升级。

### 1.3 权限

v1 面板只有 Owner 角色（单用户系统）。API Token scope：`read` 仅 GET 与 WS；`operate` 可执行任务操作；`admin` 可管理 Worker、策略、令牌。

---

## 2. REST 通用约定

### 2.1 基础

- 前缀 `/api/v1`；`Content-Type: application/json; charset=utf-8`；请求体上限 256 KiB。
- 时间：epoch 毫秒整数。ID：`tsk_<ULID>`、`run_<ULID>`；任务对人展示编号 `taskNo`（整数，显示为 `#123`），所有 `:taskRef` 路径参数同时接受 `tsk_…` 与纯数字编号。
- 每个响应带 `X-Request-Id`（ULID），错误体中同样返回。
- **幂等**：`POST /tasks`、`POST /tasks/:ref/followup` 支持 `Idempotency-Key` 头（≤ 64 字符）。24 h 内同 Key + 同请求体哈希 → 返回首次响应；同 Key 不同请求体 → `409 IDEMPOTENCY_MISMATCH`。
- **乐观并发**：状态变更类请求体可带 `expectedVersion`；不匹配 → `409 VERSION_CONFLICT`，`details.current` 为最新 `TaskView`。
- 分页：游标分页 `?limit=50&cursor=<opaque>`，响应 `{ items, nextCursor? }`；`limit ≤ 200`。

### 2.2 错误响应

```ts
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),              // 面向人的中文描述
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
})
```

### 2.3 错误码表（`ErrorCode`，Hub 全局共享，飞书 Toast 文案按此映射）

| code | HTTP | 含义 |
| :--- | :---: | :--- |
| `VALIDATION_FAILED` | 400 | 请求体/参数 Schema 校验失败，`details.issues` |
| `UNAUTHENTICATED` | 401 | 未登录或会话过期 |
| `CSRF_FAILED` | 403 | CSRF 令牌或 Origin 校验失败 |
| `FORBIDDEN` | 403 | 权限不足（API Token scope、Requester 操作他人任务） |
| `TASK_NOT_FOUND` / `RUN_NOT_FOUND` / `WORKER_NOT_FOUND` | 404 | 资源不存在 |
| `INVALID_TRANSITION` | 409 | 状态机拒绝，`details: { from, event }` |
| `VERSION_CONFLICT` | 409 | 乐观锁冲突，`details.current` |
| `IDEMPOTENCY_MISMATCH` | 409 | 幂等键复用但请求不同 |
| `MAX_ATTEMPTS_REACHED` | 409 | 重试次数已用尽（Owner 可带 `force: true`） |
| `INPUT_REQUEST_CLOSED` | 409 | 输入请求已回答/过期 |
| `WORKER_OFFLINE` | 409 | 需要在线 Worker 的操作（如指定 Worker 的手动派单不会报此错，仅排队） |
| `UNKNOWN_ADAPTER` / `UNKNOWN_WORKSPACE` | 422 | 引用了无任何 Worker 声明的 adapter / 工作区 |
| `PROFILE_NOT_ALLOWED` | 422 | 请求的 profile 超过策略/工作区上限 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 |
| `RATE_LIMITED` | 429 | 限速，带 `Retry-After` |
| `HUB_SHUTTING_DOWN` | 503 | Hub 正在关闭，仅变更类请求返回 |
| `INTERNAL` | 500 | 未预期错误（日志含 requestId） |

---

## 3. 核心 DTO

```ts
// packages/protocol/src/dashboard/dto.ts
export const TaskStatus = z.enum(['awaiting_approval', 'queued', 'dispatching', 'running', 'awaiting_input',
  'cancelling', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled'])
export const RunStatus = z.enum(['dispatching', 'running', 'awaiting_input', 'cancelling',
  'succeeded', 'failed', 'timed_out', 'cancelled', 'refused', 'lost'])

export const ActorView = z.object({
  type: z.enum(['owner', 'requester', 'system', 'worker']),
  id: z.string(), name: z.string().optional(),
  channel: z.enum(['feishu', 'dashboard', 'api', 'system']),
})

export const TaskOrigin = z.object({
  source: z.enum(['feishu', 'dashboard', 'api']),
  feishu: z.object({ chatId: z.string(), chatType: z.enum(['p2p', 'group']), chatName: z.string().optional(),
    messageId: z.string() }).optional(),
})

export const TaskSummary = z.object({
  id: z.string(), taskNo: z.number().int(), version: z.number().int(),
  title: z.string(),                         // prompt 前 80 字符（脱敏）
  status: TaskStatus,
  priority: z.number().int(),
  requester: ActorView, origin: TaskOrigin,
  adapter: z.string().nullable(), workspaceId: z.string(), profile: z.enum(['readonly', 'edit', 'full']),
  workerId: z.string().nullable(),           // 当前/最后一次 Run 的 Worker
  attempt: z.number().int(), maxAttempts: z.number().int(),
  parentTaskId: z.string().nullable(),
  lastProgress: z.string().nullable(),       // 最新一行进展（≤ 200 字符）
  scheduleHint: z.string().nullable(),       // 不可调度原因
  workerConnection: z.enum(['online', 'suspect', 'offline']).nullable(), // 当前 Run 所在 Worker 的连接状态
  graceUntil: z.number().int().nullable(),   // 宽限期截止
  errorCode: z.string().nullable(),
  resultDeliveryStatus: z.enum(['not_required', 'pending_review', 'delivered', 'suppressed']),
  createdAt: z.number().int(), updatedAt: z.number().int(),
  startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
  allowedActions: z.array(z.enum(['approve', 'reject', 'cancel', 'retry', 'input', 'followup', 'deliver_result'])), // 由共享 reducer 计算
})

export const RunView = z.object({
  id: z.string(), taskId: z.string(), attempt: z.number().int(),
  workerId: z.string(), adapter: z.string(), workspaceId: z.string(), profile: z.string(),
  status: RunStatus, pid: z.number().int().nullable(), cliVersion: z.string().nullable(),
  cliSessionId: z.string().nullable(),
  exitCode: z.number().int().nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
  summary: z.string().nullable(),
  usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(),
    costUsd: z.number().optional() }).nullable(),
  lastSeq: z.number().int(), logBytes: z.number().int(), logDroppedBytes: z.number().int(),
  dispatchedAt: z.number().int(), startedAt: z.number().int().nullable(), finishedAt: z.number().int().nullable(),
})

export const TaskDetail = TaskSummary.extend({
  prompt: z.string(),
  resultSummary: z.string().nullable(),
  runs: z.array(RunView),
  inputRequest: z.object({ requestId: z.string(), question: z.string(), options: z.array(z.string()).optional(),
    expiresAt: z.number().int() }).nullable(),
  policyDecision: z.object({ ruleId: z.string().nullable(), decision: z.string(), clampedProfile: z.string().optional() }),
  timeline: z.array(z.object({ ts: z.number().int(), event: z.string(), from: z.string().nullable(),
    to: z.string().nullable(), actor: ActorView, note: z.string().optional() })),  // 来自 audit_logs
  children: z.array(z.object({ id: z.string(), taskNo: z.number().int(), status: TaskStatus })),
})

export const LogEntry = z.object({
  seq: z.number().int(), ts: z.number().int(),
  kind: z.enum(['started', 'log', 'agent', 'session', 'progress', 'input_request', 'dropped', 'gap', 'finished', 'system']),
  stream: z.enum(['stdout', 'stderr', 'system']).nullable(),
  text: z.string().nullable(),
  data: z.unknown().nullable(),              // agent 事件、finished 详情、gap 区间等
})

export const WorkerView = z.object({
  id: z.string(), displayName: z.string(),
  status: z.enum(['active', 'revoked']),
  connection: z.enum(['online', 'suspect', 'offline']),
  drain: z.boolean(), drainSource: z.enum(['hub', 'worker']).nullable(),
  hostname: z.string().nullable(), os: z.string().nullable(), arch: z.string().nullable(), agentVersion: z.string().nullable(),
  maxConcurrency: z.number().int(), slotsUsed: z.number().int(),
  rttMs: z.number().nullable(),
  load: z.object({ cpuPercent: z.number().optional(), memFreeMb: z.number(), memTotalMb: z.number() }).nullable(),
  adapters: z.array(AdapterCapability),      // 见 03
  workspaces: z.array(WorkspaceDecl),
  activeRunIds: z.array(z.string()),
  graceUntil: z.number().int().nullable(),
  bufferedBytes: z.number().int(), droppedLogBytesTotal: z.number().int(),
  lastSeenAt: z.number().int().nullable(), connectedAt: z.number().int().nullable(),
})

export const Overview = z.object({
  workersOnline: z.number().int(), workersTotal: z.number().int(),
  slotsUsed: z.number().int(), slotsTotal: z.number().int(),
  counts: z.record(TaskStatus, z.number().int()),      // 当前各状态任务数
  today: z.object({ succeeded: z.number().int(), failed: z.number().int(), cancelled: z.number().int(),
    successRate: z.number().nullable(), p50DurationMs: z.number().nullable(), p90DurationMs: z.number().nullable() }),
  feishu: z.object({ state: z.enum(['disabled', 'connecting', 'connected', 'reconnecting', 'failed']), since: z.number().int() }),
  hub: z.object({ bootId: z.string(), startedAt: z.number().int(), version: z.string(), draining: z.boolean(),
    restartRequired: z.boolean(), configError: z.string().nullable() }),
})
```

`today` 以 Hub 配置时区 `server.timezone`（默认 `Asia/Shanghai`）的自然日计算。

---

## 4. REST 端点

### 4.1 系统与鉴权

| 方法 | 路径 | 请求 | 响应 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/healthz` | — | `{ ok: true }` | 无鉴权；进程存活 |
| GET | `/readyz` | — | `200 { ready: true }` / `503` | 无鉴权；关键插件全部 ACTIVE 且非 draining |
| POST | `/api/v1/auth/login` | `{ token: string }` | `{ csrfToken, expiresAt }` + Set-Cookie | 无需 CSRF |
| POST | `/api/v1/auth/logout` | — | `204` | |
| GET | `/api/v1/auth/me` | — | `{ principal: { type:'owner', via:'session'\|'token', scopes }, csrfToken }` | 面板刷新后取回 CSRF |
| GET | `/api/v1/overview` | — | `Overview` | |
| GET | `/api/v1/system/metrics` | — | 指标 JSON | scope `admin` |
| GET | `/api/v1/system/fibers` | — | `[{ name, state, error? }]` | 插件健康（scope `admin`） |

### 4.2 任务

| 方法 | 路径 | 请求 | 响应 | 状态机事件 |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/tasks` | Query：`status`(逗号分隔), `workerId`, `adapter`, `source`, `requesterId`, `q`(prompt 全文 LIKE), `parentTaskId`, `from`, `to`, `limit`, `cursor` | `{ items: TaskSummary[], nextCursor? }` | — |
| POST | `/api/v1/tasks` | `CreateTaskRequest` | `201 TaskDetail` | SUBMIT（面板来源 actor=owner → 默认 auto_approve） |
| GET | `/api/v1/tasks/:ref` | — | `TaskDetail` | — |
| POST | `/api/v1/tasks/:ref/approve` | `{ expectedVersion?, overrides?: ApprovalOverrides }` | `TaskDetail` | APPROVE |
| POST | `/api/v1/tasks/:ref/reject` | `{ expectedVersion?, reason?: string(≤500) }` | `TaskDetail` | REJECT |
| POST | `/api/v1/tasks/:ref/cancel` | `{ reason?: string }` | `TaskDetail`（可能为 `cancelling`） | CANCEL |
| POST | `/api/v1/tasks/:ref/retry` | `{ overrides?: ApprovalOverrides, force?: boolean }` | `TaskDetail` | RETRY |
| POST | `/api/v1/tasks/:ref/input` | `{ requestId: string, answer: string(≤20000) }` | `TaskDetail` | INPUT_PROVIDE |
| POST | `/api/v1/tasks/:ref/followup` | `{ prompt: string }` | `201 TaskDetail`（子任务） | 子任务 SUBMIT |
| POST | `/api/v1/tasks/:ref/deliver-result` | `{ action: 'send' \| 'suppress', summaryOverride?: string(≤20000) }` | `TaskDetail` | `owner_review` 模式下审核回传/屏蔽结果给 Requester（幂等） |
| GET | `/api/v1/tasks/:ref/runs/:runId/logs` | Query：`afterSeq`(默认 0), `limit`(≤1000, 默认 500), `kinds`(逗号分隔) | `{ entries: LogEntry[], lastSeq: number, hasMore: boolean, runFinished: boolean }` | — |
| GET | `/api/v1/tasks/:ref/runs/:runId/logs.txt` | — | 纯文本下载（`text/plain`，流式输出） | — |

```ts
export const CreateTaskRequest = z.object({
  prompt: z.string().min(1).max(32_000),
  workspaceId: z.string(),
  subdir: z.string().max(256).optional(),
  adapter: AdapterId.optional(),              // 不填则按 adapterPrefs / 全局默认顺序
  adapterPrefs: z.array(AdapterId).max(5).optional(),
  profile: z.enum(['readonly', 'edit', 'full']).default('edit'),
  requiredWorkerId: z.string().optional(),     // 手动派单到指定 Worker
  preferredWorkerId: z.string().optional(),
  priority: z.number().int().min(-10).max(10).default(0),
  timeoutMs: z.number().int().min(60_000).max(24 * 3600_000).optional(),
  model: z.string().max(128).optional(),
  notifyFeishuChatId: z.string().optional(),   // 可选：结果同时推送到某飞书会话
})

export const ApprovalOverrides = z.object({
  adapter: AdapterId.optional(), workspaceId: z.string().optional(), subdir: z.string().optional(),
  profile: z.enum(['readonly', 'edit', 'full']).optional(),
  prompt: z.string().min(1).max(32_000).optional(),   // 改写需求（原 prompt 保留在审计中）
  requiredWorkerId: z.string().optional(), timeoutMs: z.number().int().optional(),
})
```

### 4.3 Worker 管理

| 方法 | 路径 | 请求 | 响应 | scope |
| :--- | :--- | :--- | :--- | :--- |
| GET | `/api/v1/workers` | — | `WorkerView[]` | read |
| GET | `/api/v1/workers/:id` | — | `WorkerView & { recentRuns: RunView[] }` | read |
| POST | `/api/v1/workers/:id/drain` | `{ drain: boolean, reason?: string }` | `WorkerView` | operate |
| POST | `/api/v1/workers/:id/probe` | — | `202` | operate |
| POST | `/api/v1/workers/:id/revoke` | `{ confirm: worker id 原文 }` | `WorkerView` | admin |
| POST | `/api/v1/workers/enroll-tokens` | `{ suggestedWorkerId?: string }` | `{ token, expiresAt, command: "agent-worker enroll --hub … --token …" }` | admin |
| POST | `/api/v1/worker-enroll` | `{ token, workerId, publicKey, hostname, os }` | `201 { workerId, keyFingerprint }` | **无会话**，凭一次性 token；IP 限速 10/h |

### 4.4 审计、策略与令牌

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/v1/audit?targetType=&targetId=&actorId=&action=&limit=&cursor=` | 审计日志 |
| GET | `/api/v1/config/policies` | `PolicyRule[]`（见 02 §5） |
| PUT | `/api/v1/config/policies` | `{ rules: PolicyRule[], expectedRevision: number }` 全量替换，返回新 revision；正则编译失败 → 400 |
| GET | `/api/v1/api-tokens` / POST / DELETE `/:id` | API Token 管理（创建时明文只返回一次） |

---

## 5. WebSocket：`/ws/dashboard`

### 5.1 帧格式

所有帧 `{ "t": <type>, ... }` 单个 JSON 文本消息。客户端帧上限 16 KiB。

**客户端 → 服务端**

```ts
export const DashClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), resume: z.object({ bootId: z.string(), eventSeq: z.number().int() }).optional() }),
  z.object({ t: z.literal('subscribe'), topics: z.array(Topic).max(32) }),
  z.object({ t: z.literal('unsubscribe'), topics: z.array(Topic).max(32) }),
  z.object({ t: z.literal('follow'), runId: z.string(), fromSeq: z.number().int().nonnegative() }),  // 日志跟随
  z.object({ t: z.literal('unfollow'), runId: z.string() }),
  z.object({ t: z.literal('ping'), n: z.number().int() }),
])
export const Topic = z.union([
  z.literal('overview'), z.literal('workers'), z.literal('tasks'),
  z.string().regex(/^task:tsk_[0-9A-HJKMNP-TV-Z]{26}$/),
])
```

**服务端 → 客户端**

```ts
export const DashServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), bootId: z.string(), eventSeq: z.number().int(), serverTime: z.number().int(),
    resumed: z.boolean() }),             // resumed=true 表示随后补发错过的事件；false 表示客户端需重新拉快照
  z.object({ t: z.literal('snapshot'), eventSeq: z.number().int(), overview: Overview,
    workers: z.array(WorkerView), activeTasks: z.array(TaskSummary) }),   // subscribe 'overview'/'workers'/'tasks' 后发送
  z.object({ t: z.literal('event'), eventSeq: z.number().int(), topic: z.string(), type: DashEventType, data: z.unknown() }),
  z.object({ t: z.literal('logs'), runId: z.string(), entries: z.array(LogEntry), live: z.boolean() }),
  z.object({ t: z.literal('logs.reset'), runId: z.string(), reason: z.enum(['slow_consumer', 'run_not_found', 'server_restart']),
    resumeFromSeq: z.number().int() }),
  z.object({ t: z.literal('resync'), reason: z.enum(['gap_too_large', 'slow_consumer', 'boot_changed']) }),
  z.object({ t: z.literal('pong'), n: z.number().int(), serverTime: z.number().int() }),
  z.object({ t: z.literal('error'), code: ErrorCode, message: z.string() }),
])

export const DashEventType = z.enum([
  'task.created',        // data: TaskSummary              topic: tasks（及 task:<id>）
  'task.updated',        // data: TaskSummary              topic: tasks, task:<id>
  'task.detail',         // data: TaskDetail               topic: task:<id>（仅订阅了该任务详情的连接）
  'run.updated',         // data: RunView                  topic: task:<id>
  'worker.updated',      // data: WorkerView               topic: workers
  'worker.removed',      // data: { id }                   topic: workers
  'overview.updated',    // data: Overview（≤1 次/秒节流）  topic: overview
  'system.status',       // data: Overview['hub'] & { feishu } topic: overview
])
```

### 5.2 事件序号与断线续传

- Hub 维护进程级单调递增 `eventSeq` 和最近 **10 000** 条事件的环形缓冲（仅 `event` 帧；`logs` 帧不进入）。
- 客户端重连 `hello{resume:{bootId, eventSeq}}`：
  - `bootId` 一致且 `eventSeq` 仍在环形缓冲内 → `welcome{resumed:true}` + 补发 `eventSeq` 之后的事件（只补发其订阅主题）；
  - 否则 → `welcome{resumed:false}`，客户端必须重新 `subscribe` 以获得 `snapshot`（`resync` 语义）。
- 客户端以 `eventSeq` 去重并丢弃 `≤ 已处理` 的事件。`snapshot.eventSeq` 表示快照对应的事件位置：客户端应用快照后只处理 `eventSeq > snapshot.eventSeq` 的事件。**服务端在生成快照与注册订阅时必须在同一个同步块内完成**（单线程保证无竞态）。

### 5.3 日志跟随（追赶 + 实时拼接）

```text
on follow(runId, fromSeq):
  1. 同步：注册 live 监听（把新到的 run/events 先放入该订阅的 pendingLive 缓冲）
  2. 读取 DB：seq > fromSeq，分页 500 条，逐页发送 logs{live:false}
     （若 Run 不存在 → logs.reset{reason:'run_not_found'}）
  3. 记 sentUpTo = 已发送的最大 seq
  4. 发送 pendingLive 中 seq > sentUpTo 的部分，然后切换为直推模式：logs{live:true}
  5. 直推时合并：每 100ms 或 200 条一帧
```

- 每连接同时 follow 的 Run ≤ 8；超出 → `error{code:'RATE_LIMITED'}`。
- 面板默认只 follow 抽屉中打开的 Run；看板卡片的“最新一行进展”来自 `task.updated.lastProgress`（服务端节流 1 次/2s/任务），**不需要** follow。

### 5.4 慢消费者与背压

| 条件 | 动作 |
| :--- | :--- |
| `ws.bufferedAmount > 4 MiB` 或连接待发队列 > 2 MiB | 对该连接的所有 follow 发送 `logs.reset{reason:'slow_consumer', resumeFromSeq}` 并取消 follow（客户端稍后用 REST 拉取或重新 follow） |
| 仍高于阈值 10 s | 发送 `resync{reason:'slow_consumer'}` 后关闭（4008），客户端重连走快照 |
| `overview.updated` | 始终节流合并（最新值覆盖），不进入队列积压 |
| `task.updated` 同一任务在 250 ms 内多次 | 合并为最后一次 |

### 5.5 心跳

客户端每 25 s 发 `ping`；服务端 60 s 未收到任何帧 → 关闭（4008）。服务端另发 WS ping（30 s）检测半开连接。

### 5.6 关闭码

| Code | 含义 | 客户端行为 |
| :--- | :--- | :--- |
| 1001 | Hub 关闭 | 2–5 s 抖动后重连 |
| 4001 | 会话失效 | 跳转登录 |
| 4008 | 超时 / 慢消费者 | 立即重连 + 快照 |
| 4029 | 连接数超限（每会话 ≤ 5 条 WS） | 提示 |

---

## 6. 面板信息架构对 API 的依赖

| 区域 | 初始数据 | 实时更新 |
| :--- | :--- | :--- |
| 顶部态势栏 | `snapshot.overview` | `overview.updated`、`system.status` |
| Worker 拓扑 | `snapshot.workers` | `worker.updated`（含 `graceUntil` 倒计时、槽位、adapter 徽章） |
| 任务看板/列表 | `snapshot.activeTasks` + `GET /tasks`（历史分页） | `task.created` / `task.updated` |
| 任务抽屉 | `GET /tasks/:ref` + `subscribe task:<id>` | `task.detail`、`run.updated`、`follow` 日志 |
| 审批/操作按钮 | `TaskSummary.allowedActions` + `version` | 同上；操作请求带 `expectedVersion` |

前端技术建议（非强制）：React 18 + Vite + TanStack Query（REST 缓存）+ Zustand（WS 实时状态）+ xterm.js（Raw 终端视图）+ 虚拟列表（日志 > 10 000 行）。终端视图对 `text` 做 ANSI 解析；结构化视图渲染 `kind='agent'` 事件（思考 / 工具调用 / 文件改动 / 回复）。

---

## 7. Phase 7 增量（Blackboard & Harness，权威规格见 [08](08-blackboard-harness.md)）

> 规则：对既有 DTO 的新增字段全部 `.optional()`，**没有 Harness 数据时必须省略（不得输出 `null`）**，因此 Phase 0–6 的响应、WS 帧与 fixtures 逐字节不变。不新增 `ErrorCode`（原因放在 `details.reason`）。

| 本文位置 | Phase 7 增量 | 08 |
| :--- | :--- | :--- |
| §3 DTO | `RunView.harness?: RunHarnessSummary`；`TaskSummary.verification?: VerificationState`；`TaskDetail.handoff?`；`WorkerView.protocolCapabilities?`；`LogEntry.kind` 追加 `harness` / `workspace` / `verify` | §9.1 |
| §4.2 `ApprovalOverrides` | 可选 `harness: { blackboard?, verify? }`（Owner 为 Requester 任务显式开启/关闭黑板与验证） | §8.2、§9.1 |
| §4.2 任务端点 | `POST /api/v1/tasks/:ref/handoff`（`201 TaskDetail`，支持 `Idempotency-Key`）、`GET /api/v1/tasks/:ref/handoff-preview`、`GET /api/v1/tasks/:ref/runs/:runId/harness` | §9.2 |
| 新增：工作区指针 | `GET /api/v1/workspaces`（read）、`POST /api/v1/workspaces/:workerId/:workspaceId/accept`（operate，Owner“采纳为 lastAccepted”） | §8.5.5、§9.2 |
| §5.1 WS 事件 | `DashEventType` 追加 `workspace.updated`（`data: WorkspacePointerView`，topic `workers`）；日志跟随中新 kind 的 `data` 不含黑板正文 | §9.3 |
| §6 信息架构 | 任务抽屉新增：换 CLI 接力弹窗、黑板 Pre/Post 快照与 diff 查看器（复制 / 恢复指令）、验证面板（带报错修复 / 换 CLI 修复）、工作区指针指示；看板卡片新增验证徽章 | §9.4 |
| fixtures | 新 DTO 以导出名命名放入 `fixtures/dashboard/{valid,invalid}/`；既有 fixtures 不修改 | §5.7 |
