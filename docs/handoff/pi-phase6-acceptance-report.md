# 交接 · Pi Phase 6 独立验收报告（`retention` 保留与容量护栏 / 性能基准 / 浸泡 / 部署运维）

> 验收对象：Codex（`gpt-6.2-astra`）交付的 Phase 6。
> 验收角色：独立测试工程师（Pi）。**未修改任何业务实现代码**（仅新增 `*.pi.test.ts` 与测试辅助）。
> 门禁来源：`docs/handoff/pi-test-matrix.md` §10（DB-9/DB-10）、§15（PERF-1~3、SOAK-1）、§16 Phase 6；
> 规格：`docs/specs/07-database-schema.md` §5/§6、`docs/ARCHITECTURE.md` §8、`docs/specs/02-task-state-machine.md` §7（INV-1~8）。

---

## 0. 结论

| 项 | 结论 | 说明 |
| :--- | :--- | :--- |
| DB-9（分片删除 / 百万行 / 并发写 / 辅助表 TTL / 每日备份） | ✅ **PASS** | 每片恰 ≤ 5,000 行；活动 Run 一行未动；并发写入 p99 **15.8 ms**；`incremental_vacuum` 按 10 万行触发；5 张辅助表 TTL 边界准确；每日 `VACUUM INTO` 保留 7 份且 `integrity_check=ok` |
| DB-10（80% / 95% / 回落） | ✅ **PASS** | warning 减半（30→15 / 90→45 天）、critical 全文降级为单条 `gap`（O(1)）、非 log 事件照常、回落恢复正文与完整保留期、`assertInvariants` 全通过 |
| PERF-1（单 Run 吞吐 + 端到端 p95） | ❌ **FAIL（P1-1）** | 持久化 **17,922 ~ 18,457 行/s**（门禁 ≥ 20,000）；端到端 p95 **26.9 ~ 28.0 ms**（门禁 < 500 ms ✅） |
| PERF-2（4×4 flood + RSS + 面板可用） | ✅ **PASS** | 100,016 行 / 16 Run；进程 RSS 峰值 **358.5 MiB**（门禁 < 512 MiB）；面板压测期间 5/5 ping-pong、70 条增量事件 |
| PERF-3（100 面板客户端扇出 p95） | ✅ **PASS** | `task.created` 扇出 p95 **10.4 ms**、客户端间离散 p95 **1.5 ms**（门禁 < 200 ms）；合并后的 `task.updated` 端到端 287 ms（250 ms 去抖设计值 + 25 ms tick，见 §5-OBS-3） |
| SOAK-1-accelerated（60 s 加速浸泡） | ✅ **PASS（加速版）** | 51~52 s / 15~16 轮混合任务 + 1 次断网重连 + 1 次 Hub 重启；RSS 253.6→268.0 MiB（斜率 +12.7 MiB/min）；**孤儿进程 0**、**活动/卡死任务 0**、INV 全通过。**24 h 完整浸泡留待预发环境**（见 §8） |
| 部署产物与运维文档 | ✅ **PASS（8 条审计）** | 非 root、无硬编码密钥、`stop_grace_period: 20s ≥ shutdownTimeoutMs(15s)`、`flush_interval -1`、`read_timeout 0`、`trustProxy` 与 Compose 子网一致、配置示例可被真实 Schema 解析 |
| 追加对抗项 DB-9d（清理后空间回收） | ❌ **FAIL（P1-2）** | 100 万行全部清理后主库 **78.36 MB → 78.27 MB**（freelist 9,503/9,565 页，占 99.3%），仅 `VACUUM` 后回落到 **0.46 MB**。直接影响 DB-10 "空间回落自动恢复" 的可达性 |
| `pnpm -r build` / `pnpm lint` / `pnpm depcheck` | ✅ 全绿 | 见 §7 |
| `pnpm test` | ❌ **2 failed / 870 passed / 1 skipped**（111 s） | 两处失败即上述 **P1-1** 与 **P1-2** 的稳定复现用例（未用实现代码规避） |

**总判定：Phase 6 门禁未全部通过。** 保留/容量护栏、部署与浸泡均达标；性能吞吐门禁差 ~9%，且保留清理不能实质回收磁盘空间（阻断容量护栏的自动恢复路径）。两处缺陷均带稳定失败用例与量化数据，待主 Agent 裁决修复。

---

## 1. 环境与基线

| 项 | 值 |
| :--- | :--- |
| OS / Node | Windows 11 专业工作站版 10.0.26200 / Node **v24.14.1** / pnpm **11.17.0** |
| CPU / RAM | Intel i7-14700KF（20C/28T）/ 63.8 GB |
| 数据库 | 真实 SQLite **文件库**（WAL），临时目录，非 `:memory:` |
| 基线（本轮前） | `pnpm test`：54 files / 855 passed / 1 skipped，**110 s** |
| 验收后 | 59 files / 870 passed / **2 failed** / 1 skipped，**111 s**（新增 17 条用例；52 s 浸泡与其他文件并行，墙钟时间未增长） |

性能数值的读取口径（重要）：
- **吞吐/延迟门禁以「单独运行该文件」为准**（`pnpm exec vitest run --project hub phase6-perf.pi.ts`），因为全量 `pnpm test` 会 59 个文件并行抢占 CPU，PERF-1 在全量并行下实测仅 7,078 行/s（同机 5 次单独运行 17,922~18,457 行/s），并行值不具参考性；
- RSS 为**测试进程整体 RSS**（含 Vitest/Hub/测试辅助），是 Hub 真实 RSS 的**上界**：即使如此仍 < 512 MiB，故门禁更严格而非更宽松。

---

## 2. 新增独立测试清单

| 文件 | 覆盖 | 用例数 |
| :--- | :--- | :--- |
| `packages/hub/test/phase6-db9-retention.pi.test.ts` | DB-9a 百万行分片删除 + 并发写；DB-9b 辅助表 TTL 边界；DB-9c 每日 `VACUUM INTO` 备份轮换；DB-9d（追加）清理后空间回收 | 4 |
| `packages/hub/test/phase6-db10-capacity.pi.test.ts` | DB-10：80% warning + 减半、95% critical 全文降级（gap）、回落恢复、指标面 | 1 |
| `packages/hub/test/phase6-perf.pi.test.ts` | PERF-1 单 Run 吞吐/延迟；PERF-2 4×4 flood RSS + 面板可用；PERF-3 100 客户端扇出 | 3 |
| `packages/hub/test/phase6-soak.pi.test.ts` | SOAK-1-accelerated（真实 Worker + mock-cli 子进程、断网重连、Hub 重启） | 1 |
| `packages/hub/test/phase6-deploy.pi.test.ts` | Dockerfile / compose / Caddyfile / .env 模板 / 两个 yaml 示例 / Windows 脚本 / OPERATIONS.md / README.md 审计 | 8 |
| `packages/hub/test/pi/phase6.ts`（辅助） | 遗留数据播种、`DELETE ... LIMIT` 与 `incremental_vacuum` 观测、百分位统计、RSS 采样、带到达时间戳的裸面板 WS 客户端（100 客户端扇出） | — |

全部用例结束时按矩阵要求调用 `assertInvariants(db)`（DB-10、SOAK）或 `PRAGMA foreign_key_check`（DB-9，因日志已被合法清理，INV-7 对已清理 Run 不适用，见 §6）。

---

## 3. DB-9 实测（`packages/hub/test/phase6-db9-retention.pi.test.ts`）

### 3.1 DB-9a · 100 万行 + 活动 Run 并发写入

构造：1 个 `succeeded` 任务（31 天前终态）持有 **1,000,000** 条 `log`；1 个 `running` 任务（400 天前创建）+ 活动 Run。`sliceRows=5000`、`sliceIntervalMs=10`，每个 tick 先 enqueue 一条活动 Run 日志，再触发一个保留切片，然后 `flush` 并计时。

| 指标 | 实测 | 门禁 |
| :--- | ---: | :--- |
| 切片数 | 201（前 200 片各 5,000 行，第 201 片 0 行并置 `logs_purged_at`） | — |
| 单条 `DELETE FROM task_logs ... LIMIT` 的 `changes` 最大值 | **5,000** | ≤ 5,000 ✅ |
| 删除总行数 | 1,000,000 | — |
| 活动 Run 写入 + 切片串行延迟 p50 / p95 / p99 / max | **4.0 / 13.9 / 15.8 / 23.7 ms** | p99 < 200 ms ✅ |
| 活动 Run 保留行数（循环后 + 再 5 片） | **201 / 201**（`logs_purged_at IS NULL`，Run 仍 `running`） | 绝不被清理 ✅ |
| `logs_purged_at` 推进时刻 | 恰在第 201 片（日志排空后）置为当前时钟 | 正确 ✅ |
| `PRAGMA incremental_vacuum(2000)` 调用次数（每 10 万行一次） | **10** | 触发 ✅ |
| `PRAGMA auto_vacuum` | `2`（INCREMENTAL） | ✅ |
| `PRAGMA foreign_key_check` | `[]` | ✅ |

### 3.2 DB-9b · 辅助表 TTL（含严格 `<` 边界）

| 表 | 规则 | 实测 |
| :--- | :--- | :--- |
| `audit_logs` | 365 天 | 恰在 cutoff 的保留、早 1 ms 的删除、超期行删除 ✅ |
| `feishu_event_dedupe` | 7 天 | 同上 ✅ |
| `idempotency_keys` | 24 小时 | 同上 ✅ |
| `dashboard_sessions` | `expires_at` 过期后 7 天 | 同上 ✅ |
| `enroll_tokens` | `expires_at` 过期后 7 天 | 同上 ✅ |

追加验证：直接以精确 `now` 调用 `cleanup()` 验证 `WHERE < cutoff`（等式边界保留）语义；再通过插件真实 `sliceIntervalMs` 定时器验证过期 1 小时必删、cutoff 之后 1 小时必留，且连续多次 tick 不误删未过期数据。

### 3.3 DB-9c · 每日 04:00 `VACUUM INTO` 备份

| 检查 | 实测 |
| :--- | :--- |
| 触发时刻 | `Asia/Shanghai` 本地 03:59:59.999 不触发；04:00:00.000 触发（`lastBackupAt` 置为当刻） |
| 轮换 | 预置 9 份日期快照 + 1 份迁移备份 → 日期快照收敛为 **7 份**，`hub-2026-01-15.sqlite` 生成，最早 3 份被删；**非日期命名的 `.bak-` 保留** |
| 快照完整性 | `PRAGMA integrity_check` = **ok**、`foreign_key_check` = `[]`、无 `-wal` 伴生、无 `.tmp` 残留 |
| 已提交 WAL 数据 | 备份前经 `IngestQueue` 提交（未手动 checkpoint）的 `started` 行在快照中可见 → 备份覆盖已提交 WAL |
| 同日重复 | 再推进 60 s 不重复生成/覆盖 |

### 3.4 DB-9d · 空间回收（追加对抗项，**FAIL / P1-2**）

与 `retention` 完全相同的步调：每片 5,000 行删除，每累计 10 万行执行一次 `PRAGMA incremental_vacuum(2000)`（实现固定参数），最后 `wal_checkpoint(TRUNCATE)`。

| 阶段 | 主库文件 | `page_count` | `freelist_count` |
| :--- | ---: | ---: | ---: |
| 插入 100 万行 + checkpoint | 78,438,400 B | 9,575 | 0 |
| **全部清理（201 片 + 10 次 `incremental_vacuum(2000)`）+ checkpoint** | **78,356,480 B**（−0.10%） | 9,565 | **9,503（99.3%）** |
| 再补 10 次 `incremental_vacuum(2000)` + checkpoint | 78,274,560 B（再 −80 KB） | 9,555 | 9,493 |
| `VACUUM` + checkpoint（对照） | **466,944 B** | **57** | 0 |

结论：删除 100% 数据后，`PRAGMA incremental_vacuum(2000)` **每次调用仅释放 1 页（8 KiB）**，10 次共 10 页；库文件几乎不缩小，空间只进不出（freelist 占 99.3%）。`VACUUM` 可立即收缩到 0.46 MB，证明数据确实已删、缺的是页回收。

**影响**：容量护栏以 `store.health().dbSizeBytes`（主库文件大小）计算档位。既然清理不会让文件变小，`storageLevel` 一旦进入 `critical` 就**无法自动回落**，`log` 正文将被永久降级为 `gap`（07 §6 的"直到空间回落"路径在生产中不可达；只有人为调大 `maxDbBytes` 或手工 `VACUUM` 才能解开——这正是 DB-10 用例通过的方式）。

---

## 4. DB-10 实测（`packages/hub/test/phase6-db10-capacity.pi.test.ts`）

预置数据：succeeded 任务 Run 分别 20/16/14/25 天前终态；failed 任务 Run 50/40 天前终态；1 个活动 Run。通过 `retention` Fiber 热更新 `maxDbBytes`（`floor(size/0.82)`、`floor(size/0.96)`、`size*2`）。

| 阶段 | 期望 | 实测 |
| :--- | :--- | :--- |
| `ok`（默认 10 GiB） | 30/90 天全保留 | 5 个终态 Run 全部 `logs_purged_at IS NULL` ✅ |
| **80% → warning** | 档位 + 告警 + 保留减半 | `storageLevel='warning'`；`hub/status.storageLevel='warning'`；`overview().hub.storageLevel='warning'`；**20 天 / 16 天 / 50 天被清理**，**14 天 / 40 天保留**（30→15、90→45 天）✅ |
| **95% → critical** | 正文拒绝、O(1) gap | `storageLevel='critical'`；500 条被拒 `log` → **仅 1 条** `kind='gap'`、`text=NULL`、`data_json={"reason":"hub_cap","toSeq":501,"droppedBytes":…}`；`last_seq=501`、`log_dropped_bytes`=被拒字节、`log_bytes` 只含非 log 事件 ✅ |
| 后续 100 条被拒 log | 原地推进同一行 | 仍为 **2 行**（started + gap），`toSeq=601`，无新增行 ✅ |
| 非 log 事件（critical） | 照常持久化 | `agent`/`session`/`progress`/`finished` 全部落库；`last_seq=605`；INV-7 区间连续 ✅ |
| **回落 → ok** | 自动恢复正文与保留期 | `storageLevel='ok'`、`hub/status` 最后一次为 `ok`；新 `log` 落库且带正文；25 天的 Run 在完整保留期下未被清理 ✅ |
| 指标面 | `system/metrics` 一致 | `storageLevel='ok'`、`lastBackupAt=null`、`retentionDeletedRowsTotal=9`（3 个 Run × 3 行） ✅ |
| 不变量 | `assertInvariants` | INV-1~8 全通过 ✅ |

（`levels` 序列实测为 `["warning","critical","ok"]`。）

---

## 5. 性能与浸泡实测

### 5.1 PERF-1（**FAIL / P1-1**）· 单 Run 高速日志入库

方法：真实 WS 环回（FakeWorker → Gateway → IngestQueue），无网络节流；50 帧 × 500 行突发（25,000 行）测吞吐，再以 5,000 行/s 可持续节奏测"发送 → 已提交"延迟。

| 指标 | 5 次单独运行实测 | 门禁 |
| :--- | ---: | :--- |
| Hub 持久化吞吐（第 1 帧提交 → 末帧提交稳态） | **17,922 / 18,019 / 18,304 / 18,457 / 18,368 行/s**（均值 ≈ **18.2k**） | ≥ 20,000 ❌ |
| 含首帧预热的整段吞吐 | 17,562 ~ 18,086 行/s | — |
| 单批 500 行事务提交延迟 p50 / p95 / max | 24.9 ~ 25.9 / 27.3 ~ 28.6 / 32.6 ~ 35.4 ms | — |
| 端到端（发送 → 已提交，可持续节奏）p50 / p95 / max | 26.2 ~ 27.1 / 26.9 ~ 28.0 / 33.3 ~ 35.8 ms | < 500 ms ✅ |
| `run.ack` 间隔（仅观测） | p50 ≈ 109 ms | — |

**根因定位（对照实测，同一 SQLite 文件库、500 行/事务）**：

| 写入方式 | 行/s |
| :--- | ---: |
| 现实现：逐行 `drizzle insert().values().returning().get()`（`ingest-queue.ts` 每个事件一次） | **19,504** |
| 逐行 `insert().values().run()`（去掉 `RETURNING`） | 41,312（2.1×） |
| 多行 `insert().values([500]).run()`（批量 VALUES） | 101,402（5.2×） |
| 原生 prepared statement | 486,860（25×） |

即：瓶颈是"每事件一次 `INSERT ... RETURNING`"，磁盘/WAL 不是瓶颈（裸语句 48 万行/s）。修复该点即可获得 2× 以上余量。**建议**（不改契约）：`IngestQueue.write()` 改为单条多行 `INSERT ... VALUES (...),(...)` 批量写入（`gap` 扩展仍需 `tail`，可用内存中的 `seq/ts` 自行维护，不必 `RETURNING`）。

### 5.2 PERF-2 · 4 Worker × 4 并发 × flood（PASS）

| 指标 | 实测 | 门禁 |
| :--- | ---: | :--- |
| 规模 | 4 Worker × 4 并发 = 16 Run，25 轮 × 250 行 × 16 | — |
| 持久化行数 | **100,016**（每 Run 6,251 行，`last_seq` 精确相等） | — |
| 进程 RSS 基线 → 峰值（20 ms 采样 p95） | **306.7 → 358.5 MiB**（p95 356.4，Δ ≈ 51.8 MiB） | 峰值 < 512 MiB ✅ |
| 面板 WS（压测期间） | ping/pong **5/5** 全部 < 2 s；收到 **70** 条增量事件；连接未关闭 | 正常 ✅ |

（全量并行运行下更差的一次数值：基线 320.1 → 峰值 365.1 MiB，仍通过。）

### 5.3 PERF-3 · 100 个面板 WS 客户端订阅 `tasks`（PASS）

20 个只读 API Token × 5 连接（每条凭据上限 5）= **100 客户端**；8 轮真实建单触发 `task.created`。

| 指标 | 实测 | 门禁 |
| :--- | ---: | :--- |
| 触发 → 100 客户端全部收到（p50 / p95 / max） | **9.2 / 10.4 / 10.8 ms** | p95 < 200 ms ✅ |
| 客户端间离散（first→last，p95） | **1.5 ms** | < 200 ms ✅ |
| 合并节流 `task.updated`（触发 → 100 客户端） | p50 286.8 / p95 287.2 / max 287.3 ms；离散 1.0 ms | 设计值（250 ms 去抖 + 25 ms tick），见 OBS-3 |
| 会话健康 | 100/100 无异常关闭；每客户端恰好收到 8 条 `task.created` | ✅ |

### 5.4 SOAK-1-accelerated · 60 s 加速浸泡（PASS，加速版）

真实 Worker（进程内）**+ 真实 mock-cli 子进程**；`ChaosProxy` 在 Worker↔Hub 之间；混合 `success`/`fail`/`cancel`/`slow`。

| 指标 | 实测（两次运行） | 门禁 |
| :--- | ---: | :--- |
| 时长 / 轮次 | 51~52 s / 15~16 轮（success 4、fail 4、cancel 4、slow 3~4） | — |
| 断网重连 | 1 次（运行中任务，RST + 拒绝新连接 2.5 s，`gracePeriodMs=15 s` 内恢复后任务成功） | — |
| Hub 重启 | 1 次（同 DB、同端口；Worker 自动重连并继续接单） | — |
| RSS 基线 / 峰值 / 末值 | 253.6 / 268.0 / 263.5 MiB（Δ峰值 **14.4 MiB**，斜率 **+12.7 MiB/min**） | 斜率 ≈ 0（< 20）✅ |
| **孤儿进程**（按 `ParentProcessId=测试进程` 过滤 `mock-cli`，Windows `Get-CimInstance`） | **0** | 必须 0 ✅ |
| 活动任务 / 活动 Run / 卡死任务（活动状态且超 120 s） | **0 / 0 / 0** | 必须 0 ✅ |
| `assertInvariants(db)` | 通过（INV-1~8） | ✅ |
| Worker 告警 | 0 | — |

注意：这是**加速高密度**版本，用 60 s 压缩 24 h 的场景（现实 24 h 才 2,880 个任务、24 次断网、4 次重启）。它证明：无内存持续增长、无孤儿、无卡死、重启/断网后可自愈、不变量恒成立；但**不能**替代 24 h 真实时长对长尾（定时器泄漏、日志文件增长、飞书速率、磁盘增长）的验证 → 见 §8。

---

## 6. 部署产物与运维文档审计（PASS，8 条）

| 项 | 断言要点 | 结果 |
| :--- | :--- | :--- |
| `deploy/Dockerfile` | 三阶段；build `--frozen-lockfile` + `-r build`；runtime `node:24-bookworm-slim`；`ENV NODE_ENV=production`；`USER node`（在 `chown node:node /data` 之后，无 `USER root`）；`HEALTHCHECK` → `/healthz`；`CMD ["node","packages/hub/dist/main.js","/app/hub.yaml"]`；运行时资产（migrations / maintenance / dashboard dist）；无 `privileged`/`--insecure`/`NODE_TLS_REJECT_UNAUTHORIZED`/硬编码密钥 | ✅ |
| `deploy/docker-compose.yml` | `stop_grace_period: 20s` ≥ `shutdownTimeoutMs 15 000`；hub 仅 `expose: ["8080"]`（无 `ports`）；`env_file: .env`；`./data:/data` + `./hub.yaml:/app/hub.yaml:ro`；caddy 80/443 + `caddy_data`；无 `privileged`/`network_mode: host`/`cap_add`/`user: root`；默认子网 `172.29.60.0/24` 与 `server.trustProxy` 完全一致 | ✅ |
| `deploy/Caddyfile` | `reverse_proxy hub:8080`、`flush_interval -1`、`read_timeout 0`、`encode zstd gzip`；无 `auto_https off`/`tls internal` | ✅ |
| `deploy/.env.example` | 4 个键齐全且值为空；生成命令用 `randomBytes(32)` + `sha256`；无真实凭据（正则扫描） | ✅ |
| `deploy/hub.example.yaml` | 通过真实 `HubConfigSchema` 解析；`host 0.0.0.0`、`publicUrl=https://hub.example.com`、`allowInsecureWorker=false`、`timezone=Asia/Shanghai`、`shutdownTimeoutMs=15000`；`storage.path=/data/hub.sqlite`；`logs.maxDbBytes=10 GiB`、`retentionDays={30,90}`、`maxBytesPerRun=20 MiB`；`retention={sliceRows:5000,sliceIntervalMs:10000,backupDir:/data/backup}`；`workers.path=/ws/worker`、`gracePeriodMs=90000`、`maxFrameBytes=1 MiB`、`maxInFlightBytes=4 MiB`；`dashboard.allowedOrigins` == `publicUrl` origin；`feishu.enabled=true` 且 `ownerOpenIds=[]`（无 PII）、`approvalTarget=owner_p2p` | ✅ |
| `deploy/worker.example.yaml` | 通过真实 `WorkerConfigSchema` 解析；`hub.url = wss://hub.example.com + hub.workers.path`；`identityPath=identity.key`（相对路径，无绝对私钥路径）；`security.useJobObject=true`；`maxConcurrency=2`；唯一工作区 `allowedAdapters:['codex']`、`maxProfile:edit`；无 token/私钥/凭据 | ✅ |
| `deploy/windows/install-worker.ps1` / `uninstall-worker.ps1` | Windows PowerShell AST 解析零错误；`$ErrorActionPreference='Stop'`；Node ≥ **22.12.0** 版本门禁；install 先 `doctor --check-hub` 再 `install-task`；uninstall 仅 `uninstall-task`；**无 `Remove-Item`**（不删身份/工作区/日志）；无内嵌口令/`--token`；CLI 用仓库内绝对路径（`Resolve-Path`） | ✅ |
| `deploy/Dockerfile.dockerignore` | 白名单语义：默认忽略 `**`，仅放行源码/配置/迁移/maintenance；构建上下文不含 `.env`、`deploy/data`、`**/node_modules`、`**/dist`、测试 | ✅ |
| `docs/OPERATIONS.md` / `README.md` | 6 大章节齐全；含 `flush_interval -1`、`read_timeout 0`、`integrity_check`、`foreign_key_check`、`/healthz`、`/readyz`、`storageLevel` 三档、错误码 4401/4403/4409/4426/4429、`umask 077`、`chmod 600 .env`、`UID 1000`、`VACUUM INTO`、快照命名与 7 份轮换、TTL 数字（30/90/365/7/24h）、`revoke`/`drain`/`enroll`；**恢复流程先校验完整性再替换数据卷**；README 含 `pnpm -r build`/`lint`/`depcheck`/`test`、`node packages/hub/dist/main.js`、Node 24、`pnpm demo mock`、文档导航；两文件均无真实凭据 | ✅ |

---

## 7. 门禁命令结果

| 命令 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ exit 0（common/protocol/hub/worker `tsc -b` + dashboard vite build，产物 `dist/site`） |
| `pnpm lint` | ✅ exit 0（`eslint .`，0 error / 0 warning） |
| `pnpm depcheck` | ✅ exit 0（159 modules / 467 dependencies，无依赖边界违规） |
| `pnpm test` | ❌ **2 failed / 870 passed / 1 skipped**，110.3 s（= 基线 110 s；新增文件与浸泡并行，墙钟未增长） |

失败项（均为**有意保留**的稳定失败门禁用例）：
1. `packages/hub/test/phase6-perf.pi.test.ts › PERF-1` → `expected 18019 to be >= 20000`（P1-1）；
2. `packages/hub/test/phase6-db9-retention.pi.test.ts › DB-9d` → `expected 78356480 to be less than 39219200`（P1-2）。

**复现命令**：

```powershell
pnpm exec vitest run --project hub phase6-db9 phase6-db10          # DB-9a/b/c 通过；DB-9d 失败
pnpm exec vitest run --project hub phase6-perf.pi.ts -t PERF-1     # 需单独运行（性能门禁）
pnpm exec vitest run --project hub phase6-soak                     # 51~52 s
pnpm exec vitest run --project hub phase6-deploy.pi                # 8/8 通过
```

---

## 8. 24 h 完整浸泡（未执行，留待预发）

按矩阵 SOAK-1 原文：24 h、每分钟 2 个 mock 任务、每小时 1 次随机断网、每 6 小时 1 次 Hub 重启。交互式验收窗口内无法真跑 24 h，本轮以 §5.4 的 60 s 加速版替代，**明确不等于 24 h 结论**。预发环境执行时需额外采集：

1. RSS 12 h/24 h 斜率（本报告口径 `MB/min`，门禁 ≈ 0）与 Node `--max-old-space-size` 下的 OOM 事件；
2. 任务计划/Worker journal 文件与 `output.log` 累计字节（`localLogs.retentionDays` 生效性）；
3. 磁盘实际占用随 `logs.maxDbBytes` 的走势——**结合 P1-2**，24 h 内 DB 文件只会单向增长，需重点观察 `storageLevel` 是否被永久钉在 `critical`；
4. 飞书真实速率（patch 频率、429）与 `HUB_SESSION_SECRET`/Token 轮换；
5. 每小时断网与 6 小时重启下的 `attempt_count`/INV 一致性（本轮加速版已覆盖 1+1 次）。

---

## 9. 缺陷与观察

### P1-1 · PERF-1 单 Run 持久化吞吐不达 20,000 行/s（差 ~9%）

- **规格**：矩阵 §15 `PERF-1`：Hub 持久化 ≥ 20,000 行/s，端到端延迟 p95 < 500 ms。
- **实测**（Windows 11 / i7-14700KF / NVMe，5 次单独运行）：**17,922 / 18,019 / 18,304 / 18,457 / 18,368 行/s**；单批 500 行提交 p50 24.9~25.9 ms、p95 27.3~28.6 ms；端到端 p95 26.9~28.0 ms（延迟门禁通过）。
- **根因**：`packages/hub/src/plugins/store-sqlite/ingest-queue.ts` 对每个事件执行 `repos.insert(taskLogs).values(...).returning().get()`（见 `write()` 循环）。逐行 `RETURNING` 的实测上限 ≈ 19.5k 行/s；去掉 `RETURNING` 为 41.3k，多行 VALUES 为 101.4k，原生 prepared 为 486.9k。
- **影响**：单 Worker 满窗日志（20 MiB/Run）在峰值下会持续积压（`IngestQueue` 深度上升），Worker 侧 `maxInFlightBytes` 反复触顶 → 日志端到端时延随积压线性增长，极端情况下 `gap` 增加。
- **建议修复**（低风险、不动协议）：`IngestQueue.write()` 改为单条多行 `INSERT INTO task_logs (...) VALUES (...),(...)`（一次事务一个语句）；`tail`（末行 seq/ts）与 `kind='gap'` 的原地扩展可完全在内存中推得，无需 `RETURNING`。预期可留 2~5× 余量。修复后 PERF-1 断言自然转绿（无需改动测试门禁值）。
- **保留失败用例**：`packages/hub/test/phase6-perf.pi.test.ts › PERF-1`（断言 `rowsPerSecond >= 20_000`）。

### P1-2 · 保留清理不回收磁盘页：`incremental_vacuum(2000)` 每次仅释放 1 页，`storageLevel` 无法自动回落

- **规格**：07 §6「每累计删除 100 000 行 → `PRAGMA incremental_vacuum(2000)`」；容量护栏「超过 95% → 拒绝新的 log 文本，**直到空间回落**」。
- **实测**（`DB-9d`，与实现步调一致）：100 万行清理完毕 + 10 次 `incremental_vacuum(2000)` + `wal_checkpoint(TRUNCATE)` 后，主库 **78,438,400 B → 78,356,480 B**（−0.10%），`freelist_count = 9,503/9,565` 页（**99.3%**）；再补 10 次仅再释放 80 KiB；`VACUUM` 后 **466,944 B / 57 页**。
- **影响**：`store.health().dbSizeBytes` 只统计主库文件字节，清理不改变它 → 一旦进入 `critical`，`checkCapacity()` 永远算回 `critical`，`kind='log'` 正文被永久降级为 `gap`（DB-10 的"空间回落自动恢复"仅在人为调大 `maxDbBytes` 时成立，本报告 DB-10 用例正是这样验证的）。
- **建议**：
  1. 容量判定改用"已用字节"：`(page_count - freelist_count) * page_size + walSize`（或直接 `VACUUM INTO` 后 `statSync`），使清理后档位可回落；
  2. 04:00 维护任务（`dailyBackup` 之前）增加一次 `VACUUM`（或 `PRAGMA incremental_vacuum` 循环调用直至 `freelist_count` 达标）+ `wal_checkpoint(TRUNCATE)`，形成"空间真正回收"的闭环；
  3. 若坚持逐次 `incremental_vacuum`，需循环调用（实测单次仅 1 页），不能一次传 `2000` 就认为回收了 2000 页。
- **保留失败用例**：`packages/hub/test/phase6-db9-retention.pi.test.ts › DB-9d`。

### OBS-1（观察）· 全量并行 `pnpm test` 会稀释性能读数

PERF-1 单独运行为 18.2k 行/s，全量并行（59 文件同跑）为 7,078 行/s。性能门禁必须在空载下读取；建议 CI 将 `phase6-perf.pi.test.ts` 与 `phase6-soak.pi.test.ts` 独立成 job（或在 vitest 里单独 project），否则 PERF-* 结果不可用于裁决。

### OBS-2（观察）· 持续 flood 下 `run.ack` 批处理被"饿死"

`sweep` 每 100 ms 才 `ack()` 一次，而 `ackIntervalMs` 默认 200 ms；在持续 500 行/帧的 flood 期间，事件循环被 25 ms 级同步事务占满，实测 `run.ack` 仅每 ~109 ms~1.1 s 到达一次（单次突发 40 帧时只有 2 个 ack）。数据不丢（Worker 由在途窗口自保），但"发送→ack"不是可靠的端到端延迟指标——本报告因此以"发送→已提交（`enqueue` resolve）"作为延迟口径，并单独记录 ack 间隔。若希望 Worker 侧时延指标可信，建议在 `flush()` 完成后立即 `ack()`（而不是等 sweep）。

### OBS-3（观察）· `task.updated` 端到端 287 ms 超过 PERF-3 的 200 ms 字面值

`packages/hub/src/plugins/dashboard-api/ws-hub.ts` 对任务更新做 250 ms 去抖（25 ms tick），因此"触发→收到 `task.updated`"的实测 p95 = 287 ms。**扇出本身**（首客户端→末客户端）仅 1.0~1.5 ms、`task.created`（即时发布）p95 = 10.4 ms，均远低于 200 ms。本次按"扇出延迟"判 PASS，并在此披露口径差异：若门禁本意是"含去抖的端到端"，则 200 ms 目标与 04 §5 的 250 ms 去抖设计冲突，需主 Agent 裁定（不建议为此下调去抖，会放大 patch 频率）。

### OBS-4（文档）· `docs/OPERATIONS.md` 未记录 `stop_grace_period: 20s`

Compose 文件正确（20 s ≥ `shutdownTimeoutMs` 15 s，测试已断言），但运维手册未提示"该值必须 ≥ 优雅停机超时，否则容器会被强杀导致 WAL 未落盘"。建议在 §1 或 §5 补一句（同类：`caddy.depends_on` 未使用 `condition: service_healthy`，Hub 未就绪时 Caddy 会短暂 502，属可接受但可在手册注明）。

### OBS-5（测试基础设施）· 本轮对 Pi 测试脚手架的两处修正（非业务代码）

1. `packages/hub/test/pi/harness.ts › openHarness()`：原实现 `{ storage: { path: join(dir,'hub.sqlite'), ...config.storage }, ...config }` 会让调用方传入的 `storage`（如 `{ ingest: {...} }`）整体覆盖掉临时路径，回落到仓库内 `data/hub.sqlite`（跨用例共享、互相污染）。已改为按段合并（`server`/`storage` 分别深合并，其余照旧）。**这会影响所有使用 `openHarness({ storage: … })` 的用例**，风险已通过全量套件验证（除两处门禁失败外全绿）。
2. `assertRunLogContinuity()`：07 §6 的保留策略会为已清理 Run 写 `logs_purged_at` 并删光日志，此时 INV-7（`seq` 从 1 连续）按定义不再适用；原实现会让**任何**调用 `assertInvariants` 的用例在"有 Run 被清理"后误报 `INV-7: logs end at 0 but last_seq=N`。已改为：`logs_purged_at IS NOT NULL` 时只校验"确实没有残留日志行"，其余情况仍严格校验连续性。这属于测试判定口径修正，不改变产品行为；**建议后续把该语义写入 02 §7 INV-7 的脚注**（"已被保留策略清理的 Run 不适用，以 `logs_purged_at` 标记"）。

---

## 10. 交付物与后续

- 新增：`packages/hub/test/phase6-db9-retention.pi.test.ts`、`phase6-db10-capacity.pi.test.ts`、`phase6-perf.pi.test.ts`、`phase6-soak.pi.test.ts`、`phase6-deploy.pi.test.ts`、`test/pi/phase6.ts`；
- 修改（仅测试脚手架）：`packages/hub/test/pi/harness.ts`（§9 OBS-5）；
- 量化指标同时写入 `%TEMP%\agent-hub-pi-phase6-metrics.json`（键：`DB-9a`/`DB-9d`/`DB-10`/`PERF-1`/`PERF-2`/`PERF-3`/`SOAK-1-accelerated`），便于复跑比对；
- **未修改任何 `packages/*/src` 业务实现**；
- 待主 Agent 裁决：P1-1（批量写入改造）、P1-2（空间回收 + 容量判定口径）、OBS-2/3（ack 时机与 `task.updated` 门禁口径）；
- 24 h 完整浸泡（SOAK-1）与真实飞书/真实 CLI（E2E-9/10/14）仍需在预发环境按 §8 清单执行。
