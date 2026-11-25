# Phase 7c 修复报告

按 A → B → C 完成 F1–F12。保留既有 TaskStatus 迁移矩阵和 Hub/Worker 严格事件结构。新增 5 个测试文件、14 个回归用例。

## 修复与回归

| 项目 | 批次 / 级别 | 实现 | 改动文件 | 回归测试文件与测试名 |
|---|---|---|---|---|
| F1 | A / P0 | 初始轮无变更才跳过检查。修复轮重新执行配置的检查。Hub 根据已落库的失败尝试和最终结论独立决定是否采纳。 | [packages/worker/src/runner/run-manager.ts](../../packages/worker/src/runner/run-manager.ts)<br>[packages/protocol/src/harness/policy.ts](../../packages/protocol/src/harness/policy.ts)<br>[packages/hub/src/plugins/orchestrator/harness.ts](../../packages/hub/src/plugins/orchestrator/harness.ts)<br>[packages/hub/src/plugins/orchestrator/pointers.ts](../../packages/hub/src/plugins/orchestrator/pointers.ts)<br>[packages/hub/src/plugins/orchestrator/index.ts](../../packages/hub/src/plugins/orchestrator/index.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F1 keeps lastAccepted when a failed attempt is followed by a skipped conclusion`<br>[packages/worker/test/phase7c-runtime.test.ts](../../packages/worker/test/phase7c-runtime.test.ts)<br>`F1 reruns required checks after a repair restores the original workspace` |
| F2 | A / P1 | 审批、重试和派发均校验源 Run 的 Worker 与工作区。跨 adapter 重试清除旧会话，派单以交接模式注入上下文。 | [packages/hub/src/plugins/orchestrator/index.ts](../../packages/hub/src/plugins/orchestrator/index.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F2 binds retry overrides to the handoff source and drops resume on adapter change` |
| F3 | A / P1 | 仅完整、有正文的 present Pre 快照可生成恢复指令和任务。截断时显示实际保存的 UTF-8 字节数，仍可复制前缀。Worker 同样标记脱敏扩张造成的截断。 | [packages/worker/src/harness/board-reader.ts](../../packages/worker/src/harness/board-reader.ts)<br>[packages/dashboard/src/harness/BoardPanel.tsx](../../packages/dashboard/src/harness/BoardPanel.tsx) | [packages/dashboard/test/phase7c-board.test.ts](../../packages/dashboard/test/phase7c-board.test.ts)<br>`F3 disables whole-file restore for a truncated first line` |
| F4 | A / P1 | CLI exit 立即启动进程树收尾。管道超过 shutdown.pipeDrainTimeoutMs 时写入 system 日志、销毁流，并且只结算一次。排空期间的取消仍可中止后续验证。 | [packages/worker/src/runner/run-manager.ts](../../packages/worker/src/runner/run-manager.ts)<br>[packages/worker/src/config/schema.ts](../../packages/worker/src/config/schema.ts) | [packages/worker/test/phase7c-runtime.test.ts](../../packages/worker/test/phase7c-runtime.test.ts)<br>`F4 releases the writer after CLI exit while a descendant holds its pipes`<br>[packages/worker/test/phase7c-runtime.test.ts](../../packages/worker/test/phase7c-runtime.test.ts)<br>`F4 honors cancellation during pipe drain and logs the deadline once` |
| F5 | A / P1 | Hub 仅对指定键的标量字符串跳过脱敏，快照对象递归脱敏。替换文本扩张超过 16 KiB 时按完整行截断并打标。快照落库回调消费脱敏事件，详情接口经实际 GET 验证。 | [packages/hub/src/plugins/store-sqlite/ingest-queue.ts](../../packages/hub/src/plugins/store-sqlite/ingest-queue.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F5 scrubs snapshot text with Hub patterns before SQLite and REST` |
| F6 | B / P2 | 新 Hub 的帧和在途字节窗口均至少为 64 KiB。Worker 在真实协商预算内缩减验证尾部、结果明细和结束摘要，保留事件与验证结论。 | [packages/hub/src/config/schema.ts](../../packages/hub/src/config/schema.ts)<br>[packages/protocol/src/worker/handshake.ts](../../packages/protocol/src/worker/handshake.ts)<br>[packages/worker/src/tunnel/connection.ts](../../packages/worker/src/tunnel/connection.ts)<br>[packages/worker/src/tunnel/outbox.ts](../../packages/worker/src/tunnel/outbox.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F6 enforces the 64 KiB floor and persists bounded verify and finished events` |
| F7 | B / P2 | 负责人私聊审核卡显示实际送审原因、验证状态、失败检查名和工作区警告。按钮复用现有 fix 回调，回归测试从审核卡点击并验证了子任务。 | [packages/hub/src/plugins/channel-feishu/cards/index.ts](../../packages/hub/src/plugins/channel-feishu/cards/index.ts)<br>[packages/hub/src/plugins/channel-feishu/delivery.ts](../../packages/hub/src/plugins/channel-feishu/delivery.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F7 shows gate reasons and dispatches fix from the private owner review card` |
| F8 | B / P2 | 交接请求允许显式 model。自动选择 adapter 时，在派发事务内按实际 CLI 决定是否继承。内部请求 JSON 记录显式选择，换 CLI 重试清除上一 CLI 的模型。同步更新规格字段表与 REST 定义。 | [packages/protocol/src/dashboard/harness.ts](../../packages/protocol/src/dashboard/harness.ts)<br>[packages/hub/src/plugins/orchestrator/index.ts](../../packages/hub/src/plugins/orchestrator/index.ts)<br>[packages/hub/src/plugins/store-sqlite/schema.ts](../../packages/hub/src/plugins/store-sqlite/schema.ts)<br>[docs/specs/08-blackboard-harness.md](../../docs/specs/08-blackboard-harness.md) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F8 inherits a model only on the source adapter and honors explicit handoff models` |
| F9 | B / P2 | started 先于 ACK 时直接按实际 profile 登记。若 ACK 已分配写入序号，则在同一事务中恢复计数器、前一写入指针及当前 Run 的只读基线。 | [packages/hub/src/plugins/orchestrator/index.ts](../../packages/hub/src/plugins/orchestrator/index.ts)<br>[packages/hub/src/plugins/orchestrator/pointers.ts](../../packages/hub/src/plugins/orchestrator/pointers.ts) | [packages/hub/test/phase7c-hub.test.ts](../../packages/hub/test/phase7c-hub.test.ts)<br>`F9 rolls back readonly clamps and preserves the preceding write pointer` |
| F10 | B / P2 | 工作区和受保护路径按两个包含方向判断。覆盖状态根、state 子目录、journal、密钥、配置与日志的逻辑路径和实际路径。 | [packages/worker/src/config/load.ts](../../packages/worker/src/config/load.ts) | [packages/worker/test/phase7c-config.test.ts](../../packages/worker/test/phase7c-config.test.ts)<br>`F10 marks a workspace nested in Worker state as configExposed` |
| F11 | C / P3 | 成功且可写的 Run 独立查询服务端资格。面板结合服务端 canAccept、Run 或指针上的序号及实时 lastAccepted 显示按钮。浏览器回归完成一次手动采纳。 | [packages/dashboard/src/MissionDrawer.tsx](../../packages/dashboard/src/MissionDrawer.tsx)<br>[packages/dashboard/src/harness/WorkspacePointer.tsx](../../packages/dashboard/src/harness/WorkspacePointer.tsx) | [packages/hub/test/phase7c-dashboard.test.ts](../../packages/hub/test/phase7c-dashboard.test.ts)<br>`F11 accepts a successful write without a harness summary through the drawer` |
| F12 | C / P3 | 获取守卫记录 PID 与系统提供的进程启动标识。确认原进程消失或 PID 已复用时立即恢复，身份不完整时以 30 秒判定陈旧。清理竞争者串行复核后独占重试一次。 | [packages/worker/src/runner/lock.ts](../../packages/worker/src/runner/lock.ts) | [packages/worker/test/phase7c-config.test.ts](../../packages/worker/test/phase7c-config.test.ts)<br>`F12 recovers abandoned acquisition guards and respects a fresh guard` |

## 实施选择与适用边界

- F3 的恢复入口在 Dashboard。面板以快照生成 prompt，再打开通用交接表单。Hub 现有 REST 接口接收自由文本，没有按文件或快照创建恢复任务的专用接口。
- F4 使用 5 秒默认排空期限，配置项为 `shutdown.pipeDrainTimeoutMs`。测试分别覆盖真实后代持有输出管道，以及延迟 close 通知时的超时、取消和单次收尾。
- F6 的共享窗口下限是 64 KiB。为保持兼容，旧 Hub 宣告更小窗口时，Worker 提示并继续使用旧 Hub 的实际限制。回归在 1 KiB 窗口发送验证和终态事件，并读取 Hub 已持久化的结论。
- F8 的可选模型字段只用于 Dashboard REST 交接请求。内部模型来源保存在已有 JSON 列中，无数据库迁移。
- F9 采用计划允许的回滚方案。调度器在 Worker 回报实际 profile 前已为该 Run 保留工作区写槽，因此回滚只涉及最新的临时写入登记。
- F12 对身份完整、经核实仍存活的持有者保留守卫。30 秒回收用于空文件、部分写入或无法核实启动标识的文件，以避免移除仍在临界区内的 Worker 的守卫。

## 验证结果

| 命令 | 结果 |
|---|---|
| `pnpm build` | 通过，退出码 0。TypeScript 项目和 Dashboard 生产包均构建成功。Vite 输出依赖指令与注解提示。 |
| `pnpm lint` | 通过，退出码 0。 |
| `pnpm depcheck` | 通过，退出码 0。检查 184 个模块、573 条依赖，违规数为 0。 |
| `pnpm exec vitest run phase7c --maxWorkers=2` | 通过，5 个文件、14 个用例全部通过。 |
| `pnpm test` | 通过，退出码 0。95 个文件全部通过，1338 个用例通过、0 个失败、1 个按平台跳过，共 1339 个用例，耗时 377.99 秒。 |

首轮全量运行发现 1 个 F12 回归失败：缺少启动标识且超龄的旧守卫仍被判定为持锁。修正后重新执行全量测试，结果见上表。Windows 上跳过的既有用例是仅限 POSIX 的进程组终止测试。

未完成项为 0。

全量测试沿用仓库既有验收配置，在当前 PowerShell 进程中设置 `VITEST_MAX_WORKERS=2`。
