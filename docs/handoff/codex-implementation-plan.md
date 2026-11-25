# 交接 · Codex 分阶段实现任务清单

> 读者：代码实现（Codex）。规格来源：`docs/ARCHITECTURE.md` 与 `docs/specs/01~07`。**规格与代码冲突时以规格为准；规格本身有问题时，先在 PR 描述中提出并由主 Agent 裁决，不要静默偏离。**
> 每个阶段结束都必须让对应的 Pi 测试 ID（见 `pi-test-matrix.md`）通过，才能进入下一阶段。

---

## 0. 全局工程约定

| 项 | 约定 |
| :--- | :--- |
| 包管理 | pnpm workspace（`pnpm@9+`），Node `>=22.12`（CI 用 Node 24），全部 `"type": "module"` |
| 包 | `@agent-hub/protocol`、`@agent-hub/common`、`@agent-hub/hub`、`@agent-hub/worker`、`@agent-hub/mock-cli`、`@agent-hub/dashboard` |
| TS | `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`module/moduleResolution: NodeNext`、`verbatimModuleSyntax`；包间用 project references |
| 构建 | 库包 `tsc -b`；dashboard 用 Vite；hub/worker 产物为 ESM JS（不打包 native 依赖） |
| 测试 | Vitest（workspace 模式）；`fast-check` 做属性测试；Playwright 做面板 E2E |
| Lint | ESLint flat config + `@typescript-eslint`；自定义规则（或 `no-restricted-syntax`）：① 业务插件禁止 `ctx.on('internal/…')`、`ctx.plugin(`；② 禁止裸 `ctx.on`（必须 `safeOn`），`kernel/` 除外；③ 禁止 `child_process` 的 `shell: true`；④ 禁止 `setTimeout` 出现在 `plugins/orchestrator/**`（必须用 TimerWheel/clock） |
| 依赖边界 | `protocol` 只依赖 `zod`；`common` 只依赖 `protocol`；`hub`/`worker` 不互相依赖；`dashboard` 只依赖 `protocol`。用 `dependency-cruiser` 在 CI 中校验 |
| 时间 | 所有业务代码通过注入的 `clock` 取时间，禁止直接 `Date.now()`（`common/clock.ts` 提供 `SystemClock` / `FakeClock`） |
| 错误 | Hub 统一 `HubError(code, status, details)`；Worker 统一 `WorkerError(code, message)`；错误码只用规格表中列出的 |
| 日志 | 结构化 JSON；任何可能含用户内容的字段先过 `redact()` |

---

## Phase 0 — 脚手架与技术验证（Spike）

**目标**：消除四个最大不确定性，产出可复用的夹具（fixtures）。

| # | 任务 | 产出 |
| :--- | :--- | :--- |
| 0.1 | 初始化 monorepo（上述 6 个包的空壳、tsconfig、eslint、vitest workspace、CI：ubuntu + **windows** 双矩阵） | 能跑 `pnpm -r build && pnpm -r test` |
| 0.2 | **Cordis 内核契约 Spike**：在 `packages/hub/src/kernel/` 实现 `fiber-state.ts`、`safe.ts`、`hot-update.ts`、`lifecycle.ts(waitForActive)`，并编写 K-1~K-8 测试，验证：依赖未就绪时 PENDING、`[Service.init]` 完成后依赖方才激活、`static Config` 与 Zod 4（Standard Schema）的兼容性、effect LIFO、Provider 卸载等待依赖方先卸载、`fiber.update` 经 `internal/update` 拦截、FAILED 隔离 | 锁定 `cordis@4.0.0-rc.13`；若行为与 01 规格不符，**立即上报**主 Agent |
| 0.3 | **CLI 输出夹具采集**：实现 `agent-worker doctor --dump-help --sample`（可先写成独立脚本），在开发机上对已安装的 claude/codex/gemini/opencode 各执行 `--help`、`--version` 及一个固定只读 prompt（“列出当前目录文件，不要修改任何东西”），把原始 stdout/stderr 存入 `packages/worker/test/fixtures/<adapter>/<version>/` | 06 §4 表格的实测修订（以 PR 形式更新规格） |
| 0.4 | **Windows 进程树 Spike**：用 `koffi` 实现 Job Object（Create/SetInformation/Assign/Terminate），验证 `mock-cli spawn-tree` 与 `orphan` 剧本下全部子孙进程被清理；验证 Worker 被 `taskkill /F` 杀死后子进程随之消失 | `runner/kill-tree.ts` 原型 + WIN-1~WIN-6 原型测试 |
| 0.5 | **飞书长连接 Spike**：最小脚本：`WSClient` 收 `im.message.receive_v1` → 回复一张 JSON 2.0 卡片 → 按钮回调 `card.action.trigger` 返回 toast + 新卡片 → `im.message.patch` 连续更新，记录实际频控表现与错误码 | 05 §8 默认参数修订；权限清单实测名称 |

**技术坑**
- Cordis `FiberState` 是 `const enum`，不能在 `isolatedModules` 下引用，必须镜像常量。
- `await ctx.use(...)` 在依赖缺失时会“立即完成”但 Fiber 仍是 PENDING —— 不能据此判断就绪。
- Windows CI 上 `spawn('claude')` 若只有 `claude.cmd` 会 `EINVAL`；Spike 中先验证 `resolve-exe` 的 shim 解析。

---

## Phase 1 — 共享契约层（protocol + common + mock-cli）

| 模块 | 内容 | 规格 |
| :--- | :--- | :--- |
| `protocol/src/common.ts` | ID 正则与生成器类型、`ErrorCode` 枚举、`Actor`、`Profile`、`AdapterId` | 03 §2、04 §2.3 |
| `protocol/src/task.ts` | `TaskStatus`、`RunStatus`、`TaskEventType`、**纯函数 reducer** `reduce(task, event, ctx) → { next, effects } \| { error }`、`allowedActions(task, actor)` | 02 §3 全部 |
| `protocol/src/agent-event.ts` | `AgentEvent` | 06 §3 |
| `protocol/src/worker/*.ts` | 信封、握手、心跳、命令、`RunEvent`、`run.events/ack/resend/gap`、关闭码常量；`HubToWorkerFrame`/`WorkerToHubFrame` 联合；全部 `.strict()` | 03 全部 |
| `protocol/src/dashboard/*.ts` | DTO、REST 请求/响应、WS 帧 | 04 全部 |
| `protocol/src/feishu/*.ts` | `parseCommand()`、`CardActionValue` | 05 §5、§6.4 |
| `protocol/fixtures/**` | 每个帧/DTO 的合法与非法样例 JSON（契约测试共享） | — |
| `common/src/` | `redact.ts`、`ulid.ts`、`backoff.ts`、`token-bucket.ts`、`lru.ts`、`keyed-mutex.ts`、`clock.ts`（System/Fake）、`ndjson-line-splitter.ts`、`stable-hash.ts` | 06 §6.5 等 |
| `mock-cli/` | 06 §4.3 全部剧本 | 06 §4.3 |

**退出标准**：P-*、SM-1~SM-12、SEC-10~SEC-14（脱敏）、FS-1~FS-6（指令解析）、AD-9（mock-cli 剧本）通过。

**技术坑**
- reducer 必须**纯**：不读时钟、不生成 ID（由调用方注入 `now`、`newRunId`），否则属性测试无法复现。
- Zod 4 的 `z.discriminatedUnion` 要求判别字段为字面量；`RunEvent` 用 `kind`，`AgentEvent` 用 `type`，不要混用。
- `parseCommand` 需兼容中文全角引号与全角空格（`　`）。

---

## Phase 2 — Hub 核心 + Worker 隧道 + Mock 全链路（MVP 闭环）

### 2A Hub

| 顺序 | 插件 | 关键点 |
| :--- | :--- | :--- |
| 1 | `clock-system`、`http-server` | Fastify 5；统一 upgrade 分发；**延迟 listen**；可撤销子路由器（`find-my-way`/`Hono`）+ Zod 校验中间件（01 §4.2） |
| 2 | `store-sqlite` | 07 全部表 + 迁移 + PRAGMA；Repo 接口；`IngestQueue`（事务提交后 resolve） |
| 3 | `policy`、`auth` | 02 §5、04 §1 |
| 4 | `worker-gateway-ws` | 03 全部：升级前检查、Ed25519 握手、心跳/suspect/offline、CommandOutbox、RunInbox（seq/缺口/resend/gap）、ack 合并、入站限速、处理器注册前不 ack |
| 5 | `orchestrator` | 状态机执行器（CAS + KeyedMutex + 事务后副作用）、调度器（02 §6 全部过滤/打分/写锁）、TimerWheel、recovery、ingest 回调 |
| 6 | `dashboard-api`（仅 REST 子集） | `/healthz /readyz`、auth、`POST/GET /tasks`、approve/reject/cancel/retry/input、logs 分页、workers、enroll |
| 7 | `main.ts`、`app.ts`、`config/*` | 启动编排、信号、优雅关闭（01 §6）、配置热更新（01 §9） |

### 2B Worker

| 顺序 | 模块 | 关键点 |
| :--- | :--- | :--- |
| 1 | `config/`、`identity.ts`、`cli.ts enroll` | 私钥文件 ACL（Windows `icacls "<file>" /inheritance:r /grant:r "%USERNAME%:R"`） |
| 2 | `tunnel/connection.ts` | 握手、退避、关闭码处理（03 §1.1）、时钟偏移 |
| 3 | `tunnel/outbox.ts` | seq 分配、批处理、在途窗口、L2 降级丢弃 + `dropped` 事件、resend、gap |
| 4 | `tunnel/commands.ts` | 幂等（03 §6.3）、受理校验顺序（03 §6.4） |
| 5 | `runner/*` | run-manager（槽位、工作区写锁、超时/空闲）、spawn（stdin prompt）、line-reader、journal、local-log；kill-tree 先实现 POSIX + `taskkill` 版本 |
| 6 | `adapters/mock.ts` + `registry.ts` + `resolve-exe.ts` | Mock 优先 |
| 7 | `security/*` | workspace、env、args、profile（Phase 2 必须完成，不能留到后面） |

**退出标准**：K-*、GW-*、SM-*、SC-*、DB-1~DB-8、WK-1~WK-17、SEC-1~SEC-9、SEC-21/22、E2E-1~E2E-8（Mock）通过。

**技术坑**
- **ack 时机**：只能在 `IngestQueue` 事务提交后 ack；先 ack 后写 = Hub 崩溃时丢日志且 Worker 已释放缓冲。
- **同一事务内的状态机**：`finished` 事件的日志插入与 `RUN_SUCCEEDED` 迁移必须在同一事务，否则面板可能看到“已完成但日志不完整”。
- better-sqlite3 是同步的：`store.tx()` 回调内**禁止 await**；把网络 I/O（发命令）放到 effects 中事务后执行。
- `ws` 服务端 `maxPayload` 在升级时设定；鉴权前 16 KiB 限制需要在 `message` 事件中手动检查字节长度（`ws` 无法按阶段变更 maxPayload）。
- Worker 侧 `ws.bufferedAmount` 只反映内核缓冲之外的排队数据，不能作为唯一背压信号——必须用应用层 ack 窗口（03 §5.4 L1）。
- 调度器单飞（single-flight）：用 `running` + `dirty` 标志实现，不要用 Promise 链堆积。
- `KeyedMutex` 必须在 finally 中释放，并在测试中验证无泄漏（锁表大小回到 0）。

---

## Phase 3 — 真实 CLI 适配器 + Windows 进程管理

| 模块 | 关键点 |
| :--- | :--- |
| `adapters/claude-code.ts`、`codex.ts`、`gemini.ts`、`opencode.ts` | 以 Phase 0 夹具为准；每个解析器都要有“未知事件类型/非法 JSON → 降级为 log”的测试；`argsOverride` 机制 |
| `runner/kill-tree.ts`（Windows Job Object） | `koffi` 绑定；Job 句柄生命周期与 Run 绑定；FFI 失败降级 + doctor 警告 |
| `runner/journal.ts` 孤儿清理 | 进程创建时间校验（PowerShell `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"` 的 `CreationDate`），防 PID 复用 |
| `cli.ts doctor / probe / install-task` | 计划任务注册（`schtasks /Create /SC ONLOGON /RL LIMITED /TN AgentWorker /TR "..."` 或 PowerShell `Register-ScheduledTask`），单实例锁 |

**退出标准**：AD-*、WIN-*（Windows runner）、E2E-9~E2E-10（在真实 CLI 可用的开发机上手动/半自动执行）通过。

**技术坑**
- npm 全局安装在 Windows 上生成 `.cmd`/`.ps1` shim，`spawn` 不能直接执行 `.cmd`；按 06 §4.1 解析到 `node + cli.js` 或原生 `.exe`。
- Windows 下 `child.kill()` 等同 `TerminateProcess`，**只杀单个进程**，不杀子孙。
- `taskkill` 在进程已退出时返回非 0（错误码 128），需视为成功。
- CLI 在非 TTY 下可能仍尝试打开浏览器做登录（未登录状态）——probe 阶段检测未登录并标记 `error: 'not authenticated'`，避免任务挂起到超时。
- Claude/Codex 会话文件在用户目录，Worker 必须以登录用户运行（06 §5.4）。
- 解析 Gemini `message delta` 时要合并，避免每个 token 一个事件导致事件洪泛。

---

## Phase 4 — 面板（dashboard-api WS + React 前端）

| 模块 | 关键点 |
| :--- | :--- |
| `dashboard-api/ws-hub.ts` | eventSeq 环形缓冲、订阅、快照与订阅同步注册、合并/节流、慢消费者 |
| `dashboard-api/log-follow.ts` | 追赶 + 实时拼接（04 §5.3），无重复无遗漏 |
| 剩余 REST | 审计、策略、API Token、Worker drain/probe/revoke、logs.txt 流式下载 |
| `dashboard/` | 态势栏、Worker 拓扑、看板/列表、任务抽屉（结构化视图 + xterm Raw 视图 + 时间线 + 操作台）、登录页、策略编辑页 |

**退出标准**：API-*、DASH-*（Playwright）、SEC-15~SEC-17 通过。

**技术坑**
- 快照与增量的竞态：生成快照和注册订阅必须在同一个同步代码块中完成（Node 单线程保证）。
- 前端以 `eventSeq` 去重；任务卡片以 `version` 判断新旧，旧版本事件直接丢弃。
- 日志视图必须虚拟化；xterm 写入要批量（`requestAnimationFrame` 合并）。
- 操作按钮的可用性用 `allowedActions`（服务端用共享 reducer 计算），前端不要自行推断。

---

## Phase 5 — 飞书渠道

| 模块 | 关键点 |
| :--- | :--- |
| `transport.ts` | SDK 实现 + `FakeFeishuTransport`（测试） |
| `router.ts` | 预处理（去重、过滤陈旧、@判定）、身份、路由决策（05 §4.2） |
| `cards/*.ts` | 纯函数渲染 + 快照测试；体积截断 |
| `action-handler.ts` | 3 s 预算、三层幂等（05 §7） |
| `card-updater.ts` | 合并/节流/令牌桶/429 退避/死卡片替换（05 §8） |

**退出标准**：FS-*、SEC-18~SEC-20、E2E-11~E2E-14 通过。

**技术坑**
- `im.message.receive_v1` 处理器必须立即返回，内部异步处理。
- 卡片回调返回值即卡片更新：用它更新被点击的卡片，可省一次 patch 配额。
- 必须用 `update_multi: true` 的 JSON 2.0 卡片，否则 patch 后其他人看不到更新。
- 飞书 `open_id` 是“应用维度”的，换应用后全部变化；`ownerOpenIds` 靠 `/whoami` 获取。
- 长连接恢复后的积压事件：按 `create_time` 丢弃陈旧消息，避免误执行旧需求。

---

## Phase 6 — 生产化与部署

| 任务 | 说明 |
| :--- | :--- |
| `retention` 插件 | 07 §6 分片删除、incremental_vacuum、容量护栏 |
| `deploy/docker-compose.yml` + `Caddyfile` | hub（`restart: unless-stopped`，卷 `/data`，`stop_grace_period: 20s`）+ caddy（自动 HTTPS，`/ws/*` 反代，`flush_interval -1`） |
| `deploy/windows/install-worker.ps1` | 调用 `agent-worker install-task`，校验 Node 版本、执行 `doctor` |
| 备份 | 每日 `VACUUM INTO` 到 `/data/backup/`，保留 7 份 |
| 浸泡测试 | PERF-*、SOAK-* |
| 运维手册 | `docs/OPERATIONS.md`：注册 Worker、轮换密钥、吊销、排障（日志位置、常见错误码） |

**退出标准**：全部测试矩阵通过；SOAK-1 连续 24 h 无内存增长、无孤儿进程。

---

## 附：建议的 PR 粒度

每个 PR ≤ 800 行有效改动，只覆盖一个模块 + 其测试；PR 描述中列出对应规格章节与测试 ID。协议/状态机变更必须同时更新 `docs/specs` 与 `protocol/fixtures`。
