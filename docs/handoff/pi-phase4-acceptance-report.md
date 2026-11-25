# Pi 独立验收报告 · Phase 4（虚拟中台指挥台面板：REST + WS + 静态站 + React 前端）

> 验收人：Pi（独立测试工程师） · 工作区：`E:\Agent工作流`
> 依据：`docs/handoff/pi-test-matrix.md`（§9 `SEC-15`~`SEC-17`、§11 `API-1`~`API-12`、§12 `DASH-1`~`DASH-8`、§16 Phase 4 门禁）、规格 `docs/specs/04-protocol-dashboard.md`
> 被测对象：`packages/protocol/src/dashboard/*`、`packages/hub/src/plugins/dashboard-api/*`、`packages/hub/src/plugins/dashboard-static/*`、`packages/dashboard/src/*`（Codex 交付）
> 基线：工作区非 git 仓库，以当前文件树为准。**本轮未修改任何业务实现代码**（只新增测试与测试基础设施、以及在根 `package.json` 增加测试专用的 `playwright` devDependency）。

---

## 0. 结论

**Phase 4 门禁：通过（无 P0 / 无 P1）。** 3 项 P2/P3 观察项、1 项环境抖动、4 项未覆盖范围见 §5，均不阻塞放行。

| 项目 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ 通过（6 包全量增量构建；仅 vite 对 `@tanstack/react-query` 的 `"use client"` 指令既有告警，与实现无关） |
| `pnpm lint` | ✅ 通过（0 error / 0 warning） |
| `pnpm depcheck` | ✅ 通过（146 modules / 408 dependencies，no violations） |
| `pnpm test` | ✅ **46 files / 800 passed / 1 skipped**（本轮新增 4 文件 / 33 用例） |
| 新增 `*.pi.test.ts` | **4 文件 / 33 用例**，全部通过 |

唯一 skip 为 Phase 2 已存在的 POSIX 专属用例（`packages/worker/test/process.test.ts` 的独立进程组用例），Windows 上按设计跳过，与本轮无关。

### 本轮新增测试文件

| 文件 | 用例数 | 覆盖 |
| :--- | :--- | :--- |
| `packages/hub/test/phase4-api-rest.pi.test.ts` | 12 | API-1（全端点 DTO 严格校验）、API-2（20 个错误码逐项）、API-3、API-4、API-5、API-12 |
| `packages/hub/test/phase4-api-ws.pi.test.ts` | 7 | API-6、API-7、API-8、API-9、API-10、API-11 + `task:<id>` 主题 / 32 主题上限 |
| `packages/hub/test/phase4-security.pi.test.ts` | 6 | SEC-15（CSRF + 静态站穿越）、SEC-16、SEC-17 |
| `packages/hub/test/phase4-dash-ui.pi.test.ts` | 8 | DASH-1 ~ DASH-8（真实 Chromium + 真实 Hub + 真实 Worker 进程 + mock-cli） |
| 测试基础设施（新增） | — | `packages/hub/test/pi/rest.ts`（inject 客户端 / DTO 断言 / 错误断言）、`packages/hub/test/pi/dash.ts`（裸 `DashClientFrame`/`DashServerFrame` 客户端）；`pi/harness.ts` 的 `ChaosProxy` 增加 `down()`/`up()`（彻底断网模式，仅测试用） |

### 验收环境

| 项 | 实测值 |
| :--- | :--- |
| OS / Node / pnpm / vitest | Windows NTFS / `v24.14.1` / `11.17.0` / `4.1.12` |
| 浏览器 | 系统 Chrome `158.0.0.0`（Playwright `chromium.launch({ channel: 'chrome' })`，未下载 Playwright 自带 Chromium） |
| 真实 Worker | `packages/worker/src/app.ts · startWorker`（`mock` adapter + mock-cli 剧本，真实子进程） |
| 数据库 | 每个用例独立临时目录 SQLite 文件（WAL），非 `:memory:` |
| 网络 | 全部请求指向 `127.0.0.1` 随机端口；未发起任何外网/真实 LLM 请求 |

---

## 1. Codex 现有测试的覆盖缺口与本轮补强

Codex 已有 `packages/hub/test/phase4-dashboard.test.ts`（11 用例）覆盖了策略/令牌、CSRF、续传、日志分页、慢消费者、时区、静态站、4029、宽限期、合并节流、登录限速。质量较高，但与本轮门禁清单相比存在以下缺口：

| ID | Codex 已有 | 缺口 | Pi 补强方式 |
| :--- | :--- | :--- | :--- |
| API-1 | 仅 `/config/policies`、`/api-tokens`、`/logs.txt`、`/overview`（间接触及） | **大部分端点无成功路径用例**；所有响应均未用共享 DTO Schema 校验 | 25 个端点逐一 `inject` 并 `safeParse` 对应 `@agent-hub/protocol` Schema（`TaskDetail` / `TaskListResponse` / `LogsResponse` / `WorkerView` / `WorkerDetail` / `EnrollTokenResponse` / `WorkerEnrollResponse` / `AuditResponse` / `PoliciesResponse` / `ApiTokensResponse` / `MetricsResponse` / `FibersResponse` / `AuthMeResponse` / `LoginResponse` / `ReadyResponse` / `HealthResponse` / `Overview`），并断言 `X-Request-Id` 为 ULID、`Content-Type: application/json` |
| API-2 | 仅 `CSRF_FAILED`、`RATE_LIMITED`、`HUB_SHUTTING_DOWN`、`VERSION_CONFLICT`（策略修订） | **错误码表 20 项缺 16 项**；未断言 `error.requestId` 与 `X-Request-Id` 一致；`details` 结构未校验 | 20 个码逐项触发（见 §2.2）；每条断言 `status` + `error.code` + `requestId===X-Request-Id`；`VALIDATION_FAILED.details.issues`、`INVALID_TRANSITION.details.{from,event}`、`VERSION_CONFLICT.details.current.id`、`Retry-After` 全部断言 |
| API-3 | 无 | 完全未测 | 同 key 同 body 复用首次响应（含 `followup`）、同 key 不同 body → 409、>64 字符键 → 400、跨 token 命名空间行为 |
| API-4 | 无 | 完全未测 | `tsk_…` 与纯数字（`GET`/`POST`）等价、非法 ref → 400、`%23<no>` 实际行为 |
| API-5 | 无 | 完全未测 | 60 任务 / 3 页、第 1 页后插入新任务，断言无重复无遗漏、无效游标 400 |
| API-6 | 无（续传用例间接触及） | 快照与订阅的时序竞态、`eventSeq` 全局严格递增、`task:<id>` 主题、32 主题上限均未测 | 同一同步块内快照先于增量的**索引断言**、20 条增量一条不丢、`task.detail` 主题、cumulative>32 → `RATE_LIMITED` |
| API-7 | 100 次 `worker/updated` 的续传 | ①未混入**未订阅主题**验证过滤；②未断言补发总数与 `welcome.eventSeq` 的偏移；③未断言续传后不发快照 | 100 个已订阅 + 25 个未订阅事件；断言只补发 100 条 subscribed、`eventSeq = snapshot+125`、无 `snapshot`/`resync` |
| API-8 | 越界（10 001） | bootId 变化未测；未断言越界后确实重新发快照 | 越界 + bootId 变化两条，均断言 `resumed=false`、`eventSeq` 正确、随后 `snapshot.eventSeq` 对齐 |
| API-9 | 1 001 条追赶 + 10 条实时 | 未做**追赶期间持续写入**的拼接压力；未与 DB 逐条比对；未测 >8 follow 限流与 `run_not_found` | 1 200 预置 + 追赶期 600 条 + 实时期 600 条（合计 2 400），断言 `seq = [1..2400]` 严格连续、无重复、与 `task_logs` 完全一致、`live:false` 与 `live:true` 两类帧均出现、无 `logs.reset`；8+1 follow → `RATE_LIMITED`；不存在 Run → `logs.reset(run_not_found)` |
| API-10 | 有（`logs.reset` + `resync` + 4008） | 未测 Hub 内存稳定性与背压清理后的可用性 | 追加 RSS 增长 < 200 MiB；关闭后新建面板会话仍可正常 `hello`/`follow` |
| API-11 | 有（10 次 → 1 次，249/250 ms 边界） | 未断言「1~2 次」上界与 topic 归属 | 断言 0 次 @249 ms、1~2 次 @250 ms、最后一次 `data.version=11` 且 `topic='tasks'`；再推进 1 s 确认无多余推送 |
| API-12 | 部分（策略 PUT 503 + overview 200） | 未覆盖 POST/DELETE、未覆盖 `/readyz` 变化 | POST/PUT/DELETE 四类 → 503；GET 四类 → 200；`/healthz` 200、`/readyz` 503 `{ready:false}` |
| SEC-15 | 仅 `logout` 无 CSRF | DELETE/PUT 未测；**路径穿越完全未测** | POST/PUT/DELETE/`logout` 四类 × 缺失/错误 CSRF；错误/缺失 Origin；正确组合 201；静态站 14 种穿越/符号链接攻击 |
| SEC-16 | 错误 Origin + 4029 | 未登录、缺失/错误子协议、吊销后续传、连接释放后重建均未测 | 6 种升级失败 → 401/403/403/403/403/101；吊销 → 4001 + 升级 401；前 5 条存活、关闭后重建成功 |
| SEC-17 | 登录第 6 次 429 | `Retry-After` 上界未断言、成功登录不清零未验证；**scope 隔离完全未测** | 5 次 401 后第 6 次 429 + `Retry-After ∈ (0,900]` + 正确令牌也 429；read/operate/admin 三级共 18 条越权组合 |
| DASH-1~8 | **无任何浏览器测试**（前端只有 1 个纯函数单测 `command-center.test.ts`） | 全部 8 条 UI 门禁未覆盖 | 见 §3 |

---

## 2. API 门禁实测明细

### 2.1 API-1 · 端点成功路径 + DTO 严格校验（25 个端点）

`GET /healthz`、`GET /readyz`、`POST /auth/login`、`POST /auth/logout`(204)、`GET /auth/me`（session 与 token 两种 principal）、`GET /overview`、`GET /system/metrics`、`GET /system/fibers`、`GET /tasks`、`POST /tasks`(201)、`GET /tasks/:ref`、`POST /tasks/:ref/{approve,reject,cancel,retry,input,followup,deliver-result}`、`GET /tasks/:ref/runs/:runId/logs`、`GET /tasks/:ref/runs/:runId/logs.txt`、`GET /workers`、`GET /workers/:id`、`POST /workers/:id/drain`、`POST /workers/:id/probe`(202)、`POST /workers/:id/revoke`、`POST /workers/enroll-tokens`、`POST /worker-enroll`(201)、`GET /audit`、`GET /config/policies`（含 `X-Policy-Revision`）、`PUT /config/policies`、`GET/POST/DELETE /api-tokens`。

补充断言：
- `POST /auth/login` 的 `Set-Cookie` 形态为 `ah_sid=<43 字符>; HttpOnly; SameSite=Strict; Path=/; Max-Age=…`（明文环境不追加 `Secure`）。
- `POST /api-tokens` 响应带 `Cache-Control: no-store`，且 `GET /api-tokens` 正文**不含**明文令牌。
- `approve` 带 `overrides.prompt` 后 `TaskDetail.prompt` 为覆写值、`version` 递增、`timeline` 出现 `Prompt 覆写` note。
- `followup` 子任务的 `children` 反查与 `parentTaskId` 一致。
- `deliver-result` 将 `pending_review → delivered`。
- `logs.txt` 为 `text/plain; charset=utf-8` + `Content-Disposition: attachment`，正文与 `task_logs.text` 逐行一致。

### 2.2 API-2 · 错误码表逐项触发（20 项，19 项可通过 REST 触发）

| code | HTTP | 触发方式（实测） |
| :--- | :---: | :--- |
| `VALIDATION_FAILED` | 400 | `prompt:''`（`details.issues` 非空）；`limit=0`；未知 query 参数；未知 ref；错误游标；策略正则无法编译 |
| `UNAUTHENTICATED` | 401 | 无 `Authorization`；`ahk_invalid`；登出后的会话 Cookie |
| `CSRF_FAILED` | 403 | 会话 + 无/错 `X-CSRF-Token`；错误/缺失 `Origin` |
| `FORBIDDEN` | 403 | `read` scope 调 operate/admin（10 条组合）；`operate` 调 admin（10 条组合） |
| `TASK_NOT_FOUND` | 404 | 未知 `tsk_…`（含 `/runs/:runId/logs` 先解析任务） |
| `RUN_NOT_FOUND` | 404 | 任务存在、`run_…` 不存在 |
| `WORKER_NOT_FOUND` | 404 | `GET /workers/ghost-worker` |
| `INVALID_TRANSITION` | 409 | `approve` 一个 `queued` 任务（`details={from:'queued',event:'APPROVE'}`） |
| `VERSION_CONFLICT` | 409 | `cancel` 带过期 `expectedVersion`（`details.current.id` 为最新任务） |
| `IDEMPOTENCY_MISMATCH` | 409 | 同 key 不同 body（`POST /tasks` 与 `POST /followup` 各 1 例） |
| `INPUT_REQUEST_CLOSED` | 409 | `awaiting_input` 任务用不匹配的 `requestId` 提交答复 |
| `WORKER_OFFLINE` | 409 | 已注册但未连接的 Worker `probe` |
| `UNKNOWN_ADAPTER` | 422 | 审批覆写 `adapter:'gemini'`（无 Worker 声明） |
| `UNKNOWN_WORKSPACE` | 422 | 审批覆写 `workspaceId:'ghost-workspace'` |
| `PROFILE_NOT_ALLOWED` | 422 | 策略 clamp 到 `readonly` 后覆写 `profile:'edit'` |
| `PAYLOAD_TOO_LARGE` | 413 | 300 KiB JSON 体（上限 256 KiB） |
| `RATE_LIMITED` | 429 | 登录失败第 6 次，`Retry-After ∈ (0,900]` |
| `HUB_SHUTTING_DOWN` | 503 | `setAccepting(false)` 后 POST/PUT/DELETE |
| `INTERNAL` | 500 | 故障注入：`DROP TABLE audit_logs` 后 `GET /tasks/:ref`（未预期异常经统一 error handler 映射，仍带 `requestId`） |
| `MAX_ATTEMPTS_REACHED` | 409 | **无法通过 REST 触发**，见 §5 · P2-1 |

### 2.3 API-3 ~ API-5、API-12

- **API-3**：`POST /tasks` 同 key 同 body 三次 → 两次 201 且响应体**逐字节相同**、`tasks` 表仍 1 行；同 key 不同 body → 409 `IDEMPOTENCY_MISMATCH`；`Idempotency-Key` 65 字符 → 400；`POST /tasks/:ref/followup` 同样幂等。
- **API-4**：`GET /tasks/1` 与 `GET /tasks/tsk_…` 响应深度相等；`approve`/`reject` 在两种 ref 下错误码一致；`cancel`（数字）与 `retry`（`tsk_`）成功且语义一致。`GET /tasks/%231` → 400 `VALIDATION_FAILED`（见 P3-1）。
- **API-5**：60 个任务 / `limit=25` → 3 页；第 1 页后插入新任务，后两页不受影响；合并 3 页 = 60 个 id，**无重复**（`Set.size === length`）、**无遗漏**（与创建集合排序相等）。
- **API-12**：`HUB_SHUTTING_DOWN` 期间 GET `/overview`、`/tasks`、`/workers`、`/tasks/:ref` 均 200，`/healthz` 200，`/readyz` 503。

---

## 3. WS 与 UI 门禁实测明细

### 3.1 API-6 ~ API-11

| ID | 关键断言（实测通过） |
| :--- | :--- |
| API-6 | `hello` 与 `subscribe` 背靠背发送；`snapshot.eventSeq === welcome.eventSeq`；快照帧索引 < 首个 `event` 帧索引；20 条增量全部收到且 `rttMs` 有序；所有 `event` 的 `eventSeq` 严格递增；仅 `task:<id>` 主题不产生全局快照；累积 >32 主题 → `error{RATE_LIMITED}` |
| API-7 | 断线期间 100 个 `workers` 主题事件 + 25 个未订阅 `overview` 主题事件；重连 `resumed=true`、`welcome.eventSeq = snapshot+125`；补发**恰好 100 条**且全部 `topic==='workers'`、顺序与 `rttMs` 一致；不得出现 `snapshot` 或 `resync` |
| API-8 | 10 001 事件后 `resumed=false` 且 `eventSeq` 精确；随后 `snapshot.eventSeq` 与之对齐；`bootId` 变化同样 `resumed=false` |
| API-9 | 2 400 条日志：`seq` 严格 `[1..2400]`、`Set` 去重后长度相等、与 `task_logs` 查询结果逐条相等；`live:false` 与 `live:true` 帧均出现；全程无 `logs.reset`；第 9 个并发 follow → `RATE_LIMITED`；不存在 Run → `logs.reset{reason:'run_not_found'}` |
| API-10 | 客户端 `socket.pause()` 后灌入 16 MiB → `logs.reset{reason:'slow_consumer',runId}`；FakeClock +11 s → `resync{reason:'slow_consumer'}` 且关闭码 **4008**；期间 RSS 增长 < 200 MiB；连接关闭后新会话仍可正常 handshake/follow |
| API-11 | 249 ms 时 0 次 `task.updated`；250 ms 后 1~2 次；最后一条 `data.version===11`、`topic==='tasks'`；再推进 1 s 无多余推送 |

### 3.2 DASH-1 ~ DASH-8（Playwright 真实 Chromium）

| ID | 场景 | 关键断言（实测通过） |
| :--- | :--- | :--- |
| DASH-1 | 登录 / 登出 / 会话失效 | 错误令牌 → `role=alert` 且停留登录页；正确令牌 → `command-center` 可见、连接徽标「实时在线」；登出 → 登录页；服务端 `auth.logout(session)` → WS `4001` → 自动跳登录页；刷新后仍为登录页 |
| DASH-2 | 手动指定 Worker 派单 | 通过 UI 新建任务（`requiredWorkerId=pi-dash-2`、`sandbox`、`mock`、`#scenario: slow ms=4000`）；卡片实时出现在 `lane-running`、`data-status` 依次 `running → succeeded`；DB 中 `required_worker_id` 与 `runs[0].worker_id` 均为指定节点 |
| DASH-3 | 结构化 / Raw 终端一致 | 结构化行含 `Mock response 6`；`log-count` 与 `SELECT count(*) FROM task_logs` 相等；切到 Raw 后 `.xterm-rows` 有文本，**双向包含**校验（见下）；切回结构化后 `log-count` 与行文本完全一致 |
| DASH-4 | 审批覆写 adapter/prompt | 策略置 `require_approval` 后任务停在 `awaiting_approval`；UI 点「批准」→ 表单改写 prompt 为 `success n=4` 并选 `mock` → 提交；最终 `resultSummary === 'Mock response 4'`、`prompt` 为覆写值、`timeline` 含 `task.approve` 与「Prompt 覆写」note；UI「时间线」页签同样可见 |
| DASH-5 | 取消运行中任务 | `slow ms=60000` 运行中 → 点「取消」；`cancelling` 期间 `task-actions` 显示「当前状态无可用操作」、`action-cancel` 按钮消失；终态 `cancelled`、`runs[0].status='cancelled'`、`allowedActions` 含 `retry/followup` 不含 `cancel`，「重试」按钮可用 |
| DASH-6 | 断线离线 + 宽限期 + 恢复 | Worker 经 `ChaosProxy` 接入；`proxy.down()`（RST + 拒新连接）→ 徽标「离线」、`worker-grace` 显示「离线宽限期 · Ns」（`N ∈ (0,31]`）；`proxy.up()` → 徽标「在线」、宽限期元素消失、**运行中的 Run 仍为 `running`**（宽限期内重连不丢任务） |
| DASH-7 | Drain 切换与新任务不派发 | 双 Worker；点 `worker-drain` → `aria-checked=true`、文本「排空中」；连建 3 个任务全部由 `pi-dash-7b` 执行（`runs[0].workerId` 断言），`pi-dash-7a` 从未接单；再点取消 Drain → `aria-checked=false` 且 Hub `drain=false` |
| DASH-8 | 10 万行日志滚动 | 直接写入 100 000 行（20×5 000 批量）→ 抽屉 `log-count` = 「100,000 条记录」；虚拟列表 DOM `.log-row` 数 **< 400**（实测远小于总数）；滚动 12 次（±4 000/1 200 px）+ 回顶，`PerformanceObserver('longtask')` 记录的最大长任务 **< 200 ms** |

**DASH-3「内容一致」的证明方式（重要）**：本机 xterm 5.5 使用 DOM 渲染器（`.xterm-dom-renderer-owner-*`），因此可直接读取 `.xterm-rows` 文本并与结构化视图做**双向包含**校验（压缩空白后）：
1. 结构化视图每条 `code` 文本都出现在 Raw 文本中；
2. Raw 每一行（去掉 `[kind] ` 前缀后）都能在结构化文本集合中找到来源。

两条方向同时成立即「内容一致」，不是仅比较条数。

---

## 4. 安全门禁实测明细（SEC-15 ~ SEC-17）

| ID | 断言（实测通过） |
| :--- | :--- |
| SEC-15 · CSRF | 会话 + POST/PUT/DELETE/`logout` 四类：缺 `X-CSRF-Token` → 403 `CSRF_FAILED`；错误 token → 403；正确 token + 非白名单 Origin → 403；缺 Origin → 403；正确组合 → 201。API Token（Bearer）路径不受 CSRF 约束（符合 04 §1.2 仅对会话要求） |
| SEC-15 · 路径穿越 | 临时 `distDir` + 同目录外的 `secret.txt`（内容 `TOP-SECRET-DO-NOT-SERVE`）+ 指向该文件的符号链接。14 种攻击路径（`/../secret.txt`、`/..%2fsecret.txt`、`/%2e%2e/secret.txt`、`/assets/../../secret.txt`、`/assets/%2e%2e/%2e%2e/secret.txt`、`/....//secret.txt`、`/..%5c`、`/%5c..%5c`、`/C:%5cWindows%5cwin.ini`、`/%5c%5cserver%5cshare\…`、`/link.txt`、`/assets/link.txt`、`/secret.txt`）+ 三种非 GET 方法：**没有任何响应包含 secret**；正常 `index.html` / `assets/*.js` 正常 200 且带 `X-Content-Type-Options: nosniff`。观察到字面 `..` 会被 Fastify 路由层先归一化（因此部分变体以 SPA `index.html` 200 返回而非 404），编码变体（`%2e%2e` / `%2f` / `%5c`）由 `dashboard-static` 守卫拦截为 404 |
| SEC-16 · 升级鉴权 | 无凭证 → 401；`ahk_` 假 token → 401；错误 Origin → 403；缺 Origin → 403；缺子协议 → 403；错误子协议（`agent-hub.worker.v1`）→ 403；正确组合 → 101。吊销令牌后：已建立连接收到 **4001**，后续升级 401 |
| SEC-16 · 连接数 | 同一凭据第 6 条 → 关闭码 **4029**，前 5 条保持 OPEN；关闭 1 条后可再建连接并正常 `welcome{resumed:false}` |
| SEC-17 · 登录限速 | 成功登录清零计数；5 次失败均 401；第 6 次 429 `RATE_LIMITED` 且 `Retry-After ∈ (0,900]`；窗口内即使提交正确令牌仍 429 |
| SEC-17 · scope 隔离 | `read`：可 GET（overview/tasks/任务详情/workers），不可 POST/PUT/DELETE operate 或 admin 端点（8 条组合全 403）；`operate`：可建任务/取消任务，不可 admin（10 条组合全 403）；`admin`：全部 200/201；伪造 `ahk_AAAA…` → 401 |

---

## 5. 观察项与未覆盖范围

### 5.1 缺陷 / 偏差

| ID | 级别 | 现象 | 证据 |
| :--- | :--- | :--- | :--- |
| **P2-1** | P2 | **`MAX_ATTEMPTS_REACHED` 无法通过面板 API 触发，且 `retry` 的 `force` 语义未生效。** `reduce` 对 `actor.type === 'owner'` 恒放行重试（`override=true`），忽略请求体里的 `force`；同时 `taskState()` 从未填充 `requesterCanRetry`，所以 requester 路径在 `canAct` 阶段就先返回 `FORBIDDEN`，也走不到 409。后果：① `pi-test-matrix` API-2「每个错误码至少 1 个触发用例」对 `MAX_ATTEMPTS_REACHED` 客观不可满足；② 04 §2.3「（Owner 可带 `force: true`）」暗示的不带 `force` 应 409 的行为未实现。已用可执行用例锁定当前行为（`phase4-api-rest.pi.test.ts` 的 `API-2 retry 次数用尽…`，注释标注 P2-1），不视为门禁失败，请主 Agent 裁决是否在 Phase 5（飞书 requester 重试）前修复 | `packages/protocol/src/task.ts:245-247`（owner 绕过）、`packages/protocol/src/task.ts:71`（`force` 仅入事件、全文件无读取）、`packages/hub/src/plugins/orchestrator/views.ts:16-28`（`taskState` 未设 `requesterCanRetry`） |
| **P3-1** | P3 | `:taskRef` 的 `#123` 形式不被 REST 层接受（`RestTaskRef` 只允许 `tsk_…` 或纯数字，`GET /tasks/%231` → 400 `VALIDATION_FAILED`），但内部 `findTask` 明确支持 `^#?\d+$`。04 §2.1 只要求 `tsk_…` 与纯数字，因此**不构成门禁失败**；记录为两处实现口径不一致（另外 URL 中裸 `#` 本就是 fragment，前端不可能直接发出） | `packages/protocol/src/dashboard/rest.ts:RestTaskRef`、`packages/hub/src/plugins/orchestrator/views.ts:11` |
| **P3-2** | P3 | 幂等键作用域为 `[actorType, actorId, source, parentTaskId]`，不含令牌身份。因此同一 Owner 的两枚不同 API Token 共享幂等命名空间：B 令牌用相同 Key+Body 调用会拿到 A 令牌的首次响应（任务不会重复创建）。与 04 §2.1「同 Key+同请求体哈希 → 返回首次响应」一致，但与「脚本/CLI 各自独立」的直觉不同，已在用例中显式断言并注释 | `packages/hub/src/plugins/orchestrator/index.ts:submit` 的 `scope` |

无 P0 / P1 发现。Redis/HTTP/WS 三条路径均未出现数据丢失、越权或内存无界增长（API-10 已量化）。

### 5.2 环境抖动（与本轮改动无关）

| ID | 现象 |
| :--- | :--- |
| INFO-1 | `pnpm test` 全量并行跑 2 次，其中 1 次 `packages/worker/test/phase3-windows.pi.test.ts · WIN-10`（Phase 3 既有用例）失败：`Get-ScheduledTask` 报 `系统找不到指定的文件`。该用例单独运行通过（4.8 s），第二次全量也通过。判定为 Windows 计划任务注册在并行负载下的抖动，非 Phase 4 引入。 |

### 5.3 未覆盖 / 只做了部分量化的范围

| 项 | 说明 |
| :--- | :--- |
| `overview.updated` 的「≤1 次/秒」节流 | 仅间接验证（FakeClock 不推进时不产生 overview 事件、`hub/status` 类事件不被节流）。未做「1 s 内 100 次状态变化只推 1 次」的量化用例——`pi-test-matrix` §11 未列入 API-* 门禁，故未纳入本轮闸门 |
| `task.updated.lastProgress` 的「1 次/2 s/任务」节流 | 同上，未量化 |
| 会话滑动续期（剩余 < 50% 时刷新 Cookie） | 未断言 `Set-Cookie` 刷新时机；04 §1.2 有要求，但不属 API-*/SEC-15~17 门禁 |
| Playwright 浏览器矩阵 | 只跑系统 Chrome（headless）。未跑 Firefox/WebKit，也未在真实 GPU 下跑 xterm 的 WebGL 渲染路径（当前用的是 DOM 渲染器） |
| 真机移动端 / 窄屏 | 未覆盖（非门禁项） |

---

## 6. Phase 4 门禁对照（§16）

| 门禁 | 状态 | 对应用例 |
| :--- | :--- | :--- |
| `API-1` ~ `API-12` | ✅ 12/12 通过（`MAX_ATTEMPTS_REACHED` 见 P2-1） | `phase4-api-rest.pi.test.ts`（12）、`phase4-api-ws.pi.test.ts`（7） |
| `SEC-15` ~ `SEC-17` | ✅ 3/3 通过 | `phase4-security.pi.test.ts`（6） |
| `DASH-1` ~ `DASH-8` | ✅ 8/8 通过 | `phase4-dash-ui.pi.test.ts`（8，真实 Chromium） |
| 构建 / 静态检查 | ✅ `pnpm -r build`、`pnpm lint`、`pnpm depcheck` 全绿 | — |
| 全量测试 | ✅ 46 files / 800 passed / 1 skipped | — |

---

## 7. 复现方式

```powershell
cd E:\Agent工作流

# 只看 Phase 4 门禁（约 50 s）
npx vitest run --project hub packages/hub/test/phase4-api-rest.pi.test.ts `
  packages/hub/test/phase4-api-ws.pi.test.ts `
  packages/hub/test/phase4-security.pi.test.ts `
  packages/hub/test/phase4-dash-ui.pi.test.ts

# 单条 UI 门禁（例如断线宽限期）
npx vitest run --project hub packages/hub/test/phase4-dash-ui.pi.test.ts -t "DASH-6"

# 全量
pnpm -r build; pnpm lint; pnpm depcheck; pnpm test
```

前置条件：
- UI 门禁依赖 `packages/dashboard/dist/site`（`pnpm build` 产出；缺失时 `dashboard-static` 不会挂载，DASH-* 会全部失败）。
- UI 门禁依赖系统 Chrome（`playwright` 的 `channel: 'chrome'`）；本机未下载 Playwright 自带 Chromium。
- `HUB_ADMIN_TOKEN_SHA256` 由用例在进程内设置（`pi/rest.ts · useAdminToken()`），无需外部 env。

---

## 8. 变更清单（仅测试与测试基础设施）

| 文件 | 变更 |
| :--- | :--- |
| `packages/hub/test/phase4-api-rest.pi.test.ts` | 新增（12 用例） |
| `packages/hub/test/phase4-api-ws.pi.test.ts` | 新增（7 用例） |
| `packages/hub/test/phase4-security.pi.test.ts` | 新增（6 用例） |
| `packages/hub/test/phase4-dash-ui.pi.test.ts` | 新增（8 用例，Playwright） |
| `packages/hub/test/pi/rest.ts` | 新增：inject REST 客户端、`expectSchema` / `expectError`、`onlineWorker`、管理员令牌摘要 |
| `packages/hub/test/pi/dash.ts` | 新增：裸 `DashClientFrame`/`DashServerFrame` 面板 WS 客户端 |
| `packages/hub/test/pi/harness.ts` | 微调：`ChaosProxy` 增加 `refusing` / `down()` / `up()`（彻底断网，供 DASH-6 使用） |
| `package.json` | 新增 devDependency `playwright ^1.65.1`（测试专用） |
| `pnpm-lock.yaml` | 随之更新 |

**未改动**：`packages/hub/src/**`、`packages/protocol/src/**`、`packages/dashboard/src/**`、`packages/worker/src/**` 任何业务实现代码。
