# 02 · 任务状态机与并发调度规格

> 本文是 `packages/protocol/src/task.ts`（状态与迁移表）和 `packages/hub/src/plugins/orchestrator/`（状态机执行 + 调度器）的唯一规格来源。
> 关键词约定：**必须 / MUST**、**禁止 / MUST NOT**、**应当 / SHOULD**。
> **Phase 7 说明**：Blackboard & Harness（[08](08-blackboard-harness.md)）**不修改**本文的迁移矩阵与任何状态/事件枚举；验证结论是 `TaskRun` 的正交属性（08 §8.4），Run 在验证与自动修复期间保持 `running`，因此 INV-4 的写锁自然覆盖这些阶段；新增不变量 INV-9~15 见 08 §13；调度器对交接任务追加能力过滤（08 §8.7）。

---

## 1. 领域模型与关系

```text
Task (一个需求)  1 ──── N  TaskRun (一次执行尝试 attempt)  1 ──── N  TaskLog (按 seq 有序的运行事件)
  │                              │
  │ parent_task_id / root_task_id│ worker_id ──► Worker
  ▼                              ▼
Task (追问/续跑生成的子任务)      cli_session_id（本机 CLI 会话，可被子任务 resume）
```

| 实体 | 说明 | 生命周期 |
| :--- | :--- | :--- |
| `Task` | 用户提交的一个需求。保存 prompt、来源、发起人、执行约束（adapter/workspace/profile/affinity）及**当前状态**。 | 创建 → 终态。终态的 Task 不会“复活”，只有 `RETRY` 允许从可重试终态回到 `queued`。 |
| `TaskRun` | Task 的一次执行尝试，`attempt` 从 1 递增。绑定一个 Worker、一个 adapter、一个工作区。 | 每次 `DISPATCH` 新建一条；Run 自身只前进不回退。 |
| `TaskLog` | Run 的有序事件流（stdout/stderr/结构化 agent 事件/状态事件），主键语义为 `(run_id, seq)`。 | 随 Run 追加；按保留策略清理（见 07）。 |
| 子 Task（Follow-up） | 飞书引用回复/面板“继续对话”产生的新 Task，`parent_task_id` 指向原任务，继承 `cli_session_id`、`adapter`、`workspace_id`，并**硬亲和**原 Worker（CLI 会话只存在于那台机器）。 | 独立状态机。 |

**设计决策（D-SM-1）**：多轮对话不复用同一 Task，而是生成子 Task。理由：终态保持不可变便于审计与统计；每轮均可独立审批（外部接收方的追问同样受审批策略约束）。

**设计决策（D-SM-2）**：`awaiting_input` 仅用于具备 `liveInput` 能力的 Adapter（v1 只有 `mock`；Claude Code 权限桥接列入 backlog）。主流 CLI 的无头模式（`claude -p`、`codex exec`、`gemini -p`、`opencode run`）不支持运行中注入输入，“澄清式交互”统一走 **Follow-up 子任务 + `--resume`**。

---

## 2. 状态定义

### 2.1 Task 状态（`TaskStatus`）

| 状态 | 分类 | 含义 | 占用 Worker 槽位 |
| :--- | :--- | :--- | :---: |
| `awaiting_approval` | 活动 | 命中审批策略，等待 Owner 决策 | 否 |
| `queued` | 活动 | 已放行，等待调度 | 否 |
| `dispatching` | 活动 | 已选定 Worker 并发出 `run.dispatch`，等待 `cmd.ack` | **是（预留）** |
| `running` | 活动 | Worker 已受理，CLI 进程运行中 | 是 |
| `awaiting_input` | 活动 | Live 模式下 CLI 请求人工输入，进程挂起等待 | 是 |
| `cancelling` | 活动 | 已请求取消，等待 Worker 确认进程树已终止 | 是 |
| `succeeded` | 终态（最终） | 成功完成 | — |
| `rejected` | 终态（最终） | 被 Owner 驳回或被策略直接拒绝 | — |
| `failed` | 终态（可重试） | 执行失败 / Worker 丢失 / 启动失败 | — |
| `timed_out` | 终态（可重试） | 超过运行时限或空闲时限 | — |
| `cancelled` | 终态（可重试） | 被取消（含审批超时） | — |

### 2.2 TaskRun 状态（`RunStatus`）

| 状态 | 含义 |
| :--- | :--- |
| `dispatching` | 指令已下发，未收到 ack |
| `running` | 已受理（`cmd.ack ok=true` 或收到该 Run 的任意 `run.events`） |
| `awaiting_input` | Live 输入等待 |
| `cancelling` | 已发出 `run.cancel` |
| `succeeded` / `failed` / `timed_out` / `cancelled` | Worker 上报的 `finished.status` |
| `refused` | Worker 拒单（`cmd.ack ok=false`），**不计入** `attempt_count` 的失败次数 |
| `lost` | Worker 离线超过 `gracePeriodMs` 或重连后未上报该 Run |

### 2.3 展示映射（看板泳道）

| 泳道 | 包含的 TaskStatus |
| :--- | :--- |
| 待审批 | `awaiting_approval` |
| 排队中 | `queued`, `dispatching` |
| 执行中 | `running`, `cancelling` |
| 待补充输入 | `awaiting_input` |
| 已完成 | `succeeded` |
| 异常/终止 | `failed`, `timed_out`, `cancelled`, `rejected` |

---

## 3. 事件与合法迁移

### 3.1 事件清单（`TaskEventType`）

| 事件 | 触发方 | 说明 |
| :--- | :--- | :--- |
| `SUBMIT` | 飞书 / 面板 / API | 创建任务，由策略引擎给出 `decision ∈ {auto_approve, require_approval, deny}` |
| `APPROVE` | Owner | 可携带 overrides（adapter/workspace/profile/prompt/requiredWorkerId） |
| `REJECT` | Owner | 携带 reason |
| `APPROVAL_EXPIRE` | 系统定时器 | `approvalTimeoutMs` 到期 |
| `DISPATCH` | 调度器 | 选中 Worker，**同一事务内**创建 Run(`dispatching`) |
| `RUN_ACCEPTED` | Worker 网关 | `cmd.ack ok=true`，或首次收到该 Run 的事件（隐式受理） |
| `RUN_REFUSED` | Worker 网关 | `cmd.ack ok=false` |
| `DISPATCH_LOST` | 系统 | `dispatching` 状态下 Worker 离线超过宽限期，或 `maxDispatchResends` 次重发仍无 ack |
| `INPUT_REQUEST` | Worker | Run 事件 `input_request` |
| `INPUT_PROVIDE` | Owner / 发起人 | 回复输入 |
| `INPUT_EXPIRE` | 系统定时器 | `inputTimeoutMs` 到期 |
| `CANCEL` | Owner / 发起人（受权限约束） | 取消 |
| `RUN_SUCCEEDED` / `RUN_FAILED` / `RUN_TIMED_OUT` / `RUN_CANCELLED` | Worker | Run 事件 `finished.status` |
| `RUN_LOST` | 系统 | 运行中 Worker 离线超过 `gracePeriodMs`，或重连 hello 未上报该 Run |
| `RETRY` | Owner（发起人仅当策略允许） | 从可重试终态重新入队 |

### 3.2 迁移矩阵

单元格为目标状态；`—` 表示非法迁移（API 返回 `409 INVALID_TRANSITION`，飞书返回 Toast“当前状态不可执行该操作”）；`=` 表示幂等无操作（返回 200 + 当前视图，不写审计“状态变化”，但写一条 `noop` 审计）。

| from \ event | SUBMIT | APPROVE | REJECT | APPROVAL_EXPIRE | DISPATCH | RUN_ACCEPTED | RUN_REFUSED | DISPATCH_LOST | INPUT_REQUEST | INPUT_PROVIDE | INPUT_EXPIRE | CANCEL | RUN_SUCCEEDED | RUN_FAILED | RUN_TIMED_OUT | RUN_CANCELLED | RUN_LOST | RETRY |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| ∅（不存在） | **A** | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| awaiting_approval | — | queued | rejected | cancelled | — | — | — | — | — | — | — | cancelled | — | — | — | — | — | — |
| queued | — | — | — | — | dispatching | — | — | — | — | — | — | cancelled | — | — | — | — | — | — |
| dispatching | — | — | — | — | — | running | queued | **B** | **C** | — | — | cancelling | **C** | **C** | **C** | **C** | — | — |
| running | — | — | — | — | — | = | — | — | awaiting_input | — | — | cancelling | succeeded | failed | timed_out | cancelled | **D** | — |
| awaiting_input | — | — | — | — | — | = | — | — | = | running | cancelling | cancelling | succeeded | failed | timed_out | cancelled | **D** | — |
| cancelling | — | — | — | — | — | = | **E** | **E** | = | — | = | = | succeeded | cancelled | cancelled | cancelled | cancelled | — |
| succeeded | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| rejected | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| failed | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | **F** |
| timed_out | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | **F** |
| cancelled | — | — | — | — | — | — | — | — | — | — | — | = | — | — | — | — | — | **F** |

注释：

- **A**：`decision=auto_approve → queued`；`require_approval → awaiting_approval`；`deny → rejected`（`error_code=POLICY_DENIED`）。
- **B**：`attempt_count < max_attempts → queued`（Run 记 `lost`，计入尝试次数，因为无法确认是否已执行）；否则 `→ failed (WORKER_LOST)`。
- **C**：ack 丢失但该 Run 的事件先到（`input_request` 或 `finished`）——先隐式应用 `RUN_ACCEPTED`，再应用该事件（两步在同一事务内，version 依次各 +1，审计中记录 `implicitAccept=true`）。
- **D**：若策略 `autoRetryOnWorkerLost=true` 且 `profile=readonly` 且 `attempt_count < max_attempts → queued`；否则 `→ failed (WORKER_LOST)`。写入型任务默认**不自动重试**（可能已产生副作用）。
- **E**：`cancelling` 时 Worker 拒单或派发丢失 → `cancelled`（进程从未启动或已不可达；Run 状态可由 `cancelling` 改写为更精确的终态 `refused`/`lost`）。
- **F**：`attempt_count < max_attempts` 或 actor 为 Owner（Owner 可超出上限并在审计中标注 `override=true`）。目标状态：Owner 发起 → `queued`；发起人发起且策略允许 → 重新走策略（`awaiting_approval` 或 `queued`）。

### 3.3 迁移守卫（Guards）

所有迁移**必须**通过 `TaskStateMachine.apply()`（纯函数 `reduce(task, event) → {next, effects}` + 持久化执行器），守卫按顺序检查，任一失败即拒绝且不产生副作用：

1. **存在性**：Task 存在，否则 `404 TASK_NOT_FOUND`。
2. **乐观锁**：若调用方提供 `expectedVersion` 且 `≠ task.version` → `409 VERSION_CONFLICT`（返回最新视图）。
3. **矩阵合法性与权限**：`—` → `409 INVALID_TRANSITION { from, event }`；先校验 Actor 权限（§3.5，无权 → `403 FORBIDDEN`），再处理 `=` 幂等返回。
5. **Run 关联性**：Worker 侧事件必须携带 `runId == task.current_run_id`，否则视为陈旧事件：丢弃 + 记 `stale_run_event` 指标（不报错给 Worker，见 03 §7）。
6. **业务约束**：`RETRY` 检查尝试次数；`APPROVE` 的 overrides 必须通过校验（adapter 已知、workspace 已知、profile ≤ 策略允许上限）。

### 3.4 持久化与副作用规则

- 每次迁移在**单个 SQLite 事务**内完成：`UPDATE tasks SET status=?, version=version+1, ... WHERE id=? AND version=?`（CAS，影响行数为 0 → 重新加载并重试一次，仍冲突 → `409 VERSION_CONFLICT`）+ 更新/插入 `task_runs` + 写 `audit_logs`。
- 同一进程内额外使用 **按 taskId 的异步互斥锁 `KeyedMutex`**，避免并发请求在 CAS 上反复冲突（飞书双击、面板与飞书同时审批）。
- 副作用（发送 `run.dispatch`/`run.cancel`、启动/清除定时器、发出 Cordis 事件）**必须在事务提交后**执行，按 `effects[]` 顺序执行。事件 `task/transitioned` 的发布保证“已持久化”。
- 状态机 reducer 为纯函数，放在 `packages/protocol/src/task.ts`（可被面板复用以计算按钮可用性），持久化执行器在 hub 内。

### 3.5 Actor 与权限矩阵

`Actor = { type: 'owner' | 'requester' | 'system' | 'worker', id: string, channel: 'feishu' | 'dashboard' | 'api' | 'system' }`

| 操作 | Owner | Requester（仅限自己发起的任务） | system | worker |
| :--- | :---: | :---: | :---: | :---: |
| SUBMIT | ✅ | ✅（受速率与并发上限约束） | — | — |
| APPROVE / REJECT | ✅ | ❌ | — | — |
| CANCEL | ✅ | ✅ 仅 `awaiting_approval`/`queued`；`running` 需策略 `requesterCanCancelRunning=true`（默认 true） | ✅ | — |
| RETRY | ✅ | 仅当策略 `requesterCanRetry=true`（默认 false） | ✅（自动重试） | — |
| INPUT_PROVIDE | ✅ | ✅ | — | — |
| 运行事件类 | — | — | — | ✅（经网关） |
| 定时器类（*_EXPIRE / *_LOST） | — | — | ✅ | — |

---

## 4. 定时器（全部可从 DB 重建）

| 定时器 | 起点 | 默认值 | 到期动作 | 重建依据 |
| :--- | :--- | :--- | :--- | :--- |
| 审批超时 | 进入 `awaiting_approval` | `approvalTimeoutMs = 24h` | `APPROVAL_EXPIRE` | `tasks.approval_deadline_at` |
| 派发 ack 超时 | 发出 `run.dispatch` | `dispatchAckTimeoutMs = 10s` | Worker 在线 → 重发同一 `runId`（最多 `maxDispatchResends = 3`）；超限 → `DISPATCH_LOST` | `task_runs.dispatched_at` |
| 宽限期 | Worker 连接断开 | `gracePeriodMs = 90s` | 对该 Worker 所有活动 Run → `DISPATCH_LOST`/`RUN_LOST` | `workers.disconnected_at` 与 Hub 启动时间取较晚者 |
| 输入超时 | 进入 `awaiting_input` | `inputTimeoutMs = 1h` | `INPUT_EXPIRE` → 发 `run.cancel(reason=input_timeout)` | `input_requests.expires_at` |
| 取消确认超时 | 进入 `cancelling` | `cancelAckTimeoutMs = 30s` | Worker 在线 → 重发 `run.cancel{force:true}`；离线 → 由宽限期处理 | `task_runs.cancel_requested_at` |
| 运行兜底 | Run `running` | `timeoutMs + 2 × gracePeriodMs` | Hub 侧兜底：发 `run.cancel(reason=hub_backstop)` 并在 Worker 回报前标记 `cancelling` | `task_runs.started_at` |

> Worker 侧自行执行 `timeoutMs`（墙钟）与 `idleTimeoutMs`（无输出，默认 10min）并上报 `finished.status = timed_out`；Hub 侧兜底只为防止 Worker 失控。

所有定时器由 `orchestrator` 插件内的 `TimerWheel` 管理（单个 `setInterval(1000)` 扫描 + 最小堆），注册在 `ctx.effect()` 中；**禁止**为每个任务创建独立 `setTimeout`（Hub 重启无法恢复且泄漏风险大）。时间源统一通过注入的 `clock` 服务，测试中可替换为假时钟。

---

## 5. 审批策略引擎（`policy` 服务）

### 5.1 规则模型

```ts
interface PolicyRule {
  id: string
  name: string
  priority: number            // 越小越先匹配
  enabled: boolean
  match: {
    actorType?: Array<'owner' | 'requester'>
    actorIds?: string[]       // 飞书 open_id 或面板用户 id
    source?: Array<'feishu' | 'dashboard' | 'api'>
    chatIds?: string[]
    workspaceIds?: string[]
    adapters?: string[]
    profiles?: Array<'readonly' | 'edit' | 'full'>
    promptPattern?: string    // 大小写不敏感正则，长度 ≤ 256，编译失败拒绝保存
  }
  effect: {
    decision: 'auto_approve' | 'require_approval' | 'deny'
    clampProfile?: 'readonly' | 'edit' | 'full'  // 降级而非拒绝
    approvalTimeoutMs?: number
    maxAttempts?: number
    autoRetryOnWorkerLost?: boolean
  }
}
```

### 5.2 求值规则

1. 先应用**硬规则（不可配置）**：
   - H1：`actorType=requester` 的任务 `profile` 上限为 `edit`；请求 `full` 时自动 clamp 为 `edit` 并在审计中记录。
   - H2：`profile=full` 且 actor 非 Owner → 强制 `require_approval`。
   - H3：未在 `ownerOpenIds` 且不在 requester 白名单中的飞书用户 → `deny`（且不回复详细原因，仅回复“无权限”）。
2. 再按 `priority` 升序匹配第一个 `enabled` 规则；所有 `match` 字段为 AND，数组内为 OR。
3. 无规则命中 → 默认：Owner `auto_approve`，Requester `require_approval`。
4. 求值结果（`ruleId`、`decision`、clamp 结果）写入 `tasks.policy_decision_json` 与审计。
5. 规则存 DB（`policy_rules` 表），面板修改后 `policy` 服务原地刷新缓存（热更新，无需重启任何插件）。

---

## 6. 多 Worker 调度器

### 6.1 触发时机

调度循环为**单飞（single-flight）**：任一时刻只有一个 `schedule()` 在运行；运行中再被触发则置 `dirty=true`，本轮结束后立即再跑一轮。触发源：

- `task/transitioned` 进入 `queued`；
- `worker/state` 变为 `online` 或 drain 解除；
- Run 进入终态（释放槽位）；
- Worker 心跳中 adapter 状态变化；
- 兜底 `scheduler.tickMs = 2000` 周期触发。

### 6.2 候选队列

```sql
SELECT * FROM tasks WHERE status = 'queued'
ORDER BY priority DESC, queued_at ASC, task_no ASC
LIMIT :scanLimit   -- 默认 200
```

**无队头阻塞**：某任务当前无可放置 Worker 时跳过它继续处理后续任务；同一轮内已被占满的 Worker 从候选集中移除。

### 6.3 过滤（硬约束，全部满足才是候选）

对任务 T 和 Worker W：

1. **身份**：`W.status = 'active'`（未吊销），`W.connection = 'online'`（`suspect`/`offline` 不接单），`W.drain = false`。
2. **亲和**：若 `T.required_worker_id` 存在，`W.id` 必须相等（Follow-up、手动派单）。
3. **CLI 能力匹配**：解析 adapter：
   - `T.adapter` 明确指定 → `W.adapters[T.adapter].status = 'ready'`；
   - 否则按 `T.adapter_prefs`（有序列表）→ 再按全局 `scheduler.defaultAdapterOrder`，取 W 上第一个 `ready` 的 adapter。
4. **工作区匹配**：`W.workspaces` 中存在 `id = T.workspace_id`，且该工作区声明 `allowedAdapters` 包含所选 adapter，且 `T.profile ≤ workspace.maxProfile`（`readonly < edit < full`）。
5. **容量**：`activeRuns(W) + reserved(W) < W.maxConcurrency`，其中 `reserved` 为 `dispatching` 中的 Run。
6. **工作区写锁**：若 `T.profile ∈ {edit, full}`，则同一 `(W, workspace)` 上不得存在其他 `edit/full` 的活动 Run（防止两个 Agent 同时改同一仓库）。`readonly` 任务不受限，但受 `workspace.maxConcurrent`（默认 2）约束。
7. **短期排斥**：W 在过去 `refuseBackoffMs = 60s` 内拒绝过 T → 排除。
8. **发起人公平性**：发起人当前活动（`dispatching|running|awaiting_input|cancelling`）任务数 `< maxActivePerRequester`（默认 Requester 2、Owner 不限）。

### 6.4 打分（最小负载优先）

```text
score(W) = (activeRuns + reserved) / maxConcurrency          // 越小越好
tie-break 1: preferred_worker_id == W.id 优先（软亲和）
tie-break 2: W.lastDispatchAt 更早者优先（轮转）
tie-break 3: W.id 字典序（保证确定性，便于测试）
```

### 6.5 派发事务

```text
BEGIN
  CAS tasks: queued → dispatching, run_seq += 1, attempt_count += 1, current_run_id = newRunId
  INSERT task_runs (id=newRunId, run_seq=tasks.run_seq, attempt=tasks.attempt_count, worker_id, adapter, workspace_id, profile, status='dispatching', dispatched_at)
  INSERT audit_logs (action='task.dispatch')
COMMIT
→ effects: workers.sendCommand(W, run.dispatch{...}) ; 注册 ack 超时
```

> **拒单回退与唯一性说明**：`task_runs.run_seq` 按 Task 单调递增（含 `refused`），唯一索引建在 `(task_id, run_seq)` 上；`tasks.attempt_count` 仅统计非 `refused` 的有效尝试——收到 `RUN_REFUSED` 时在事务内将 `attempt_count -= 1`（且该 Run 标记 `status='refused'`），避免下次派发触发唯一索引冲突，同时保持 INV-8 成立。

发送失败（Worker 刚好断开）不回滚事务——Run 保持 `dispatching`，由宽限期/重连 resume 逻辑处理（见 03 §6）。

### 6.6 Drain 模式

- **Hub 侧 drain**（面板/飞书 `/drain`）：`workers.drain=1` 持久化，向 Worker 发 `worker.drain{drain:true}`；调度器不再选中；已运行任务继续直到完成。面板显示“排空中 (n 运行中)”，`n=0` 时显示“已排空”。
- **Worker 侧 drain**（本机即将关机/升级）：Worker 发送 `worker.state{drain:true, reason}`，Hub 记录为 `drain_source='worker'`；Worker 重连后若 hello 中 `drain=false` 则自动解除（Hub 侧 drain 不自动解除）。
- 撤销（revoke）Worker：立即关闭连接（close 4403），其活动 Run 立即走 `RUN_LOST`（不等待宽限期）。

### 6.7 不可调度告警

任务在 `queued` 停留超过 `unschedulableWarnMs = 60s` 且原因可判定（无在线 Worker / 无 ready adapter / 工作区不存在 / 全部满载）时，Hub 在任务上写 `schedule_hint`（面板卡片展示原因），并对 Owner 发一次飞书提醒（每任务最多一次）。

---

## 7. 不变量（Pi 需编写属性测试）

- **INV-1**：任一时刻，每个 Task 至多一个非终态 Run，且 `tasks.current_run_id` 指向它。
- **INV-2**：`tasks.status ∈ {dispatching, running, awaiting_input, cancelling}` ⇔ 存在 `current_run_id` 且该 Run 非终态。
- **INV-3**：同一 Worker 上 `dispatching + running + awaiting_input + cancelling` 的 Run 数 ≤ `maxConcurrency`。
- **INV-4**：同一 `(worker, workspace)` 上 `profile ∈ {edit, full}` 的活动 Run ≤ 1。
- **INV-5**：`tasks.version` 严格单调递增，每次状态变化 +1。
- **INV-6**：终态 `succeeded`/`rejected` 永不再迁移。
- **INV-7**：对所有尚未被保留策略清理的 Run（`task_runs.logs_purged_at IS NULL`），`task_logs` 中每个 `run_id` 的 `seq` 从 1 开始连续无洞（缺口以 `kind='gap'` 事件显式占位，见 03 §5.5）。
- **INV-8**：`attempt_count` = 该 Task 下非 `refused` 的 Run 数。
