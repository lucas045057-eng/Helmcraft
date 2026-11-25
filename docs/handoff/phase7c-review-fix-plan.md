# Phase 7c · 对抗性审查修复（增量开发计划）

> 来源：Phase 7 对抗性审查（Codex，2026-11-24）。主 Agent 已逐条对照源码复核并给出判决。
> 规格依据：`docs/specs/08-blackboard-harness.md`、`02-task-state-machine.md`、`03-protocol-hub-worker.md`、`05-feishu-integration.md`。
> 原则：只做下列增量修复，不扩展新功能；不改 TaskStatus 迁移矩阵；协议改动必须向后兼容（`Base` 是 `z.strictObject`，新增字段需能力协商）。

## 判决汇总

| # | 审查发现 | 复核结论 | 最终级别 | 批次 |
|---|---|---|---|---|
| F1 | 自动修复轮撤销改动后 `NO_CHANGES` 跳过检查，仍可被自动采纳 | 确认（`run-manager.ts` 的 `NO_CHANGES` 分支不看 round；`policy.ts` 对 `NO_CHANGES` 放行） | **P0** | A |
| F2 | 交接任务重试/审批时 overrides 可改写 Worker/工作区/adapter | 确认（`validateOverrides` 未考虑 `task.handoff`；`task.overrides` 原样写入） | **P1** | A |
| F3 | 截断的 Pre 快照可生成"清空文件"的恢复任务 | 确认（`board-reader.ts` 首行超长时 content 为空串；`BoardPanel` 只判 `!== undefined`） | **P1** | A |
| F4 | CLI `exit` 后写锁等 `close`，后代持管道时长期不释放 | 确认（进程树清理挂在 `close` 回调里） | **P1** | A |
| F5 | Hub 第二次脱敏按键名跳过 `board` 整个对象 | 确认（`ingest-queue.ts` 跳过列表含 `board`，同名键也承载快照对象） | **P1** | A |
| F6 | 小传输窗口把 `verify`/`finished` 替换为 `run.gap` | 确认，但仅在非默认配置（≥1 KiB 合法）下触发 | P2 | B |
| F7 | 飞书负责人审核卡不显示门控原因 | 确认（`renderOwnerReviewCard` 只渲染摘要与两个按钮） | P2 | B |
| F8 | 跨 CLI 接力继承源模型 | 确认（`handoff()` 无条件传 `task.model`）；需同步改规格 | P2 | B |
| F9 | 被降级为 readonly 的 Run 仍占写入序号 / `lastAttempt` | 采信（受理时按请求 profile 登记，`started` 回写实际 profile 未回滚） | P2 | B |
| F10 | 工作区位于 Worker 状态目录内时未判 `configExposed` | 确认（只检查 `withinWorkspace(root, p)` 单向） | P2 | B |
| F11 | 面板手动采纳按钮依赖 `run.harness` 存在 | 确认（`WorkspacePointer` 用 `run.harness?.workspaceSeq`，Drawer 仅在 `run.harness` 时拉资格） | P3 | C |
| F12 | `.acquire` 残留阻断 Worker 启动 | 确认但窗口极小（仅进程在 open 与 finally 之间被硬杀） | P3 | C |

## 批次 A（阻断验收，必须完成）

### F1 修复轮不得跳过检查
- `packages/worker/src/runner/run-manager.ts`：`NO_CHANGES` / `boardOnly` 快捷路径仅在 `round === 0` 且此前无失败检查时生效。进入修复轮（`round > 0`）后，最终工作区必须重新执行上一轮失败的检查（或全部 required 检查），结果为 `passed` 才可被采纳。
- `packages/protocol/src/harness/policy.ts`：`autoAcceptDecision` 增加约束——若本 Run 的 verification attempts 中存在失败且最终结论不是 `passed`，一律不自动采纳（防御纵深，不能只靠 Worker）。
- 测试：首轮新增文件→检查失败→修复轮撤销→断言执行了第二次检查、结论非 `skipped/NO_CHANGES`、`lastAccepted` 未推进。

### F2 交接任务绑定不可被覆写
- `packages/hub/src/plugins/orchestrator/index.ts`：`validateOverrides` 对 `task.handoff` 存在的任务拒绝 `workspaceId`、`requiredWorkerId`（如可覆写）与源不同的值，返回 `VALIDATION_FAILED` + `reason: 'HANDOFF_BINDING'`；审批、重试、派发三个入口共用该校验。
- 若允许覆写 `adapter`：adapter 与源 Run 不同 → 清除 resume 会话 ID（不携带 `resumeSessionId`），按跨 CLI 交接处理。
- 测试：接力任务失败后带不同 workspace 重试被拒；带不同 adapter 重试时派单不含旧会话 ID。

### F3 截断快照不得生成整文件恢复
- 快照增加/复用 `truncated` 标志；`BoardPanel.tsx` 的"复制恢复指令""创建恢复任务"仅在 Pre 快照 `status === 'present' && !truncated` 时可用；截断快照显示"仅保存前 N 字节"，只保留"复制 Pre 内容"。
- Hub 侧若有恢复任务创建接口，同样拒绝截断快照（不能只靠前端）。
- 测试：首行 >16 KiB 的文件 → 按钮禁用；接口拒绝。

### F4 CLI 退出即开始收尾
- `run-manager.ts`：在 `exit` 事件启动进程树终止，并为 stdout/stderr 管道排空设置上限（如 5 s，可配置）；超时后强制销毁流、继续 `finish`，并发 `log(system)` 说明。
- 测试：mock CLI 退出前派生一个持有管道的后代进程 → 断言 Run 在期限内结束，后续同工作区写任务获得写锁。

### F5 快照正文走 Hub 脱敏
- `packages/hub/src/plugins/store-sqlite/ingest-queue.ts`：跳过列表只对**标量字符串**生效（`typeof item === 'string'`）；对象/数组值即使键名在列表中也递归脱敏。核对 `orchestrator/harness.ts` 快照落库路径也使用脱敏后的事件。
- 测试：仅在 Hub `redactionPatterns` 配置的测试标记出现在 `.board` 文件中 → 数据库与 `GET` 详情接口都看不到原文。

## 批次 B（同轮完成）

- **F6**：Hub `workers.maxInFlightBytes` 与 `maxFrameBytes` 最小值提到 64 KiB（同步 Worker 侧协商下限）；`outbox` 对 `finished` 与 `verify` 永不替换为 `run.gap`——超预算时先用 `fitEvent` 裁剪可选字段（summary、tail、明细），保留必需字段。测试断言 Hub 持久化了 `finished` 与 verification 结论。
- **F7**：`renderOwnerReviewCard` 增加门控区：verification 状态、失败检查名、TAMPER/READONLY 警告，以及"派修复任务"按钮（复用现有 handoff `intent: 'fix'` 动作）。测试检查 Requester 任务提交后负责人收到的卡片 JSON。
- **F8**：`handoff()` 仅在目标 adapter 与源相同时继承 `model`；跨 CLI 用目标默认或请求显式给出的 `model`（HandoffInput 增加可选 `model`）。同步修改 `docs/specs/08-blackboard-harness.md` 相关条款。
- **F9**：`started` 事件回写的 `effectiveProfile` 为 `readonly` 时，回滚该 Run 的写入序号登记，`lastAttempt` 指针不指向它（或在受理阶段就按 clamp 后 profile 登记，二选一，选改动小者并写明）。
- **F10**：`config/load.ts` 双向检查：`withinWorkspace(root, p) || withinWorkspace(p, root)` 均判 `configExposed`；覆盖 journal/状态目录实际路径。

## 批次 C（顺手修）

- **F11**：`MissionDrawer` 独立请求服务端 `canAccept`（不依赖 `run.harness`），`WorkspacePointer` 用指针/Run 自身的 seq 判断。
- **F12**：`lock.ts` 中 `.acquire` 文件写入 pid+启动时间；遇到 `EEXIST` 时若持有者进程已不存在（或文件超过 30 s），删除后重试一次。

## 验收

1. `pnpm build && pnpm lint && pnpm depcheck && pnpm test` 全绿（含既有全部测试）。
2. 每个 F 项至少一个回归测试，测试文件命名 `phase7c-*.test.ts`，在测试名中标注 F 编号。
3. 不修改 TaskStatus 迁移矩阵；协议新增字段必须走能力协商或为现有可选字段。
4. 产出 `docs/handoff/phase7c-fix-report.md`：每个 F 项的改动文件、测试名、未完成项与理由。
