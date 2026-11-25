# Pi 独立验收报告 · Phase 2（Hub 核心 + Worker 反向隧道/执行引擎 + Mock 全链路）

> 验收人：Pi（独立测试工程师） · 工作区：`E:\Agent工作流`
> 依据：`docs/handoff/pi-test-matrix.md`（§0 测试基础设施 + §16 Phase 2 门禁）、规格 01/02/03/06/07
> 基线 HEAD 状态：工作区非 git 仓库，以当前文件树为准。

---

## 0. 结论

**Phase 2 门禁：不通过（2 项 P1）**。其余 Phase 2 必测 ID 全部通过。

| 项目 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ 通过 |
| `pnpm lint` | ✅ 通过（0 error / 0 warning） |
| `pnpm depcheck` | ✅ 通过（110 modules / 295 deps，no violations） |
| `pnpm test` | ❌ **657 passed / 2 failed / 1 skipped**（35 个测试文件；失败项即下列 2 个 P1） |

失败的 2 条是**刻意保留的失败复现用例**（对应真实规格违背），不是测试自身缺陷：

| 缺陷 | 门禁 ID | 测试文件 / 用例 | 现象 |
| :--- | :--- | :--- | :--- |
| **P1-1** 鉴权后未知 `type` 被当成 Schema 失败 → 4400 断开 | `P-3` | `packages/hub/test/phase2-protocol.pi.test.ts` › `P-3 鉴权后未知 type` | 期望“告警并忽略、连接保持”，实测 `close 4400` |
| **P1-2** flood + 限速代理下 Worker RSS 增量超 150 MiB | `WK-9` | `packages/worker/test/phase2-process.pi.test.ts` › `WK-9 …` | 256 MiB flood 实测 RSS Δ = **275 ~ 315 MiB**（阈值 150 MiB） |

两处修复建议见 §4；其余门禁（K/P-8/SM/SC/GW/WK-其余/SEC/DB/E2E/WIN）均已逐 ID 验证通过。

---

## 1. 测试基础设施（pi-test-matrix §0）

新增可复用组件（测试辅助，不进入产物构建）：

| 组件 | 文件 | 能力 |
| :--- | :--- | :--- |
| `TestHub` / `FakeWorkerClient` / `ChaosProxy` / `assertInvariants` / `seedRun` / `eventually` | `packages/hub/test/pi/harness.ts` | 进程内 Cordis 组装 + 临时 SQLite **文件**；裸帧 WS 客户端（自定义 hello、manualHello、raw 帧、close code）；TCP 代理（`cut()` RST / `blackhole()` 半开 / `delay(ms)` / `throttle(bytesPerSec)` / `restore()`）；02 §7 INV-1~INV-8 + INV-7 区间连续性断言 |
| Worker 侧工厂（`startHub` / `enroll` / `startWorkerAt` / `seedRun` / `dispatchPayload` / `send`） | `packages/worker/test/pi/worker-harness.ts` | 真实 Hub（进程内）+ 真实 Worker（进程内/子进程）；手工 `run.dispatch` 注入以便逐项验证 03 §6.4 受理顺序 |
| 真实进程脚手架 | `packages/worker/test/phase2-process.pi.test.ts`、`packages/hub/test/phase2-e2e-restart.pi.test.ts` | 独立 Worker 子进程（`bin/agent-worker.mjs`）、独立 Hub 子进程（`dist/app.js` launcher，stdin `shutdown` 触发优雅关闭）、`Get-Process.WorkingSet64` RSS 采样 |

约定：`FakeClock` 驱动 TimerWheel/心跳/宽限期；时间参数按矩阵头部约定缩短（如 `gracePeriodMs=1000~4000`、`refuseBackoffMs=200`、`heartbeatTimeoutMs=30s`）。**每个集成/E2E 用例结束前调用 `assertInvariants(db)`**（WAL 文件库/内存库均覆盖；E2E-7 因 Hub 在独立进程，通过 HTTP 日志序号连续性 + 单 run/单 timer 断言替代直接访问 DB）。

---

## 2. 门禁逐 ID 结果

### 2.1 Cordis 内核（K）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| K-9 | ✅ | 插件 `ctx.on` 监听器在 fiber dispose 后不再被调用，`fiber.state === DISPOSED` |
| K-10 | ✅ | `workers` Fiber 重启 → `OrchestratorService`、`dashboard-api` 观测到 UNLOADING/PENDING 级联重建；`waitForActive` 成功；`hubBootId` 变化；重启后 `GET /api/v1/overview`、`/api/v1/tasks` 200 且与 DB 一致（同一 task id/version/status） |

### 2.2 协议线上语义（P）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| P-3（鉴权前） | ✅ | 未知 `type` → `close 4400` |
| **P-3（鉴权后）** | ❌ **P1-1** | 期望忽略并保持连接；实测 `close 4400`（见 §4.1） |
| P-8 | ✅ | 子协议缺失 → HTTP 400 拒升级；子协议错误 → HTTP 400 / 4426；鉴权前二进制帧 → 4400；鉴权前 >16 KiB 帧 → 4400（即使 < maxFrameBytes） |

### 2.3 状态机集成（SM）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| SM-13 | ✅ | 面板/飞书等价路径 **50 并发 approve**：恰好 1 次成功迁移，其余 `INVALID_TRANSITION`/`VERSION_CONFLICT`；`version +1`；`task_runs` 仅 1 行（attempt=1）；INV 全部成立 |
| SM-14 | ✅ | 并发 `cancel` + `RUN_SUCCEEDED`：终态收敛为 `succeeded` 或 `cancelled`，run 状态与终态一致，INV 全部成立 |
| SM-15 | ✅ | Hub 关闭后重开同一 SQLite：`approval_deadline_at` 重建；到点 `cancelled`，`version +1`；再推进 10 s 不重复触发 |
| SM-16 | ✅ | mock `need-input` + `inputTimeoutMs=1500`：`awaiting_input` → `cancelling` → `cancelled`，`errorCode=INPUT_TIMEOUT`，`input_requests.status=expired`，Worker `slotsUsed=0`（进程被终止） |

### 2.4 调度器（SC）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| SC-1 | ✅ | W1 仅 codex ready、任务要 claude-code → 不派单，`scheduleHint=NO_READY_ADAPTER` |
| SC-2 | ✅ | `adapterPrefs=[gemini,codex]` 无 gemini → 派 codex（dispatch payload 与 run.adapter 均为 codex） |
| SC-3 | ✅ | 无目标 workspace → `WORKSPACE_UNAVAILABLE`，不派单 |
| SC-4 | ✅ | `workspace.maxProfile=readonly` + 任务 edit → `PROFILE_NOT_ALLOWED`（Hub 侧过滤） |
| SC-5 | ✅ | W1 1/4 vs W2 0/2 → 选 W2 |
| SC-6 | ✅ | 同负载：`lastDispatchAt` 早者优先；派单后轮转到另一节点 |
| SC-7 | ✅ | `maxConcurrency=1` 且已有 1 个 dispatching → 不派单（`NO_AVAILABLE_SLOT`） |
| SC-8 | ✅ | 同 Worker 同 workspace 已有 edit → 第二个 edit 不派（`NO_AVAILABLE_SLOT`），readonly 仍可派 |
| SC-9 | ✅ | drain 后不派单；该 Worker 上运行中的 Run 正常完成 → `succeeded` |
| SC-10 | ✅ | 队首不可调度（缺 adapter）时第二个任务照常派发（无队头阻塞） |
| SC-11 | ✅ | priority 高者先；同优先级按 `queued_at`/`task_no` FIFO（dispatch 顺序断言） |
| SC-12 | ✅ | `requiredWorkerId=W2` 离线 → 保持 queued；W2 上线立即派发，诱饵 W1 不接单 |
| SC-13 | ✅ | Worker 回 `NO_SLOT` → Run 标 `refused`、`attempt_count` 回退为 0、排队；`refuseBackoffMs` 窗口内不再派给 W1；窗口后重新派发 |
| SC-14 | ✅ | Requester 已有 2 个活动任务 → 第 3 个 `REQUESTER_LIMIT` 保持 queued |
| SC-15 | ✅ | 1 ms 内 100 次 `worker/updated` 触发：仅 1 个 dispatch 帧、仅 1 个 run 行（单飞成立） |
| SC-16 | ✅ | `connection=suspect` → 不派单（`NO_ONLINE_WORKER`） |

### 2.5 Worker 网关与可靠传输（GW）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| GW-1 | ✅ | challenge → 签名 hello → welcome；`connection_epoch` 1→2 递增 |
| GW-2 | ✅ | 错误签名 / 错误 nonce / 错误 hubBootId / 指纹不符 → `hub.reject AUTH_FAILED` + 4401，epoch 不变 |
| GW-3 | ✅ | 未注册 workerId → 4401；已吊销 → 4403 + `WORKER_REVOKED` |
| GW-4 | ✅ | 不发 hello：4 999 ms 仍在线，5 001 ms 后 4408 |
| GW-5 | ✅ | 鉴权前 >16 KiB 帧 → 4400 |
| GW-6 | ✅ | 复用上一连接 hello 帧 → 4401（nonce/hubBootId 一次性） |
| GW-7 | ✅ | 同 workerId 第二连接：旧连接 4409，新连接正常；旧连接后续帧不落库（DB 中仅新连接的日志） |
| GW-8 | ✅ | 同 IP 5 次认证失败 → 第 6 次升级 HTTP 429；推进 30 min 后恢复握手 |
| GW-9 | ✅ | `maxUnauthenticated=64`：64 个未认证连接后第 65 个 HTTP 503（测试内提高升级速率桶以隔离该项） |
| GW-10 | ✅ | 重复 seq 不重复写库，回 `run.ack ackSeq=3`；DB 行 1..3 |
| GW-11 | ✅ | 1-10 后发 15-20：只持久化 1-10，回 `run.resend{fromSeq:11}`；补发 11-20 后 20 行有序连续 |
| GW-12 | ✅ | `run.gap` 写 1 行 `kind=gap`，`last_seq=toSeq`，INV-7 成立；后续 seq=6 继续连续 |
| GW-13 | ✅ | 在 `IngestQueue.enqueue` 提交前注入 gate：ack 之前无 ack 帧且 DB 无日志行；放行提交后才出现 `ackSeq=2` 且 DB 有 1..2 |
| GW-14 | ✅ | inbound 未注册（模拟 orchestrator 重启窗口）：不 ack、事件挂起；注册后收到 `run.resend{fromSeq:1}`，补发后持久化 + ack |
| GW-15 | ✅ | dispatch 后断线重连：同一 command id/runId 重发，`task_runs` 仅 1 行；ack 后转 running |
| GW-16 | ✅ | `CommandOutbox`：初次 + 3 次重发（共 4 次）后 reject `CommandTimeoutError`（DISPATCH_LOST 路径） |
| GW-17 | ✅ | 30 s 无帧 → `suspect`；45 s → `close 4408`，`connection=offline`，`disconnected_at` 记录 |
| GW-18 | ✅ | 真实 Worker + ChaosProxy `cut()`（宽限期内）：Run 保持 running，重连后继续，最终 succeeded；日志无缺无重，started/finished 各 1 |
| GW-19 | ✅ | `cut()`+`blackhole()` 超出宽限期：Task `failed`、`errorCode=WORKER_LOST`、Run `lost`；恢复后 Worker 收到 resume cancel 并杀进程（slotsUsed=0） |
| GW-20 | ✅ | 03 §7.2 对账表 7 行全覆盖（dispatching 未上报/上报、running|awaiting_input|cancelling 上报/未上报、终态上报、lost+未 finished、lost+finished、他 Worker） |
| GW-21 | ✅ | 400 帧突刺：`hub.reject RATE_LIMITED` + `close 4429`，连接置 offline，Hub 不崩溃 |
| GW-22 | ✅ | `workers` Fiber 重启（`hubBootId` 变化）：Worker 4503 后重连；运行中的 Run 恢复并 succeeded；日志连续 |
| GW-23 | ✅ | 鉴权后已知 type 的 Schema 失败（多余字段）→ 4400 且 `workerBadFrames +1` |

### 2.6 Worker 运行时（WK）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| WK-1 | ✅ | 03 §6.4 顺序逐项：`EXPIRED`、`WORKSPACE_UNKNOWN`、`PATH_REJECTED`、`ADAPTER_UNAVAILABLE`、`PROFILE_NOT_ALLOWED`(strict)、`NO_SLOT`、`WORKSPACE_BUSY`、`DRAINING` |
| WK-2 | ✅ | 同 runId 二次 dispatch：`ok=true` + `result.runState`，进程数仍 1 |
| WK-3 | ✅ | 已 finished 的 Run 再 cancel：`ok=true` 无操作 |
| WK-4 | ✅ | 同 `(runId,requestId)` 两次输入：stdin 只写一次，summary 只含一次答案 |
| WK-5 | ✅ | `slow` + `timeoutMs=10 s`（FakeClock 推进）：`timed_out`，`errorCode=TIMEOUT`，进程树被杀 |
| WK-6 | ✅ | `idle` + `idleTimeoutMs=10 s`：`timed_out`，`errorCode=IDLE_TIMEOUT` |
| WK-7 | ✅ | `unicode` 逐字节写入：`中文 😀`/`再见 🌍` 完整，无 U+FFFD |
| WK-8 | ✅ | 1 MiB 单行：事件 text ≤ 16 KiB 且含 `…[truncated N bytes]`，本地 `output.log` = 1 048 577 字节 |
| **WK-9** | ❌ **P1-2** | dropped 事件 ✅、seq 连续 ✅、started/finished 各 1 ✅、进程正常结束 ✅；**RSS Δ 275~315 MiB > 150 MiB**（见 §4.2） |
| WK-10 | ✅ | 无 ack 时在途字节 ≤ `maxInFlightBytes`（+1 帧余量），剩余仍在 `bufferedBytes`（背压停止发送） |
| WK-11 | ✅ | Worker 强杀：mock 子进程随 Job Object 关闭消失；重启后 `hello` 上报 `finished(WORKER_RESTARTED)`；Hub 收 gap+finished，Task `failed/WORKER_RESTARTED`，finished 仅 1 条 |
| WK-12 | ✅ | blackhole 下 finished 已写 journal 未 ack：强杀重启后补发，Hub 只记录 1 条 finished，日志连续 |
| WK-13 | ✅ | 第二实例（同 stateDir）退出码 **3** |
| WK-14 | ✅ | `close()`：`worker.state(drain)` → cancel → `finished(WORKER_SHUTDOWN)`（Hub ack 后 `worker.bye`）→ `close 1000`；Run/Task `cancelled`，`errorCode=WORKER_SHUTDOWN`，Hub `worker/disconnected` reason=`1000` |
| WK-15 | ✅ | 4403 → 告警并以 1 退出（停止重连）；4426（假 Hub 只提供 v2）→ 以 1 退出；4401 → 本地 FATAL 日志、5 min 长退避（4 s 内无第二次升级，epoch 仍 0） |
| WK-16 | ✅ | `backoff` 1s/2s/4s… 上限 30 s；welcome 后 attempt 归零（真实重连两次均 ~1 s 恢复） |
| WK-17 | ✅ | 热重载 worker.yaml 新增 workspace：drain→探测→重连，hello 上报 2 个 workspace |

### 2.7 安全护栏（SEC）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| SEC-1 | ✅ | `..\..\Windows`、`../etc`、`C:\x`、`\\server\s`、`\\?\C:\`、`a\..\..\b`、`CON`、`aux.txt`、`a:stream`、`x.`、`x `、`/etc/passwd` 全部拒绝；合法子目录通过 |
| SEC-2 | ✅ | 工作区内 junction 指向工作区外 → 拒绝；指向内部 → 允许 |
| SEC-3 | ✅ | `D:\Code\Backend` vs `d:\code\backend` 视为同一路径；`Backend-evil` 拒绝；真实目录大小写不同可通过 |
| SEC-4 | ✅ | 工作区根互相包含 → `Overlapping workspace roots` |
| SEC-5 | ✅ | 默认 allowlist 为空：Hub 下发 `PATH`/未知键不生效；即使本地显式允许，`NODE_OPTIONS`/`AGENT_WORKER_*` 仍被剔除 |
| SEC-6 | ✅ | 真实子进程 env 无 `HUB_*`/`AGENT_WORKER_*`/`WORKER_PRIVATE_KEY`/`NODE_OPTIONS`；强制 `NO_COLOR=1`/`CI=1` 存在 |
| SEC-7 | ✅ | `--dangerously-skip-permissions` 被过滤并计数告警（1 条）；未列入白名单参数一律去除 |
| SEC-8 | ✅ | `effectiveProfile(full, edit)` → edit + `clampedFrom`；`strictProfile` → 拒绝（Worker `PROFILE_NOT_ALLOWED`） |
| SEC-9 | ✅ | Requester 请求 full → 策略 H1 clamp 为 edit + `require_approval`；任务 profile=edit |
| SEC-21 | ✅ | enroll token：错误/过期/suggestedWorkerId 不符/复用 全部 401；成功后再次使用拒绝；DB 仅哈希 |
| SEC-22 | ✅ | DB 文件（checkpoint 后）字节扫描：admin token、API token、enroll token、session cookie **均无明文**；`sha256(token)` 可反查 |

### 2.8 数据库（DB）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| DB-1 | ✅ | 空库迁移 → `journal_mode=wal`、`auto_vacuum=2(incremental)`、`user_version=1`；重复打开幂等 |
| DB-2 | ✅ | 旧库迁移前生成 `.bak-*`；预置 5 份历史备份 → 迁移后仅保留 3 份 |
| DB-3 | ✅ | `EXPLAIN QUERY PLAN` 日志分页命中 `ux_logs_run_seq` |
| DB-4 | ✅ | 调度扫描命中 `ix_tasks_sched` |
| DB-5 | ✅ | 重复 `(run_id, seq)` 不报错不重复 |
| DB-6 | ✅ | `maxBytesPerRun=100`：50 条 log → **单条** `kind=gap`（`reason=hub_cap`），`toSeq` 原地推进到 50/51，行数 O(1)，INV-7 连续，`log_dropped_bytes>0` 且与 gap.droppedBytes 一致 |
| DB-7 | ✅ | `maxQueueRows=2`：第 3 个 enqueue 进入等待（`ingestWaiters=1`），flush 后按序 resolve；400 次未 flush 入队时 `depth≤2`、`waiters≤256`，超出者 reject（有界背压） |
| DB-8 | ✅ | 子进程事务中途 `SIGKILL`：重启后 tasks/task_runs/task_logs 全空（完整回滚），`integrity_check=ok`，`user_version=1` |

### 2.9 端到端（E2E）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| E2E-1 | ✅ | 建任务 → mock success：`succeeded`，summary=`Mock response 5`，started 1 条，最后一条 finished，日志连续，INV 成立 |
| E2E-2 | ✅ | mock fail → `failed/NONZERO_EXIT`；Owner retry（覆写 prompt）→ 第 2 个 Run `succeeded`，2 个 run 行 |
| E2E-3 | ✅ | 运行中取消 → `cancelled`，CLI pid 退出，`slotsUsed=0`，无残留 |
| E2E-4 | ✅ | `timeoutMs=60 s` + slow：`timed_out`，`errorCode=TIMEOUT` |
| E2E-5 | ✅ | ChaosProxy cut ×2（宽限期内）：`succeeded`，日志无缺无重，started/finished 各 1 |
| E2E-6 | ✅ | 宽限期外断网：`failed/WORKER_LOST`；Worker 恢复后进程被杀、pid 消失 |
| E2E-7 | ✅ | **独立 Hub 子进程 + 独立 Worker 子进程**：运行中优雅关闭 Hub（`hub.close()`，等价 SIGTERM 处理路径）→ Worker/CLI 进程存活 → 同 DB/端口重启 → 同 pid 继续 → `succeeded`；日志 seq 连续、started/finished 各 1 |
| E2E-8 | ✅ | 双 Worker：满载 A + 空闲 B → 派 B；drain B 并释放 A 槽位 → 新任务派 A 且成功 |

### 2.10 Windows 复核（WIN-2 / WIN-5）

| ID | 结果 | 覆盖点 |
| :--- | :--- | :--- |
| WIN-2 | ✅（降级路径） | 关闭 Job Object 时 `trackProcessTree` 为 `taskkill` 模式；脱离父子链的进程存活 → 记录 `ORPHAN_SURVIVED` 告警；根进程被杀。Job Object 主路径由 WK-11 验证（强杀 Worker 后子孙进程消失） |
| WIN-5 | ✅ | journal 中 `pidStartTime` 不匹配 → **不杀**无关进程（1500 ms 后仍存活）；写入正确创建时间后才清理，且清理成功 |

---

## 3. 统计

- 新增 Pi 测试文件 **14 个**（hub 10 + worker 4；另有 2 个 helper 不单独计数）
  - hub：`phase2-protocol.pi`、`phase2-kernel.pi`、`phase2-gateway.pi`、`phase2-transport.pi`、`phase2-state.pi`、`phase2-scheduler.pi`、`phase2-db.pi`、`phase2-auth.pi`、`phase2-e2e.pi`、`phase2-e2e-restart.pi`
  - worker：`phase2-security.pi`、`phase2-runtime.pi`、`phase2-process.pi`、`phase2-windows.pi`
- Phase 2 必测 ID：**K-9/10、P-3/P-8、SM-13~16、SC-1~16、GW-1~23、WK-1~17、SEC-1~9/21/22、DB-1~8、E2E-1~8、WIN-2/5** 共 **93 个 ID**（部分 ID 拆多子用例，总计 660 次断言）。
- 全量：**660 tests / 657 passed / 2 failed / 1 skipped**（skip 为 Phase 1 既有测试）。

---

## 4. 缺陷详情（需 Codex 定点修复）

### P1-1 · 鉴权后未知 `type` 被 4400 断开（违背规格 03 §2）

- **规格**：`03-protocol-hub-worker.md` §2：「接收方对未知 `type`：鉴权前 → 4400；**鉴权后 → 记录告警并忽略（向前兼容）**」。
- **实测**：已鉴权连接发送 `{v:1,id,ts,type:"worker.future",payload:{}}` → Hub `close(4400, 'bad frame')`，连接断开。
- **根因定位**：`packages/hub/src/plugins/worker-gateway-ws/index.ts` → `message()`：
  ```ts
  const frame = WorkerToHubFrame.safeParse(json)
  if (!frame.success) { this.badFrames++; return conn.ws.close(4400, 'bad frame') }
  ```
  `WorkerToHubFrame` 是 `z.discriminatedUnion('type', …)`，未知 `type` 与“字段非法/多余字段”一样落到 `!frame.success`。缺少「信封合法但 type 未知 → 告警 + return」的分支。
- **修复建议**：鉴权后先用 `Envelope.safeParse(json)` 判断信封；若 `type` 不在 `WorkerToHubFrame` 已知集合 → `ctx.logger.warn`（或指标 `unknownFrames++`）并 `return`（保持连接）；仅当 type 已知但 payload 校验失败才 4400（GW-23 行为不变）。
- **复现**：
  ```powershell
  npx vitest run --root . --project hub packages/hub/test/phase2-protocol.pi.test.ts -t "P-3"
  ```

### P1-2 · flood + 限速代理下 Worker RSS 增量超 150 MiB（WK-9）

- **规格**：`03-protocol-hub-worker.md` §5.4 / 矩阵 WK-9：`flood` + Hub 端限速下，**Worker RSS 增量 < 150 MiB**，且产生 `dropped`、`seq` 连续、`started`/`finished` 必达。
- **实测**（Windows，独立 Worker 子进程，`Get-Process.WorkingSet64`，基线 ~80 MiB）：

  | 场景 | RSS 峰值 Δ | dropped | seq 连续 | started/finished | 完成后 RSS |
  | :--- | ---: | :---: | :---: | :---: | ---: |
  | flood 64 MiB，限速 1 MiB/s，默认 8 MiB outbox | **~198 MiB** | 1 | ✅ | ✅ | 75~79 MiB |
  | flood 64 MiB，限速 1 MiB/s，outbox 256 KiB | **~274 MiB** | — | — | — | — |
  | flood 256 MiB，限速 1 MiB/s，默认 outbox | **275~315 MiB** | 1 | ✅ | ✅ | 75~79 MiB |
  | flood 128 MiB，**不限速** | ~0（完成后 77 MiB） | — | — | — | 77 MiB |

- **分析**：`RunOutbox` 的字节窗口与 `dropped` 逻辑本身是生效的（dropped 产生、seq 连续、started/finished 必达、无永久泄漏，完成后 GC 回落到 ~78 MiB）。但**限速期间** Run 长时间停在 `running`，V8 中由 64~256 MiB 输出产生的临时字符串/JSON 垃圾没有 GC 压力（网络侧只做丢弃，不再产生新分配），RSS 高水位随 flood 总量增长（约 1.2~3× flood 字节），与 `runBufferBytes` 配置无关。按矩阵原定参数（flood 500 MiB + 100 KiB/s）外推，RSS 增量预计 ~600 MiB 以上，**必然超过 150 MiB 阈值**，构成真实 OOM 风险（T12 资源耗尽）。
- **修复建议**（任选/组合）：
  1. Worker 进程启动时设定 `--max-old-space-size`（如 256~384 MiB）并处理 OOM 降级（返回 `finished{failed, ADAPTER_ERROR}`），保证“有界失败”；
  2. 降低逐行临时分配：`TextDecoder` 复用、避免 `JSON.stringify` 每事件、`boundLogLine` 复用 buffer，必要时用 `--max-semi-space-size` 调参；
  3. 背压路径显式周期性触发 GC（如 `v8.setFlagsFromString('--expose-gc')` + 受限 `global.gc()`，仅在测试/诊断构建），或把 flood 输出切成更小的流式批次（先整流丢弃再计数）。
  4. 修复后请保留本用例作为回归（当前 `rssDeltaMiB` 会在断言 diff 中输出）。
- **复现**：
  ```powershell
  npx vitest run --root . --project worker packages/worker/test/phase2-process.pi.test.ts -t "WK-9"
  ```

---

## 5. 说明与偏差（非缺陷）

1. **时间参数缩短**：按矩阵头部约定，`gracePeriodMs`、`refuseBackoffMs`、`inputTimeoutMs`、`ackIntervalMs` 等在测试中缩短；WK-5/6 用 `FakeClock` 推进 10 s 超时窗口。WK-9 使用 256 MiB flood（500 MiB 会显著拉长 CI 时间且不改变结论方向）。
2. **E2E-7 的“SIGTERM”**：Windows 无法向另一进程投递真实 SIGTERM（`process.kill(pid,'SIGTERM')` 会直接终止进程，不走 handler）。因此独立 Hub 子进程通过 stdin 命令调用 `hub.close()`（即 SIGTERM handler 的同一路径）来验证“优雅关闭 → Worker 不受影响 → 重启恢复”。
3. **E2E-4** 使用 `timeoutMs=60_000`（`CreateTaskRequest.timeoutMs` 下限 60 s），因此该用例耗时约 60~70 s。
4. **GW-9** 为提高升级速率桶（`upgradesPerMinute=1000`）以在同 IP 下构造 64 个未认证连接；`maxUnauthenticated=64` 保持默认语义。
5. **GW-20** 以 `reconcileWorker` 单元级逐行覆盖 03 §7.2（7 行全绿），并配合 GW-18/19/22 的真实链路验证。
6. **WK-10** 以 `RunOutbox` 单元级验证在途窗口（Hub 不发 ack 场景），真实链路 ack 停发由 GW-13 覆盖。
7. **WIN-2** 的 Job Object 主路径通过 WK-11（强杀 Worker → 子孙进程消失）验证；`ORPHAN_SURVIVED` 降级告警路径在关闭 Job Object 时以 kill-tree 单元验证。**未能**在 Windows 上构造“进程确实不可被杀”的场景，故该 ID 标注为“降级路径验证通过”，如需 100% 覆盖需 Phase 3 的真实孤儿用例。
8. Phase 3/4/5 项（AD-*、WIN-1/3/4/6~12、API-*、DASH-*、FS-*、E2E-9/10/11~14）不在本轮范围。

---

## 6. 验收命令

```powershell
pnpm -r build          # ✅
pnpm lint              # ✅
pnpm depcheck          # ✅
pnpm test              # ❌ 2 failed（P1-1、P1-2）

# 定点复现
npx vitest run --root . --project hub   packages/hub/test/phase2-protocol.pi.test.ts -t "P-3"
npx vitest run --root . --project worker packages/worker/test/phase2-process.pi.test.ts -t "WK-9"
```

修复 P1-1 / P1-2 后，预期 `pnpm test` 全绿（657 → 659 passed，0 failed，1 skipped）。请主 Agent 裁决并派 Codex 定点修复；Pi 可在修复后按同一套件回归。
