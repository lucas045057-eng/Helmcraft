# 交接 · Pi 测试验收矩阵

> 读者：测试验收（Pi）。每条用例有唯一 ID，Codex 的阶段退出标准引用这些 ID。
> 层级：**U** 单元 · **C** 协议契约 · **I** 集成（进程内多插件 / 真实 WS / 真实 SQLite 文件）· **E** 端到端（真实 Hub 进程 + 真实 Worker 进程 + mock-cli）· **W** Windows 专属（必须在 Windows runner 上执行）。
> 预期结果中的数值均为默认配置下的值；测试应通过配置把时间参数缩短（例如 `gracePeriodMs=2000`）并使用 `FakeClock` 或缩短的真实时钟。

---

## 0. 测试基础设施（Pi 需先搭建）

| 组件 | 说明 |
| :--- | :--- |
| `FakeClock` | `@agent-hub/common/clock`，`advance(ms)` 驱动 TimerWheel、心跳、宽限期 |
| `TestHub` 工厂 | 在进程内用 Cordis 组装插件（可选择性替换 `clock`、`FeishuTransport`），使用临时目录中的 SQLite **文件**（`:memory:` 不支持 WAL 行为） |
| `TestWorker` 工厂 | 进程内启动 Worker（隧道 + runner），可注入临时 `worker.yaml` 与临时工作区目录 |
| `FakeWorkerClient` | 直接按协议收发原始帧的 WS 客户端（用于契约/异常帧测试，绕过真实 Worker 逻辑） |
| `ChaosProxy` | 进程内 TCP 代理，置于 Worker 与 Hub 之间：`cut()`（RST）、`blackhole()`（静默丢包，模拟半开）、`delay(ms)`、`throttle(bytesPerSec)`、`restore()` |
| `FakeFeishuTransport` | 记录所有 reply/send/patch 调用；可注入 429/频控/卡片不可更新错误；可模拟回调与重复 event_id |
| `mock-cli` | 06 §4.3 剧本 |
| 断言工具 | `assertInvariants(db)`：检查 02 §7 的 INV-1~INV-8；**每个 I/E 用例结束时都必须调用** |
| 进程检查 | Windows：`Get-CimInstance Win32_Process` 按 `ParentProcessId` 递归 / 按命令行标记查找；POSIX：`ps -o pid,pgid,command` |

---

## 1. Cordis 内核契约（K）— U/I

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| K-1 | `kernel/fiber-state.ts` 镜像常量 | 与运行时 `fiber.state` 实际取值一致（构造 PENDING/ACTIVE/FAILED/DISPOSED 四种状态比对） |
| K-2 | 依赖缺失 | 注入 `['store']` 的插件在无 store 时为 PENDING；加载 store 后变 ACTIVE |
| K-3 | 异步 init 门控 | Provider `[Service.init]` 延迟 100 ms resolve；依赖方的 apply 在其后才执行 |
| K-4 | 卸载顺序 | dispose 应用 Fiber：Consumer 的 effect disposer 先于 Provider 的执行；同一 Fiber 内 effect LIFO |
| K-5 | 热更新拦截 | `fiber.update()` 仅改热键 → `onHotUpdate` 回调执行且 Fiber 未重启（effect 未被 dispose）；改冷键 → Fiber 重启 |
| K-6 | 故障隔离 | 插件 init 抛错 → 该 Fiber FAILED，兄弟插件仍 ACTIVE，依赖它的插件 PENDING |
| K-7 | `waitForActive` | 关键插件全部 ACTIVE → success；任一 FAILED → 立即返回失败列表；超时 → 返回 PENDING 列表 |
| K-8 | `safeOn` 隔离 | 同一事件的第一个监听器抛错，第二个监听器仍收到事件，发布方不抛错；错误计数 +1 |
| K-9 | `ctx.on` 自动解绑 | 插件 dispose 后再 emit，其监听器不再被调用 |
| K-10 | Provider 重启级联 | 重启 `workers` Fiber → `orchestrator`、`dashboard-api` 被重启且恢复后状态与 DB 一致 |

## 2. 协议契约（P）— C

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| P-1 | 每个 Worker 帧的 `fixtures/valid/*.json` | Zod 解析成功，且 `parse → JSON.stringify → parse` 往返一致 |
| P-2 | 每个 Worker 帧的 `fixtures/invalid/*.json`（缺字段、多余字段、类型错误、超长字符串、seq=0、负数） | 全部解析失败 |
| P-3 | 未知 `type` | 鉴权前 → 4400；鉴权后 → 忽略并告警，连接保持 |
| P-4 | `run.events` 中 seq 非连续递增 | Schema 级（refine）拒绝 |
| P-5 | Dashboard DTO / WS 帧 fixtures | 同 P-1/P-2 |
| P-6 | `CardActionValue` fixtures | 同 P-1/P-2 |
| P-7 | Hub 与 Worker 使用**同一份** fixtures 互相解析（序列化方 = 一端，解析方 = 另一端） | 双向成功 |
| P-8 | 协议版本 | 子协议头缺失/错误 → HTTP 层拒绝或 4426 |

## 3. 状态机（SM）— U（reducer）/ I（执行器）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| SM-1 | 遍历 02 §3.2 矩阵全部 (state, event) 组合 | 合法项返回目标状态；`—` 返回 `INVALID_TRANSITION`；`=` 返回 noop |
| SM-2 | SUBMIT 三种策略决策 | auto→queued，require→awaiting_approval，deny→rejected(POLICY_DENIED) |
| SM-3 | 注释 B：DISPATCH_LOST 在 attempt<max 与 =max 时 | queued / failed(WORKER_LOST) |
| SM-4 | 注释 C：dispatching 收到 finished(succeeded) | 同一事务内 running→succeeded，version +2，审计含 implicitAccept |
| SM-5 | 注释 D：RUN_LOST 在 readonly+autoRetry 与 edit 下 | queued / failed |
| SM-6 | cancelling 收到 RUN_SUCCEEDED | succeeded（取消与完成竞态以完成为准） |
| SM-7 | cancelling 收到 RUN_FAILED / RUN_TIMED_OUT | cancelled |
| SM-8 | RETRY：requester 无权限、attempt 用尽、Owner force | 403 / 409 MAX_ATTEMPTS_REACHED / 成功且审计 override=true |
| SM-9 | 乐观锁：expectedVersion 过期 | 409 VERSION_CONFLICT，details.current 为最新 |
| SM-10 | 权限矩阵 02 §3.5 每一格 | 与表一致 |
| SM-11 | **属性测试**（fast-check）：随机生成 200 步事件序列（含并发 actor、Worker 事件、定时器） | 每步之后 `assertInvariants` 通过；终态 succeeded/rejected 之后的任何事件都被拒绝 |
| SM-12 | `allowedActions()` 与 reducer 一致性 | 对每个状态与 actor，`allowedActions` 中的动作经 reducer 均合法，未列出的均非法 |
| SM-13 | 并发审批（I）：面板与飞书同时 approve 同一任务 50 次并发 | 恰好 1 次成功迁移，其余为 INVALID_TRANSITION 或 noop；version 只增加 1；只产生 1 个 Run |
| SM-14 | 并发 cancel + RUN_SUCCEEDED（I） | 最终状态为 succeeded 或 cancelled 之一，INV 全部成立 |
| SM-15 | 定时器从 DB 重建（I）：awaiting_approval 任务在 Hub 重启后 | 到达 `approval_deadline_at` 时变为 cancelled |
| SM-16 | 输入超时（I，mock need-input） | awaiting_input → cancelling → cancelled(INPUT_TIMEOUT)，进程被终止 |

## 4. 调度器（SC）— I（FakeClock + FakeWorkerClient）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| SC-1 | adapter 匹配：W1 仅 codex ready，任务要求 claude-code | 不派给 W1；scheduleHint 指明原因 |
| SC-2 | adapterPrefs 回退：prefs=[gemini, codex]，无 gemini | 选 codex |
| SC-3 | 工作区匹配：W1 无 workspace `backend` | 不派给 W1 |
| SC-4 | profile 上限：workspace.maxProfile=readonly，任务 edit | 不可调度（Hub 侧过滤） |
| SC-5 | 最小负载：W1 1/4、W2 0/2 | 选 W2（0 < 0.25） |
| SC-6 | 平局打破：负载相同 | lastDispatchAt 早者优先；再相同按 id 字典序 |
| SC-7 | 容量含预留：W1 max=1，有 1 个 dispatching | 不再派单 |
| SC-8 | 工作区写锁：同 Worker 同工作区已有 edit Run | 第二个 edit 任务不派到该 Worker；readonly 任务可派 |
| SC-9 | Drain：W1 drain | 不派单；W1 上运行中的任务继续并能正常完成 |
| SC-10 | 无队头阻塞：队首任务不可调度，第二个可调度 | 第二个被派发 |
| SC-11 | 优先级与 FIFO | priority 高者先；同优先级 queued_at 早者先 |
| SC-12 | 硬亲和：requiredWorkerId=W2 且 W2 离线 | 保持 queued，W2 上线后立即派发 |
| SC-13 | 拒单排斥：W1 返回 NO_SLOT | 任务回 queued，60 s 内不再派给 W1，attempt_count 不变 |
| SC-14 | 发起人公平性：Requester 已有 2 个活动任务 | 第 3 个保持 queued |
| SC-15 | 单飞：1 ms 内触发 100 次 schedule | 实际执行轮数 ≤ 2，无重复派发 |
| SC-16 | suspect Worker | 不派单 |

## 5. Worker 网关与可靠传输（GW）— C/I（FakeWorkerClient + ChaosProxy）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| GW-1 | 正常握手 | 收到 challenge → 签名 hello → welcome；DB `connection_epoch` +1 |
| GW-2 | 错误签名 / 错误 nonce / 错误 hubBootId / 指纹不符 | hub.reject AUTH_FAILED + 4401 |
| GW-3 | 未注册 workerId / 已吊销 | 4401 / 4403 |
| GW-4 | 握手超时（不发 hello） | 5 s 后 4408 |
| GW-5 | 鉴权前发送 > 16 KiB 帧 | 断开 |
| GW-6 | 重放：复用上一个连接的 hello 帧 | 4401 |
| GW-7 | 同一 workerId 第二个连接 | 旧连接 4409，新连接正常；旧连接后续帧被忽略 |
| GW-8 | IP 暴力：同 IP 连续 5 次认证失败 | 第 6 次升级请求直接 HTTP 429；30 min（FakeClock）后恢复 |
| GW-9 | 未认证连接数上限 64 | 第 65 个被拒 |
| GW-10 | seq 重复帧 | 不重复写库；回 ack |
| GW-11 | seq 缺口（发 1-10 后发 15-20） | 只持久化 1-10；发出 run.resend{fromSeq:11}；补发 11-20 后全部持久化且有序 |
| GW-12 | run.gap | 写入一行 kind=gap，last_seq 推进到 toSeq，INV-7（区间连续）成立 |
| GW-13 | ack 时机：在 IngestQueue 事务提交前注入延迟 | ack 在提交之后才发出（以事件顺序断言） |
| GW-14 | 处理器未注册（orchestrator 重启中）时收到 run.events | 不 ack；处理器注册后 Worker 重发并被正常持久化 |
| GW-15 | 命令至少一次：dispatch 后断网，重连 | dispatch 被重发（同 runId），Worker 只启动一次进程 |
| GW-16 | cmd ack 超时重发上限 | 3 次重发后触发 DISPATCH_LOST |
| GW-17 | 心跳：blackhole 30 s | 连接 suspect；45 s terminate；进入宽限期 |
| GW-18 | **宽限期内重连**（cut 后 10 s 恢复） | Run 保持 running，日志无缺无重，最终 succeeded |
| GW-19 | **宽限期外重连**（cut 后 > 90 s） | Run → lost，Task → failed(WORKER_LOST)；Worker 重连后收到 resume action=cancel，进程被杀 |
| GW-20 | 对账表 03 §7.2 每一行 | 动作与表一致 |
| GW-21 | 入站洪泛：> 200 帧/s | 4429 或限速丢弃，Hub 内存稳定 |
| GW-22 | Hub 重启（hubBootId 变化） | Worker 4503 后重连；Run 恢复；dispatching 的 Run 被重新下发 |
| GW-23 | 非法帧（Schema 失败）在鉴权后 | 4400，计数指标 +1 |

## 6. Worker（WK）— U/I

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| WK-1 | 受理校验顺序（03 §6.4）每一项 | 返回对应错误码 |
| WK-2 | dispatch 幂等：同 runId 两次 | 第二次 ok=true，runState=当前，进程数 1 |
| WK-3 | cancel 幂等：已 finished 的 Run | ok=true，无操作 |
| WK-4 | input 幂等：同 requestId 两次 | stdin 只写入一次 |
| WK-5 | 超时：`slow` 剧本 + timeoutMs=2s | finished timed_out(TIMEOUT)，进程树被杀 |
| WK-6 | 空闲超时：`idle ms=5000` + idleTimeoutMs=2s | timed_out(IDLE_TIMEOUT) |
| WK-7 | 解码：`unicode` 剧本（多字节跨 chunk） | 无乱码、无替换字符 |
| WK-8 | 超长行：`huge-line bytes=1048576` | 事件 text ≤ 16 KiB，含截断标记；本地 output.log 完整 |
| WK-9 | **背压/防 OOM**：`flood mb=500` + Hub 端 throttle 100 KiB/s | Worker RSS 增量 < 150 MiB；产生 dropped 事件；seq 连续；高优先级事件（started/finished）全部送达；子进程不被阻塞且能按时结束 |
| WK-10 | 在途窗口：Hub 不发 ack | Worker 在途字节 ≤ maxInFlightBytes 后停止发送 |
| WK-11 | journal：Worker 在 Run 运行中被强杀后重启 | 孤儿进程被清理；hello 上报 finished(WORKER_RESTARTED)；Hub 收到 gap + finished |
| WK-12 | journal：finished 已生成但未 ack 时 Worker 重启 | 重启后补发 finished，Hub 只记录一次 |
| WK-13 | 单实例锁 | 第二个 Worker 实例退出码 3 |
| WK-14 | 优雅关机：有运行中 Run 时收到 SIGINT | 发 worker.state(drain) → cancel → finished(WORKER_SHUTDOWN) 被 ack → worker.bye → 1000 关闭 |
| WK-15 | 4401 / 4403 / 4426 关闭码 | 分别长退避 / 退出非 0 / 退出非 0 |
| WK-16 | 重连退避 | 抖动指数退避，上限 30 s；welcome 后归零 |
| WK-17 | 配置热重载：新增工作区 | 主动重连并在 hello 中上报新工作区 |

## 7. 适配器（AD）— U（基于 Phase 0 夹具）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| AD-1 | 各 adapter `buildInvocation` 快照（每个 profile × resume/非 resume × model） | 与快照一致；**args 中不含 prompt**；stdin == prompt |
| AD-2 | 各 adapter 用真实夹具回放 `createParser` | 产出的 AgentEvent 序列与期望快照一致；session id、summary、usage 正确提取 |
| AD-3 | 解析降级：在夹具中插入非法 JSON / 未知 type / 截断行 | 降级为 log，不抛异常 |
| AD-4 | 高比例解析失败 + 退出码 0 | succeeded，summary 为最后 50 行，errorMessage 含格式警告 |
| AD-5 | `resolve-exe`：显式 command / PATH .exe / .cmd shim 解析 / 无 | 结果正确；shim 无法解析 → error |
| AD-6 | `argsOverride` | 覆盖后的参数生效 |
| AD-7 | probe 超时（假 CLI sleep 10 s） | 5 s 超时，status=error，不阻塞其他 adapter |
| AD-8 | Gemini delta 合并 | 1 000 个 delta 合并为 ≤ 20 个 message 事件 |
| AD-9 | Mock 全部剧本 | 行为与 06 §4.3 描述一致 |

## 8. Windows 专属（WIN）— W

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| WIN-1 | 取消 `spawn-tree depth=3 width=3` | 全部 13 个进程在 graceMs+3 s 内消失 |
| WIN-2 | 取消 `orphan`（父已退出、孙进程脱离父链） | Job Object 模式下孙进程被杀；（关闭 Job Object 时）记录 ORPHAN_SURVIVED 告警 |
| WIN-3 | 取消 `ignore-sigterm` | 优雅期后强杀成功，finished=cancelled |
| WIN-4 | **Worker 进程被 `taskkill /F` 杀死** | 所有 CLI 子孙进程随 Job 关闭而消失（Job Object 模式） |
| WIN-5 | 启动孤儿清理 + PID 复用防护：journal 中 pid 已被另一个无关进程复用 | 不杀该无关进程（创建时间不匹配） |
| WIN-6 | `.cmd` shim：只安装了 npm 全局 CLI 的环境 | 通过 shim 解析成功启动；不使用 shell |
| WIN-7 | 命令注入：prompt 含 `& calc.exe`、`" | del`、`%PATH%`、`^` | 原样作为 stdin 文本传给 CLI，无任何额外进程启动 |
| WIN-8 | 中文路径工作区（`D:\代码\项目`）与含空格路径 | 正常执行；cwd 正确 |
| WIN-9 | CRLF 输出 | 行切分正确，无残留 `\r` |
| WIN-10 | 计划任务安装/卸载 | `schtasks /Query` 可见；登录后自动启动；卸载后消失 |
| WIN-11 | 私钥文件 ACL | 仅当前用户可读（`icacls` 输出断言） |
| WIN-12 | 窗口隐藏 | 执行期间无控制台窗口弹出（`windowsHide`） |

## 9. 安全（SEC）— U/I

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| SEC-1 | subdir 穿越：`..\..\Windows`、`../etc`、`C:\x`、`\\server\s`、`\\?\C:\`、`a\..\..\b`、`CON`、`aux.txt`、`a:stream`、`x.`、`x ` | 全部 PATH_REJECTED |
| SEC-2 | 符号链接/Junction 逃逸：工作区内 junction 指向工作区外 | PATH_REJECTED |
| SEC-3 | 大小写绕过（Windows）：`D:\Code\Backend` vs 配置 `d:\code\backend` | 识别为同一路径（合法子路径通过，外部路径拒绝） |
| SEC-4 | 工作区根互相包含 | 配置加载失败并给出明确错误 |
| SEC-5 | env：Hub 下发 `NODE_OPTIONS`、`PATH`、`AGENT_WORKER_X` | 子进程中不存在或为本地值 |
| SEC-6 | env：子进程中无 Worker 私钥路径、无 `HUB_*` | 通过（mock-cli 打印自身 env 进行断言） |
| SEC-7 | extraArgs：Hub 下发 `--dangerously-skip-permissions` | 被过滤，审计/日志告警 |
| SEC-8 | profile clamp：Hub 请求 full，工作区 maxProfile=edit | 以 edit 运行，commandSummary 注明 clamped；strictProfile=true 时拒单 |
| SEC-9 | Requester 请求 full | 策略 H1 clamp 为 edit 且需审批 |
| SEC-10 | 脱敏：06 §6.5 每条规则的正例 | 替换为 `[REDACTED…]` |
| SEC-11 | 脱敏：负例（普通 hash、UUID、base64 图片片段） | 不误伤 |
| SEC-12 | 已知密钥值精确替换 | 替换 |
| SEC-13 | 私钥块跨行 | 整块被替换 |
| SEC-14 | ReDoS：每条正则 100 KiB 病态输入 | < 50 ms |
| SEC-15 | 面板：无 CSRF 头的 POST | 403 CSRF_FAILED |
| SEC-16 | 面板：错误 Origin 的 WS 升级 | 拒绝 |
| SEC-17 | 面板登录暴力 | 第 6 次 429 |
| SEC-18 | 飞书：Requester 点击审批按钮 | toast“仅负责人可操作”，状态不变 |
| SEC-19 | 飞书：Requester 取消他人任务 / 续接他人任务链 | 拒绝 |
| SEC-20 | Requester 受众卡片 | 不含工作区路径、命令行、面板链接、stderr |
| SEC-21 | enroll token：过期 / 重复使用 / 错误 | 全部拒绝；成功使用后再次使用拒绝 |
| SEC-22 | DB 中不存在任何明文密钥（admin token、API token、enroll token、会话 cookie 均为哈希） | 扫描 DB 断言 |

## 10. 数据库（DB）— I

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| DB-1 | 迁移：空库 → 最新；重复执行幂等 | 成功；`PRAGMA journal_mode` = wal，`auto_vacuum` = incremental |
| DB-2 | 迁移前自动备份 | 生成 `.bak-*`，最多保留 3 份 |
| DB-3 | 日志分页查询计划 | `EXPLAIN QUERY PLAN` 使用 `ux_logs_run_seq` |
| DB-4 | 调度扫描查询计划 | 使用 `ix_tasks_sched` |
| DB-5 | 日志幂等插入 | 重复 (run_id, seq) 不报错不重复 |
| DB-6 | 每 Run 日志上限 | 超过后以单条 `kind='gap'` (`reason='hub_cap'`) 区间占位且持续更新 `toSeq`，行数 O(1)，INV-7 区间连续，log_dropped_bytes 正确 |
| DB-7 | IngestQueue 有界 | 超过上限时 enqueue 延迟 resolve（背压），内存不增长 |
| DB-8 | 崩溃一致性：在事务中途 `process.kill` Hub（子进程方式） | 重启后 INV 全部成立 |
| DB-9 | 保留策略分片删除：100 万行日志 | 每片 ≤ 5000 行；期间并发写入日志的 p99 延迟 < 200 ms |
| DB-10 | 容量护栏 | 达阈值时告警/降级行为符合 07 §6 |

## 11. 面板 API（API）— I

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| API-1 | 04 §4 每个端点的成功路径 | 响应通过 DTO Schema 校验 |
| API-2 | 错误码表每一项至少一个触发用例 | HTTP 状态与 code 一致，含 requestId |
| API-3 | Idempotency-Key：同 key 同 body / 不同 body | 返回首次响应 / 409 IDEMPOTENCY_MISMATCH |
| API-4 | `:ref` 同时支持 `tsk_…` 与数字编号 | 通过 |
| API-5 | 游标分页：插入新任务时翻页 | 无重复无遗漏 |
| API-6 | WS：subscribe 后收到 snapshot，再收到增量；`eventSeq` 严格递增 | 通过 |
| API-7 | WS 续传：断开期间产生 100 个事件后 resume | resumed=true，补发恰好这些事件（仅已订阅主题） |
| API-8 | WS 续传越界（> 10 000 事件）或 bootId 变化 | resumed=false |
| API-9 | **日志 follow 拼接**：在 follow 过程中持续写入日志（mock flood） | 客户端收到的 seq 严格连续、无重复、无遗漏，最终与 DB 完全一致 |
| API-10 | 慢消费者：客户端不读 socket | logs.reset(slow_consumer)，随后 resync 并关闭；Hub 内存稳定 |
| API-11 | 合并节流：同一任务 250 ms 内 10 次更新 | 只推送 1~2 次 task.updated，且为最新 version |
| API-12 | 关闭中（draining）的变更请求 | 503 HUB_SHUTTING_DOWN；GET 正常 |

## 12. 面板 UI（DASH）— E（Playwright）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| DASH-1 | 登录、登出、会话过期跳转 | 通过 |
| DASH-2 | 手动派单（指定 Worker + mock success） | 看板卡片 queued → running → succeeded 实时移动 |
| DASH-3 | 抽屉实时终端：结构化视图与 Raw 视图切换 | 内容一致 |
| DASH-4 | 审批（改写 adapter/prompt） | 任务以覆写值执行，时间线记录改写 |
| DASH-5 | 取消运行中任务 | 状态 cancelling → cancelled，按钮禁用状态正确 |
| DASH-6 | Worker 断线 | 节点卡片显示离线 + 宽限期倒计时，恢复后变绿 |
| DASH-7 | Drain 切换 | 节点标识“排空中”，新任务不派发到该节点 |
| DASH-8 | 10 万行日志 | 抽屉滚动流畅（无长任务 > 200 ms） |

## 13. 飞书（FS）— U/I（FakeFeishuTransport）

| ID | 用例 | 预期 |
| :--- | :--- | :--- |
| FS-1 | `parseCommand` 全部指令正例 | AST 正确 |
| FS-2 | 引号：英文/中文引号、转义、全角空格 | 正确 |
| FS-3 | 未知指令 / 未知 flag / 缺参数 / 非法 profile | 返回错误与用法，不建任务 |
| FS-4 | Requester 使用 Owner 专属 flag（`--worker`、`--profile=full`） | 拒绝 |
| FS-5 | `/run` 多行 prompt | 换行保留 |
| FS-6 | taskRef 三种形式 | 正确解析 |
| FS-7 | 群聊未 @ 机器人 | 忽略 |
| FS-8 | 群聊 @ 机器人 + 文本 | 去除 @ 占位后建任务；进度卡片以引用回复形式发出 |
| FS-9 | 私聊 Owner 发自然语言 | 直接 queued（auto_approve），无审批卡片 |
| FS-10 | Requester 发需求 | 进度卡片“等待审批”；Owner 私聊收到审批卡片 |
| FS-11 | 重复 event_id / 重复 message_id | 只建一个任务 |
| FS-12 | 陈旧消息（create_time 早于启动 10 min 以上） | 丢弃，Owner 收到汇总提示 |
| FS-13 | 非文本消息 | 回复“暂仅支持文本” |
| FS-14 | 引用回复路由：05 §4.2 每个分支 | 动作与流程图一致 |
| FS-15 | Follow-up：继承 session、硬亲和原 Worker、原 Worker 离线时排队 | 通过 |
| FS-16 | **并发点击**：同一审批按钮 10 个并发回调（不同 event_id） | 恰好 1 次 APPROVE；其余 toast“正在处理/已处理”；每个回调 < 3 s 返回 |
| FS-17 | 旧版本卡片点击（ver 过期且动作已非法） | toast“任务状态已变化”，回调返回最新卡片 |
| FS-18 | 回调中 orchestrator 慢（注入 2.5 s 延迟） | 2 s 时返回“已提交”，结果随后由 patch 更新 |
| FS-19 | **CardUpdater 合并**：1 s 内 200 次进展变化 | 同一卡片 patch 次数 ≤ 1（NORMAL 间隔 3 s 内）；最终内容为最新状态 |
| FS-20 | 终态优先：运行中进展节流期间进入 succeeded | 1 s 内完成终态 patch |
| FS-21 | 429/频控注入 | 指数退避；1 分钟 ≥ 3 次后全局速率减半；最终一致 |
| FS-22 | 卡片不可更新错误 | 标记 dead，若任务活动则发送新卡片并更新绑定 |
| FS-23 | 卡片体积 > 28 KiB 的内容 | 截断后 ≤ 28 KiB，JSON 合法 |
| FS-24 | 卡片渲染快照：每个卡片状态 × 受众 | 与快照一致 |
| FS-25 | 长连接 reconnecting 期间的状态变化 | 恢复后补推最新卡片（只推最新，不逐条） |
| FS-26 | `owner_review` 策略 | 结果先到 Owner；Owner 点发送后 Requester 才收到 |
| FS-27 | 无权限用户私聊 | 24 h 内只回复一次“无权限” |

## 14. 端到端（E2E）— E（真实 Hub 进程 + 真实 Worker 进程 + mock-cli）

| ID | 场景 | 预期 |
| :--- | :--- | :--- |
| E2E-1 | 面板建任务 → mock success | succeeded，日志完整，summary 正确，INV 成立 |
| E2E-2 | mock fail | failed(NONZERO_EXIT) → retry → 第二个 Run succeeded |
| E2E-3 | 取消运行中任务 | cancelled，无残留进程 |
| E2E-4 | 超时 | timed_out |
| E2E-5 | 宽限期内断网（ChaosProxy cut 20 s） | succeeded，日志无缺无重 |
| E2E-6 | 宽限期外断网 | failed(WORKER_LOST)，Worker 恢复后进程被杀 |
| E2E-7 | Hub 重启（SIGTERM）期间任务运行 | 本机进程不中断；新 Hub 恢复后任务 succeeded |
| E2E-8 | 两个 Worker 调度：一个满载一个空闲 | 派给空闲者；drain 一个后全部派给另一个 |
| E2E-9 | 真实 claude-code（开发机，可选） | 只读 prompt succeeded，session 可被 follow-up resume |
| E2E-10 | 真实 codex（开发机，可选） | 同上 |
| E2E-11 | 飞书（Fake）：Requester 群聊提需求 → Owner 审批 → 执行 → 结果卡片 | 卡片状态序列正确 |
| E2E-12 | 飞书（Fake）：引用结果卡片追问 | 子任务 resume 同一 session、同一 Worker |
| E2E-13 | 飞书 + 面板同时审批 | 只执行一次 |
| E2E-14 | 飞书（真实，预发环境手工验收） | 05 全流程；记录 patch 实际频率与无 429 |

## 15. 性能与浸泡（PERF / SOAK）

| ID | 场景 | 通过标准 |
| :--- | :--- | :--- |
| PERF-1 | 单 Run 日志吞吐（mock flood，无节流网络） | Hub 持久化 ≥ 20 000 行/s；端到端延迟 p95 < 500 ms |
| PERF-2 | 4 Worker × 4 并发 × flood | Hub RSS < 512 MiB；面板 WS 正常 |
| PERF-3 | 100 个面板 WS 客户端订阅 tasks | 事件扇出 p95 < 200 ms |
| SOAK-1 | 24 h：每分钟 2 个 mock 任务（混合 success/fail/cancel/slow）+ 每小时随机断网 1 次 + 每 6 小时 Hub 重启 1 次 | 无内存持续增长（RSS 斜率 ≈ 0）、无孤儿进程、INV 全部成立、无卡在活动状态超过 timeout 的任务 |

---

## 16. 验收门禁汇总

| 阶段 | 必须通过 |
| :--- | :--- |
| Phase 0 | K-1~K-8（Spike 版）、WIN-1/2/4 原型 |
| Phase 1 | P-*、SM-1~SM-12、SEC-10~SEC-14、FS-1~FS-6、AD-9 |
| Phase 2 | K-*、GW-*、SM-*、SC-*、DB-1~DB-8、WK-1~WK-17、SEC-1~SEC-9、SEC-21/22、E2E-1~E2E-8 |
| Phase 3 | AD-*、WIN-*、E2E-9/10（开发机） |
| Phase 4 | API-*、DASH-*、SEC-15~SEC-17 |
| Phase 5 | FS-*、SEC-18~SEC-20、E2E-11~E2E-14 |
| Phase 6 | DB-9/10、PERF-*、SOAK-1 |
