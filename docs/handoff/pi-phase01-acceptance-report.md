# Phase 0 & Phase 1 独立验收报告（Pi 测试工程师）

> 验收对象：Codex 交付的 Phase 0（Cordis 内核 / Windows 原型）+ Phase 1（协议契约 / 状态机 / 脱敏 / 飞书指令 / mock-cli）
> 验收依据：`docs/handoff/pi-test-matrix.md` §16 门禁、`docs/specs/01..06`
> 工作区：`E:\Agent工作流`（Windows 11 / Node v24.14.1 / pnpm workspace）
> 结论：**门禁全部通过（PASS）**。共发现 **0 个 P0、0 个 P1 缺陷**，**4 个 P2 规格/实现风险**、2 个澄清项，均不影响 Phase 0/1 门禁。

---

## 0. 门禁执行结果（最终）

| 命令 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ 6 个包全部 Done（protocol / common / hub / worker / mock-cli / dashboard） |
| `pnpm lint` | ✅ exit 0，无 error / warning |
| `pnpm depcheck` | ✅ `no dependency violations found (43 modules, 87 dependencies cruised)` |
| `pnpm test` | ✅ **13 个测试文件，536 passed，1 skipped（仅 POSIX 用例，Windows 上按设计跳过）** |

新增补充测试共 **7 个独立文件 / 386 条用例**（原有 151 条 → 537 条）：

| 文件 | 覆盖门禁 | 用例 |
| :--- | :--- | ---: |
| `packages/hub/test/kernel.contract.pi.test.ts` | K-1 ~ K-8 + supervisor | 20 |
| `packages/protocol/test/worker-contract.pi.test.ts` | P-1 ~ P-8 | 144 |
| `packages/protocol/test/state-machine.pi.test.ts` | SM-1 ~ SM-12 | 44 |
| `packages/common/test/redact-security.pi.test.ts` | SEC-10 ~ SEC-14 | 81 |
| `packages/protocol/test/feishu-commands.pi.test.ts` | FS-1 ~ FS-6 | 58 |
| `packages/mock-cli/test/scenarios.pi.test.ts` | AD-9（14 剧本） | 25 |
| `packages/worker/test/windows-prototype.pi.test.ts` | WIN-1/2/4/6/7/9 | 14 |

新增夹具（仅测试用，不改业务代码）：`packages/worker/test/fixtures/echo-stdin.mjs`（WIN-7 stdin 回显）。

---

## 1. Cordis 内核契约 K-1 ~ K-8 —— PASS

| ID | 结论 | 覆盖面 | 说明 / 我补强的等价断言 |
| :--- | :--- | :--- | :--- |
| K-1 | **PASS** | 补充 | 原测试只用镜像常量做断言，无法发现镜像与运行时不一致。新增：`FiberState` 镜像与 `cordis` 运行时导出的 `FiberState` **逐键逐值比对**，并断言等于 `{PENDING:0,LOADING:1,ACTIVE:2,FAILED:3,DISPOSED:4,UNLOADING:5}`；再用真实 Fiber 构造出 PENDING/LOADING/ACTIVE/FAILED/UNLOADING/DISPOSED 六种状态交叉验证。 |
| K-2 | **PASS** | 补充 | `inject(['k2store'])` 缺依赖时 PENDING 且 apply 未执行、`ctx.get` 未定义；加载 Provider 后 ACTIV/**apply 执行**。新增“两个依赖只满足一个仍 PENDING + 超时报 PENDING”用例。 |
| K-3 | **PASS** | 补充 | 断言执行顺序严格为 `init:start →（异步 resolve）→ init:end → consumer:apply`，即依赖方 apply 被 `[Service.init]` 门控；加载阶段依赖方 PENDING、`ctx.get()` 已可用。 |
| K-4 | **PASS** | 补充 | Consumer disposer 先于 Provider；同一 Fiber 内 4 个 disposer 严格 LIFO（含 generator 内 disposer 与独立 `effect`），并验证 Provider 在 Consumer disposer 完成前保持 UNLOADING。 |
| K-5 | **PASS** | 补充 | 热键（含点号路径 `nested.rate`）→ `onHotUpdate` 回调执行且 **effect 未被 dispose**、Fiber 保持 ACTIVE；冷键 → dispose 后重新 init；相同配置 → 既不热应用也不重启；非法配置抛 `ValidationError` 且保留旧配置/ACTIVE；冷键重载抛错 → 该 Fiber FAILED、兄弟 Fiber 仍 ACTIVE。另补 `class extends Service { static Config = z.object(...) }`（Zod 4 Standard Schema）的默认值 + 校验 + 热更新路径。 |
| K-6 | **PASS** | 补充 | init 抛错 → 该 Fiber FAILED、`waitForActive` 返回 `failed[]`、`ctx.get()` 不存在；兄弟 ACTIVE；依赖方 PENDING。 |
| K-7 | **PASS** | 补充 | 三种分支：全 ACTIVE → success；任一 FAILED → **立即**返回（实测 < 1 s，而非等 10 s 超时）；超时 → 返回 PENDING 列表；字符串名经 registry 解析（含注销后再次等待必须超时）。 |
| K-8 | **PASS** | 补充 | 同步 throw + async reject 均不向发布方冒泡，后两个监听器仍收到事件；错误计数逐次 +1（2 → 4）；`guardAsync` 计入同一计数器且返回 undefined；dispose 后监听器自动解绑。 |
| supervisor | **PASS** | 补充 | FAILED 非关键插件按 baseMs/maxMs 退避重启至 ACTIVE，`onDegraded(true→false)` 顺序正确，`stop()` 后不再重启。 |

---

## 2. 协议契约 P-1 ~ P-8 —— PASS（P-3/P-8 的线上行为待 Phase 2 网关）

> 现状说明：本仓库当前只交付了 `protocol` 的 Schema 与常量，`worker-gateway-ws` / `http-server` 尚不存在。因此 P-3“鉴权前 4400 / 鉴权后忽略”、P-8“子协议头缺失 → HTTP 拒绝或 4426”只能验证到**协议层可判定部分**，线上行为必须在 Phase 2 用 `FakeWorkerClient` 补测（已在下表标注）。

| ID | 结论 | 覆盖面 | 说明 |
| :--- | :--- | :--- | :--- |
| P-1 | **PASS** | 补充 | 18 个 worker valid fixture：解析成功 + **解析结果与原文深度相等**（不注入/不丢字段）+ JSON 往返稳定；并断言“每个声明过的帧类型都有 valid fixture”（集合相等，新增帧类型忘记加 fixture 会失败）。 |
| P-2 | **PASS** | 大幅补充 | 原测试只有 24 个 invalid fixture（几乎全是“加一个多余字段”）。新增：①每个帧类型**逐字段删除**必填字段必须失败（覆盖 18 个帧类型）；②信封缺 `v/id/type/ts/payload` 必须失败；③**每一层嵌套**加多余字段必须失败（`.strict()`：`auth`/`agent`/`features`/`workspaces`/`load`/`origin`/`events[0]`/`acks[0]`/`resume[0]`/信封）；④类型错误、超长字符串（prompt > 100 000、answer > 20 000、commandSummary > 512）、越界数字（timeoutMs 9 999 / 24h+1、graceMs 60 001、maxConcurrency 0/33、attempt 0、cpuPercent 101、connectionEpoch 0、acks 65 条、extraArgs 33 条）、非法枚举、非法 id 格式；⑤invalid fixture 覆盖度：每个帧类型至少一个反例。 |
| P-3 | **PASS（协议层）** | 补充 | 未知 `type` 在 `Envelope` 层仍合法（结构合法）、在两个方向的 discriminatedUnion 层被拒；`WorkerCloseCode.BAD_FRAME === 4400`；`HubReject.code` 接受 `BAD_FRAME`。**线上 4400/忽略语义待 Phase 2**。 |
| P-4 | **PASS** | 补充 | 连续 seq（任意起点、500 条上限）接受；重复 / 缺口 / 递减 / `[1,2,2]` / 空数组 / 501 条 / seq=0 / 负数 / 非整数全部拒绝；额外断言 `finished` 必须在**最后一帧内位置**（实现比规格更强）；`started.effectiveProfile` 必填、`clampedFrom` 必须是合法档位、`commandSummary` ≤ 512。 |
| P-5 | **PASS** | 补充 | Dashboard DTO/WS 的 valid/invalid fixture（同 P-1/P-2）；另加：未知客户端 `t`、未知事件 `type`、非法 `topic`（`task:tsk_bad`、`task:`、`tasks `）、33 个订阅主题超限、`TaskSummary`/`TaskDetail`/`WorkerView`/`Overview` 的多余字段。 |
| P-6 | **PASS** | 补充 | 7 个 action 全枚举接受；`v` 必须为 1（2 被拒）、`ver` 非整数被拒、`t` 非 `tsk_` 被拒、多余字段被拒、缺 `t` 被拒、`opt` > 200 被拒；`DeliverResultRequest` 的 `send`/`suppress` 正例与 `publish`、多余字段反例；`publish_result`/`suppress_result`（v2.1 结果回传）正反例。 |
| P-7 | **PASS** | 补充 | 同一份 fixtures 被判为**恰好一个方向**（上下行不歧义）；`HubCommand` 的每个成员都能被 `HubToWorkerFrame` 接受（子集关系）；跨方向重新序列化后 JSON 完全一致。 |
| P-8 | **PASS（协议层）** | 补充 | `PROTOCOL_VERSION === 1`、`agent-hub.worker.v1`、`agent-hub.dashboard.v1`；信封 `v ∈ {0,2,'1',1.5}` 全拒；`WorkerCloseCode` / `DashboardCloseCode` 整表断言（含 4426）；`hub.challenge.protocolVersions` 通告；`hub.welcome` 协商参数必备。**子协议 HTTP 层拒绝待 Phase 2**。 |

---

## 3. 状态机 SM-1 ~ SM-12 —— PASS

| ID | 结论 | 覆盖面 | 说明 |
| :--- | :--- | :--- | :--- |
| SM-1 | **PASS** | 重写加强 | 从 `02-task-state-machine.md` §3.2 解析矩阵（规格即事实来源），先断言矩阵**完整覆盖 12 行 × 18 列 = 216 格**且无重复/无未知符号，再把整表跑**两遍**（尝试次数未用尽 / 已用尽）：`—` → `INVALID_TRANSITION 409`（∅ 行 → `TASK_NOT_FOUND 404`）、`=` → `next` 同一对象 + 无写入 + `audit.noop`、目标状态单元 → 目标 status + `version+1` + 恰好 1 个 transition effect、`C` 单元 → `version+2` + 2 个 transition effect。 |
| SM-2 | **PASS** | 补充 | 三种决策的初始 status/version=1/runSeq=0/attemptCount=0/currentRunId=null/`POLICY_DENIED`；仅 `require_approval` 启动审批定时器；system/worker 发起 SUBMIT → 403。 |
| SM-3 | **PASS** | 补充 | `DISPATCH_LOST` 在 attempt<max → queued（Run 记 lost）；=max → failed(WORKER_LOST)，并断言只清 dispatch 定时器。 |
| SM-4 | **PASS** | 补充 | `dispatching` 收到 finished：同一步内 `RUN_ACCEPTED` + 终态，`version+2`，`writes=[run.update running, run.update succeeded]`，effects 顺序 `clear dispatch → start run → RUN_ACCEPTED(implicitAccept) → clear run → finished`，只有第一个 transition 带 `implicitAccept=true`；`INPUT_REQUEST` 早到同样隐式受理 + `input.open` 写入。 |
| SM-5 | **PASS** | 补充 | 4 组组合：readonly+autoRetry+有余量 → queued；关策略 / 用尽 / edit / full → failed(WORKER_LOST)。 |
| SM-6 | **PASS** | 补充 | `cancelling + RUN_SUCCEEDED` → succeeded（完成为准）。 |
| SM-7 | **PASS** | 补充 | `cancelling + RUN_FAILED/RUN_TIMED_OUT/RUN_CANCELLED/RUN_LOST` → cancelled（4 种全测）；`RUN_REFUSED`/`DISPATCH_LOST`（注释 E）→ cancelled 且 refused 不计次、lost 计次；`INPUT_EXPIRE`/`CANCEL`/`RUN_ACCEPTED`/`INPUT_REQUEST` 在 cancelling 下为幂等 noop。 |
| SM-8 | **PASS** | 补充 | 发起人无 `requesterCanRetry` / 非本人任务 → 403；策略允许 → awaiting_approval，`auto_approve` → queued，`deny` → 403；非 Owner 超限 → 409 `MAX_ATTEMPTS_REACHED`；Owner 超限 → queued 且审计 `override=true`（未超限时不标注）；failed/timed_out/cancelled 可 RETRY，succeeded/rejected 一律 `INVALID_TRANSITION`。 |
| SM-9 | **PASS** | 补充 | `expectedVersion ∈ {1,6,8}` vs 7 → `VERSION_CONFLICT` 且 `details.current` 为最新视图；匹配则通过；并证明**乐观锁先于矩阵校验**（终态 + 陈旧版本 → VERSION_CONFLICT 而非 INVALID_TRANSITION）。 |
| SM-10 | **PASS** | 全新补充 | 按 02 §3.5 建 18 事件 × 5 actor 期望表逐格断言（Owner / 发起人本人 / 其他发起人 / system / worker），只在矩阵合法状态下命中权限守卫；另测：running 下 `requesterCanCancelRunning` 默认 true、显式 false → 403、dispatching/awaiting_input 下发起人取消 → 403。 |
| SM-11 | **PASS** | 全新补充（fast-check） | 40 轮 × 200 步随机游走（事件类型**从规格矩阵推导**的合法集抽取，另混入非法事件/陈旧 runId/陈旧 expectedVersion/随机 actor/随机 maxAttempts 1~3/随机 liveInput/profile/autoRetry）。每步断言：失败不改状态且不就地修改入参；noop/stale 不改版本；version 增量 == transition effect 个数；**INV-2**（执行态 ⇔ currentRunId）；**INV-5**；**INV-6**（终态必须拒绝一切事件，随后重开新任务继续游走）；**INV-8**（`attempt_count == dispatches - refusals`）；runSeq == dispatches；写入的 runId 必须属于当前任务。并断言覆盖率（累计 transition > 1000，且 11 个状态全部到达）。 |
| SM-12 | **PASS** | 全新补充 | 11 状态 × 5 actor × requesterCanRetry 2 × 预算 2 × liveInput 2 的全组合，对 approve/reject/cancel/retry/input 断言三分类严格一致：矩阵非法 → 不在 allowedActions 且 reducer 报 INVALID_TRANSITION；`=` → 不在 allowedActions 且为 noop；其余 → `allowedActions 含该动作 ⇔ reducer 接受且状态确实变化`；并断言 `followup` 仅对可续接终态（succeeded/failed/timed_out/cancelled）且按受众开放、`deliver_result` 仅 Owner + succeeded + pending_review。 |
| 附加 | **PASS** | 补充 | APPROVE overrides：合法覆盖写入 `task.overrides` 并更新 profile；未知 profile → 422 `PROFILE_NOT_ALLOWED`、未知 adapter → 422 `UNKNOWN_ADAPTER`、`validateOverrides` 返回码上抛；`INPUT_EXPIRE`（SM-16 的 reducer 部分）→ cancelling + `run.cancel{reason:'input_timeout'}` + 关闭 input + 启动 cancel 定时器。 |

---

## 4. 安全脱敏 SEC-10 ~ SEC-14 —— PASS

| ID | 结论 | 覆盖面 | 说明 |
| :--- | :--- | :--- | :--- |
| SEC-10 | **PASS** | 大幅补充 | 逐条覆盖 06 §6.5：Anthropic `sk-ant-`、OpenAI `sk-`/`sk-proj-`、Google `AIza`+35、GitHub `ghp_/gho_/ghu_/ghs_/ghr_` 与 `github_pat_`、Slack `xoxb/xoxp/xoxa/xoxr/xoxs`、AWS `AKIA`+16 与 `aws_secret_access_key`（`=`/`:` 两种形态，保留键名）、飞书 `app_secret`/`tenant_access_token`（含 JSON 引号形态）、JWT、私钥块、通用赋值（`api_key`/`api-key`/`apikey`/`secret`/`token`/`passwd`/`password`/大写 `PASSWORD`，保留键名与引号）、连接串 `postgres/mysql/mongodb/mongodb+srv/redis`（仅替换密码段）；另加“同行多密钥 + 上下文不被破坏”的组合用例。 |
| SEC-11 | **PASS** | 大幅补充 | 负例不误伤：UUID、SHA-256、git SHA-1、base64 图片片段（`data:image/png;base64,...`）、Windows/POSIX 路径、ISO 时间戳 + HTTP 日志、`Authorization: Bearer ...`、`npm warn deprecated` 行、`sha256=abc`、空串；并断言 < 8 字符值不脱敏、已脱敏占位符幂等。**发现 1 个过宽规则**（见 P2-1），以“已知局限”用例锁定。 |
| SEC-12 | **PASS** | 补充 | 多次出现全部替换为 `[REDACTED:<KEY>]`；值含正则元字符 / 含空格也能精确替换；`< 8` 字符忽略（规格要求）；**最长优先**（`LONG` 覆盖 `SHORT`，无后缀泄漏）；非标识符键名降级为 `[REDACTED]`；对自身输出幂等。 |
| SEC-13 | **PASS** | 补充 | RSA / EC / OPENSSH / PRIVATE KEY / ENCRYPTED PRIVATE KEY 五种头尾；同串内两块且中间文本保留；流式逐行调用保持块内状态并在 END 后恢复正常；未闭合块 fail-closed（整块屏蔽、不泄漏正文）；无块文本不受影响。 |
| SEC-14 | **PASS** | 大幅补充 | 由 7 个样本扩到 **25 条逐规则病态输入**（每条 100 KiB）：`sk-` 前缀洪泛、`sk-` 近似命中重复、`AIza` 洪泛、`github_pat_` 下划线洪泛、`xox` 连字符洪泛、`aws_secret_access_key` 空白洪泛、飞书 `\W{0,3}` 洪泛、通用赋值键/值洪泛、连接串冒号洪泛与无 `@`、JWT `eyJ` 重复 / 点洪泛 / 点分近似命中、PEM BEGIN 空白/大写洪泛与未闭合多行、纯 base64、混合规则沙拉。每条**含 warm-up 取 3 次中位数 < 50 ms**；另加“启用已知密钥替换”与“16 KiB × 100 行”批量场景。实测全部在个位数毫秒级。 |

---

## 5. 飞书指令 FS-1 ~ FS-6 —— PASS

| ID | 结论 | 覆盖面 | 说明 |
| :--- | :--- | :--- | :--- |
| FS-1 | **PASS** | 补充 | 11 条指令全正例 AST（`run` 全 flag、`status` 有无 ref、`tasks` 三种 scope + `--status` 逗号/空格两形态、`workers`、`help`、`whoami`、`cancel`/`retry`/`approve`/`reject`(带理由)、`drain` on/off）；`--k=v` 与 `--k v` 两种写法产出**完全相同**的 AST。 |
| FS-2 | **PASS** | 补充 | ASCII `"` / 中文 `“”` / 全角 `＂＂` 引号作 flag 值；含空格的引号值（`/reject` 理由、`--ws "sandbox.v2"`）；`\"` 转义（`理由 \"引号\" 结束`）；全角空格 U+3000 与制表符作分隔符；未闭合引号 → `引号未闭合` 错误而非静默截断；prompt 内的引号原样保留。 |
| FS-3 | **PASS** | 补充 | 32 条错误输入（空串、`/`、未知指令、大小写、缺 prompt、未知 flag、缺 flag 值、`--cli` 后直接跟 `--ws`、非法 CLI/profile/workspace/worker/priority、priority 越界与小数、重复 flag、多余参数、`drain` 缺 mode、`cancel`/`retry`/`approve` 缺 ref、非法 ref、`tasks` 非法状态/重复 flag/重复 scope）→ 全部 `ok:false` + 非空 error + 以 `/` 开头的 usage，且**不产出命令**；并断言 usage 指向对应指令。 |
| FS-4 | **PASS** | 补充 | Requester 使用 `--worker` / `--profile=full` / `--priority` → `canUseCommand=false`（p2p 与 group 均是），Owner 可用，未授权用户不可用；Requester 允许的 `--cli`/`--ws`/`--profile=edit|readonly` 正常；Owner 专属指令（workers/tasks all/retry/approve/reject/drain）对 Requester 全拒；`/whoami` 仅私聊（连 Owner 在群里也拒）。 |
| FS-5 | **PASS** | 补充 | 多行 prompt（`\n`、缩进、空行、尾部空格）逐字节保留；CRLF 不被规范化；flag 之后的换行保留；单 `-` 开头的词不被当作 flag。 |
| FS-6 | **PASS** | 补充 | `#123` / `123` / `tsk_<ULID>` 三种形式在 `status/cancel/retry/approve/reject` 全部可解析；`#`、`#12a`、`12a`、`tsk_`、小写 ULID、`##12` 全部拒绝。 |

---

## 6. AD-9 mock-cli 14 剧本 —— PASS

| 剧本 | 结论 | 断言要点 |
| :--- | :--- | :--- |
| `success` | PASS | 默认 7 条事件（init + session + 5 message），只有最后一条 `final:true`；`n=`/`session=` 生效 |
| `fail` | PASS | 输出 `error{fatal:true}`，退出码默认 1、`code=42`→42、`code=255`→255 |
| `slow` | PASS | 每秒 1 条 progress（`detail` 0/1000/2000），总时长 ≥ ms |
| `flood` | PASS | 精确写出 mb MiB 且以 `\n` 结尾（3 组 mb/line 组合） |
| `huge-line` | PASS | 单行精确 bytes + 1 个 `\n`，内容全为 `x`（16 385 / 1 MiB） |
| `malformed` | PASS | 合法 JSON + `not JSON` + 半截 JSON + 二进制垃圾（00 FF FE）+ 未知 type 混合 |
| `need-input` | PASS | 输出 `input_request{requestId,question,options}` 后**阻塞**；答句回显为 `message(final:true)`；stdin 提前关闭 → 退出码 1 + fatal error |
| `ignore-sigterm` | PASS | 输出 pid 后保持存活；POSIX 上 SIGTERM 后仍存活（Windows 的 SIGTERM 由 TerminateProcess 实现，不可拦截，已按平台分支） |
| `spawn-tree` | PASS | `depth=3 width=1` → 3 个 pid 全部上报且存活；`depth=2 width=3` → 4 个 pid；`depth=8 width=8`（>128 上限）→ 退出码 1；测试后无残留进程 |
| `orphan` | PASS | 父进程退出码 0 后，detached 孙进程仍存活（并上报其 pid）→ 正是 Job Object 必须覆盖的场景；测试后清理 |
| `secrets` | PASS | 15 类假凭据标记全部出现（供脱敏回归） |
| `unicode` | PASS | 逐字节写出，stdout **字节级**等于 `中文 😀\r\n再见 🌍\n` 的 UTF-8 |
| `crash` | PASS | 输出半截后异常终止（非 0 / 有 signal） |
| `idle` | PASS | 静默满 ms 且无任何输出 |
| 参数校验 | PASS | 未知剧本 / 非 `k=v` / 非整数 / 低于下限 / 高于上限 → 退出码 1 + stderr 提示 + stdout 为空；无 `#scenario` 标记时默认 `success` |

---

## 7. Windows 原型 WIN-1/2/4/6/7/9 —— PASS（WIN-2 后半为 Phase 2 缺口，见 P2-3）

| ID | 结论 | 说明 |
| :--- | :--- | :--- |
| WIN-1 | **PASS** | `spawn-tree depth=3 width=3` → 13 个 pid 全部存活 → 取消后**实测在 graceMs(500)+3 s 内全部消失**（断言了时限本身），根进程亦消失；测试后无残留。 |
| WIN-2 | **PASS（前半）** | Job 模式：父进程退出、孙进程脱离父链后仍存活 → `kill({force:true})` 全部消失，无告警。**后半缺口**：`useJobObject:false` 降级为 `taskkill /T /F` 时孤儿**存活**且**无 ORPHAN_SURVIVED 告警** → 06 §5.2 阶段 3 复核未实现（P2-3）。 |
| WIN-4 | **PASS** | `taskkill /PID <worker> /F` 强杀 Worker 后，7 个 CLI 子孙进程全部随 Job 关闭而消失。 |
| WIN-6 | **PASS** | 用**真实 npm shim 全文**（含 `endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`）解析为 `node` + 脚本绝对路径并**实际执行成功（shell:false）**；显式 `command=<dir>\cli.cmd` 结果一致；`.exe` 优先于 `.cmd`；越出包目录 / 两个目标 / 相对目标 / 无目标 / 目标文件缺失 / > 64 KiB / 非绝对 command 全部 → `error`。 |
| WIN-7 | **PASS** | prompt 含 `& calc.exe`、`" \| del /f /q ...`、`%PATH%`、`^&^\|`、`& echo INJECTED> <哨兵>`、`$(touch …)`、`` `id` ``、`; rm -rf /` 与中文混合 → ①子进程 stdin **字节级等于** prompt；②子进程 argv 只有脚本路径、不含任何 prompt 片段；③哨兵文件**未生成**（无命令注入/无额外进程）；④同一机制下 mock `need-input` 回显 `answer & calc.exe %PATH% ^ \| del` 原样无损。 |
| WIN-9 | **PASS** | CRLF 行切分正确且无残留 `\r`；`\r` 与 `\n` 跨 chunk 边界（`a\r` + `\n`）正确配对；行内裸 `\r`（进度条）保留；逐字节与两段切分下的多字节字符（中文/emoji）无乱码；超长 CRLF 行截断后不含 `\r`，`truncatedBytes` 正确。 |

---

## 8. 缺陷与风险清单

### P0（阻断）—— 无
### P1（严重）—— 无

### P2（规格缺陷 / 待 Phase 2 补齐 / 需澄清）

**P2-1 · 脱敏规则过宽，会误伤普通英文标识符**（`packages/common/src/redact.ts:10` `token` 正则）
- 现象：`redact('disk-usage-report-for-week-1')` → `'di[REDACTED]'`；`redact('task-sku-mapping-inventory')` → `'ta[REDACTED]'`。
- 原因：规格 06 §6.5 的 OpenAI 规则 `sk-(proj-)?[A-Za-z0-9_\-]{20,}` 没有左边界限定，`disk-` / `task-sku-` 中的 `sk-` 被当成密钥前缀。
- 影响：日志可读性受损（不泄漏，方向安全），但“不误伤”是 SEC-11 的目标之一。
- 建议：改为 `\b(?:sk-ant-|sk-(?:proj-)?[A-Za-z0-9_\-]{20,})`（`di`/`ta` 是词字符，加 `\b` 后不再匹配，同时不影响真实的 `sk-ant-…`）。需同步更新规格与本用例 `SEC-11 documents the over-match`。

**P2-2 · 飞书 `app_secret` 规则的非词字符窗口过窄**（`redact.ts:9`）
- 现象：`redact('app_secret  =  abcdefghijklmnop')` 原样返回（等号两侧各 2 空格 = 5 个 `\W`，超出 `\W{0,3}`）。
- 原因：规格 `(?i)(app_secret|tenant_access_token)\W{0,3}[A-Za-z0-9]{16,}` 本身过窄（且 `assignments` 的 `\bsecret\b` 因 `_` 是词字符而无法兜底）。
- 建议：规格放宽为 `(?i)(app_secret|tenant_access_token)\s*[:=]?\s*[A-Za-z0-9]{16,}`。

**P2-3 · `trackProcessTree` 缺少 06 §5.2 阶段 3 的孤儿复核 / ORPHAN_SURVIVED 告警**（`packages/worker/src/runner/kill-tree.ts`）
- 现象：`useJobObject:false`（或 FFI 加载失败降级）时，`orphan` 剧本的孙进程在 `kill({force:true})` 后**仍然存活**，且没有任何告警（`onWarning` 从未被调用）。
- 影响：WIN-2 的后半门禁不满足；依赖 journal 的 pid+创建时间复核（06 §5.3）也未实现。
- 建议：Phase 2 在 `kill()` 后按 journal 记录的 `pid`+`pidStartTime` 复核（`Get-CimInstance Win32_Process`），存活则 `onWarning({code:'ORPHAN_SURVIVED'})` 并上报 `log(system)`。我的测试 `WIN-2 leaves the orphan alive without a Job Object (missing ORPHAN_SURVIVED check)` 已锁定该缺口。

**P2-4 · `cancelling` 收到 `RUN_REFUSED` 会把 Run 状态写回 `refused`**（`packages/protocol/src/task.ts:280` `case 'RUN_REFUSED'`）
- 现象：`cancelling`（Run 已被前一事务写成 `cancelling`）→ `RUN_REFUSED` 时写入 `run.update{status:'refused'}`，属于 Run 状态**回退**，与 02 §1「Run 自身只前进不回退」的表述冲突。
- 语义上 `refused`（进程从未启动）比 `cancelling` 更准确，故判定为**规格表述需澄清**，非实现 Bug。
- 建议：在 02 §1 明确 `refused`/`lost` 为可覆盖的终态，或在 §3.2 注释 E 注明“Run 可被改写为 refused”。

### 澄清项（非缺陷）

**C-1 · `allowedActions` 不把 `rejected` 视为可续跑终态**：实现 `completed = {succeeded,failed,timed_out,cancelled}`，与 05 §4.2「`awaiting_approval`/`rejected` → 回复“任务未执行，请直接发送新需求”」一致。我最初按“所有终态可 followup”编写期望，已按规格修正断言。

**C-2 · `=` 幂等单元在权限检查之前返回**（`packages/protocol/src/task.ts:204`）：`reduce` 中 `if (cell === '=') return noop` 早于 `canAct`，因此“其他发起人对 `cancelling`/`cancelled` 任务发 CANCEL”得到 200 noop 而非 403。无状态变化、无安全影响；若要求严格 403 需调整 02 §3.3 守卫顺序并明确 `=` 语义。

**C-3 · `NdjsonLineSplitter.finish()` 保留截断行尾的裸 `\r`**（`packages/common/src/ndjson-line-splitter.ts:66`）：仅当流以 `\r` 结尾且无 `\n` 时发生（不完整行），CRLF 正常路径无残留 `\r`（WIN-9 已断言）。属合理行为，记录备查。

---

## 9. 覆盖缺口（不在本次门禁内，交 Phase 2）

以下 ID 依赖尚不存在的 Hub 运行时组件，本次只能验证到协议/纯函数层，Phase 2 必须用 `FakeWorkerClient` / `ChaosProxy` / `FakeFeishuTransport` 补测：

- **P-3 / P-8 线上语义**：鉴权前未知 type → 4400 断开；鉴权后 → 忽略并告警且连接保持；子协议头缺失/错误 → HTTP 4xx 或 4426；鉴权前帧 > 16 KiB → 断开。
- **K-9 / K-10**：`ctx.on` 自动解绑（K-9 已由 `safeOn` 用例间接覆盖）、Provider 重启级联。
- **SM-13 ~ SM-16**：并发审批、并发 cancel、定时器从 DB 重建、输入超时执行器（reducer 部分已覆盖）。
- **GW-*** / **WK-*** / **SC-*** / **DB-*** / **API-***：网关、Worker 运行时、调度器、存储、面板均未交付。
- **WIN-5 / WIN-8 / WIN-10~WIN-12**：PID 复用防护、中文/含空格路径、计划任务、私钥 ACL、窗口隐藏——需 journal 与 `install-task` 子命令（Phase 2/3）。

---

## 10. 复现方式

```powershell
cd E:\Agent工作流
pnpm -r build
pnpm lint
pnpm depcheck
pnpm test                     # 全部：536 passed | 1 skipped
pnpm vitest run --project hub            # K-*
pnpm vitest run --project protocol       # P-* / SM-* / FS-*
pnpm vitest run --project common         # SEC-10~14
pnpm vitest run --project mock-cli       # AD-9
pnpm vitest run --project worker         # WIN-1/2/4/6/7/9
```

单独复现 P2-1 / P2-2：

```js
// packages/common/src/redact.ts
redact('disk-usage-report-for-week-1')      // => 'di[REDACTED]'   （应为原样）
redact('app_secret  =  abcdefghijklmnop')   // => 原样             （应为 app_secret  [REDACTED]）
```

单独复现 P2-3：

```powershell
pnpm vitest run --project worker -t "leaves the orphan alive"
```

---

**验收结论：Phase 0 + Phase 1 门禁（K-1~K-8、P-1~P-8、SM-1~SM-12、SEC-10~SEC-14、FS-1~FS-6、AD-9、WIN-1/2/4/6/7/9）全部 PASS。无 P0/P1 缺陷，4 个 P2 风险已定位到文件与行号并附复现路径与修复建议。**
