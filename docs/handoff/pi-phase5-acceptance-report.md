# Pi · Phase 5 独立验收报告（飞书长连接与交互卡片全闭环）

- **验收对象**：Codex (`gpt-6.2-astra`) 交付的 Phase 5 · `channel-feishu`
- **验收角色**：独立测试工程师（Pi），仅新增测试资产，**未修改任何业务实现代码**
- **工作区**：`E:\Agent工作流`
- **验收依据**：`docs/handoff/pi-test-matrix.md` §9 `SEC-18~20`、§13 `FS-7~27`、§14 `E2E-11~13`、§16 Phase 5；`docs/specs/05-feishu-integration.md`
- **结论**：**通过（PASS）**。Phase 5 门禁范围内全部用例通过，无 P0/P1 缺陷；`build / lint / depcheck / test` 全绿。仅记录 2 项不阻断的规格偏差/风险观察项（见 §7）。

---

## 1. 本轮新增测试资产

| 文件 | 性质 | 用例数 | 覆盖 ID |
| :--- | :--- | ---: | :--- |
| `packages/hub/test/pi/feishu.ts` | 独立注入器 `PiFeishuTransport`：记录 reply/send/patch 时间线；按“消息 ID + 第 N 次尝试”注入 429 / `99991400` / 卡片不可更新错误；支持自定义 `event_id` | — | 基础设施 |
| `packages/hub/test/phase5-router.pi.test.ts` | I（真实 SQLite 文件 + FakeFeishuTransport + 进程内 FakeWorker 协议客户端） | 13 | FS-7~FS-15、FS-27、SEC-19、SEC-20 |
| `packages/hub/test/phase5-cards.pi.test.ts` | I + U（卡片渲染结构） | 10 | FS-16~FS-20、FS-22、FS-24、FS-25、SEC-18 |
| `packages/hub/test/phase5-updater.pi.test.ts` | U（FakeClock/假定时器）+ I（体积与补充文本） | 2 | FS-21、FS-23 |
| `packages/hub/test/phase5-delivery.pi.test.ts` | I（结果回传策略、凭据隔离、drain） | 5 | FS-26、运维核查项 |
| `packages/hub/test/phase5-e2e.pi.test.ts` | E（**真实 Hub** + **真实 Worker 子进程** + `mock-cli` + FakeFeishuTransport） | 3 | E2E-11、E2E-12、E2E-13 |
| **合计** | | **33** | |

所有 I/E 用例结束前均调用 `assertInvariants(db)`（INV-1~INV-8 + 日志区间连续性）；纯渲染/定时器单测不涉及 DB，按设计不需要。

---

## 2. 验收执行结果（门禁命令）

| 命令 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ 通过（`tsc -b` × 全部包 + dashboard vite build） |
| `pnpm lint` | ✅ 0 error / 0 warning |
| `pnpm depcheck` | ✅ `no dependency violations found (155 modules, 455 dependencies cruised)` |
| `pnpm test` | ✅ **52 files / 847 passed, 1 skipped**（skip 为既有用例） |
| 新增 33 用例重复执行 | ✅ 连续 3 轮全绿（单轮 ~20s，无抖动/泄漏） |

复跑命令：

```powershell
pnpm exec vitest run --project hub `
  packages/hub/test/phase5-router.pi.test.ts `
  packages/hub/test/phase5-cards.pi.test.ts `
  packages/hub/test/phase5-updater.pi.test.ts `
  packages/hub/test/phase5-delivery.pi.test.ts `
  packages/hub/test/phase5-e2e.pi.test.ts
```

---

## 3. 消息预处理、身份与路由（FS-7 ~ FS-15、FS-27）

| ID | 用例（文件 : 断言要点） | 结果 |
| :--- | :--- | :--- |
| FS-7 | 未 `@机器人`（`mentions=[]`）/ 提到他人 / `sender_type!=user` → 0 任务、0 回复 | ✅ |
| FS-8 | `@_user_1`+文本：prompt 去占位并 trim；`feishu_messages` 写入 `request` 与 `progress_card`；进度卡片 `reply=true`、`target=原 message_id`；标题 `#1 · 等待负责人审批` | ✅ |
| FS-9 | Owner 私聊自然语言 → `queued`（auto_approve）、无 `approval_card`、`audience=owner` | ✅ |
| FS-10 | Requester → 进度卡片「等待负责人审批」；审批卡片发到 `ou_owner` 私聊；`form` 内含 `select_static`(adapter/workspace/profile) 与 `form_action_type=submit` 的 `approve/reject` 按钮；profile 选项含 readonly/edit（Requester 不含 full） | ✅ |
| FS-11 | 4 组组合：同 `event_id`、异 `event_id` 同 `message_id`、同 `event_id` 异 `message_id` → 仍只 1 个任务、1 张进度卡片；`feishu_event_dedupe` 同时存在 `evt:` 与 `msg:` 键 | ✅ |
| FS-12 | `create_time = startedAt - staleMessageMs - 5s` → 不建任务；Owner 私聊收到「已忽略 2 条启动前积压消息」；随后新鲜消息正常建单 | ✅ |
| FS-13 | 图片/文件 → 「暂仅支持文本需求」；富文本 `post` 按段拼接 `text`+`a` 节点（含换行）；空文本 → 帮助；> 32 000 字符 → 「需求过长」且不建单 | ✅ |
| FS-14 | 5 分支全覆盖：`awaiting_input` → `run.input` 正确 requestId/answer；运行中 → 「任务进行中，完成后再回复可继续对话」；`awaiting_approval` 与 `rejected` → 「任务未执行，请直接发送新需求」；终态有 session → Follow-up；终态无 session → 新建 `parentTaskId` 关联任务 + 「无法续接上下文，已新建关联任务」 | ✅ |
| FS-15 | Follow-up 继承 `resumeSessionId`/`adapter`/`workspaceId`/`profile`，`requiredWorkerId=原 Worker`；原 Worker 离线时子任务保持 `queued` 不派发，进度卡片出现「等待 follow-worker 节点上线」 | ✅ |
| FS-27 | 无权限用户私聊连发 3 条 → 仅 1 条「暂无使用权限，请联系管理员」（`denied:` 键唯一）；非允许群静默无回复；`/whoami` 例外可用 | ✅ |

---

## 4. 卡片回调、幂等与安全（FS-16 ~ FS-18、SEC-18 ~ SEC-20）

| ID | 用例（断言要点） | 结果 |
| :--- | :--- | :--- |
| FS-16 | 同一审批按钮 10 个不同 `event_id` 并发点击 → **恰好 1 个 success「已批准」**，其余 9 个为「正在处理，请稍候 / 已处理」；每个回调 `elapsed < 3 s`；`audit_logs` 仅 1 条 `task.approve`；恰好 1 个 Run、1 个 `run.dispatch` | ✅ |
| FS-17 | 面板先审批后，用旧 `ver` 点已非法动作 → toast info「任务状态已变化」+ 返回 raw 最新卡片；DB `cardTaskVersion` 自愈到最新 version；卡片内容为「已批准」 | ✅ |
| FS-18 | `orchestrator.approve` 注入 2.5 s 延迟 → 回调在 1.9~2.9 s 内返回 toast「已提交」；随后异步完成审批并由 CardUpdater 将卡片 patch 成「已批准」 | ✅ |
| SEC-18 | Requester 点审批按钮 → toast error「仅负责人可操作」，任务 `awaiting_approval`/version 不变，卡片 JSON 字节级不变 | ✅ |
| SEC-18 | `owner_review` 下 Requester 点 `[发送给对方]` → 同样拒绝；`resultDeliveryStatus` 保持 `pending_review`；无 `result_text`；Requester 进度卡片不变且不含结果正文 | ✅ |
| SEC-19 | Requester 用他人进度卡片点 cancel → 「无权操作此任务」；引用他人任务链续接 → 「无权限」且无子任务；直接调用 `orchestrator.cancel` → 403；原任务 status/version 不变 | ✅ |
| SEC-20 | Requester 受众（进度卡片 + 结果文本）逐条断言**不含**：`C:\Users…`/`C:/Users…` 绝对路径、`npm run …` 命令行、面板 URL（`https://hub.pi.internal…`、`/tasks/`）、`stderr:` 原文、私钥块、`sk-ant-…`/`app_secret` 明文；相对路径（`src/visible.ts`）保留；Owner 审批卡片仍保留内部路径（证明按受众过滤而非全局抹除） | ✅ |

---

## 5. CardUpdater 节流限流、体积与重连（FS-19 ~ FS-26）

| ID | 用例（断言要点） | 结果 |
| :--- | :--- | :--- |
| FS-19 | 运行中约 660 ms 内注入 200 条进展（4×50，seq 连续），默认 `minPatchIntervalMs=3 s`：窗口内同卡 **patch ≤ 1**，最终卡片含最新「进展 201」 | ✅ |
| FS-20 | 节流期间进入 `succeeded` → 终态 patch 在 finished 后 **≤ 1.5 s**（HIGH 1 s + 调度余量）完成，内容含「已完成」与 summary | ✅ |
| FS-21 | 假定时器注入 `429` 与业务码 `99991400`：单卡退避严格 2 s → 4 s（第 2/3 次尝试间隔断言）；1 分钟内第 3 次限流后全局桶速率 5 → **2.5**；5 分钟后恢复 5；退避后最新内容仍被最终 patch（最终一致） | ✅ |
| FS-22 | 对活动任务旧进度卡片注入 `230011`（撤回）→ `feishu_messages.dead=1`；自动补发新卡片并更新绑定（新 `messageId`、`chatId=oc_group`、`cardTaskVersion=当前 version`、内容「排队中」） | ✅ |
| FS-23 | 单卡三字段同时超限（32 000 字需求 + 12 000 字摘要 + 5×4 000 字进展）→ 卡片 JSON **≤ 28 672 B** 且 `JSON.parse` 往返一致；64 B 超小上限也能收敛；集成：30 000 字需求卡片 ≤ 28 KiB；`cardResultMaxChars=64` 时卡片摘要截断且**额外发送完整补充文本消息** | ✅ |
| FS-24 | 11 种 `TaskStatus` × `owner/requester` + 审批卡（待批/已批/驳回/取消）+ 审核卡（pending/delivered/suppressed）+ Worker 列表 + 任务列表：全部 `schema=2.0`、`config.update_multi=true`、`width_mode=fill`、header/body 结构合法、体积 ≤ 28 KiB、按钮 callback 值通过 `CardActionValue` 校验 | ✅ |
| FS-25 | `reconnecting` 期间 approve→cancel 两次状态变化 **0 次 patch**（`updater.paused`）；`reconnected` 后同一进度卡片**只补推 1 次**，内容为最新「已取消」 | ✅ |
| FS-26 | `owner_review`：结果先到 Owner 私聊审核卡；Requester 卡片仅「结果等待负责人审核」且无结果正文、无 result_text；卡片 `[发送给对方]` 后 Requester 收到结果与补充文本；重复点击 → 「已处理」且仅 1 条 result_text；面板 `deliver-result` 重复投递幂等；`[不发送]` → `suppressed`、Requester 仅见「负责人未发送结果」、无结果正文、`resultDeliveredAt` 为 null | ✅ |

---

## 6. 端到端闭环（E2E-11 ~ E2E-13）与运维隔离

E（真实 Hub 进程内组装 + 真实 Worker 子进程 + `mock-cli` + FakeFeishuTransport）：

| ID | 场景 | 结果 |
| :--- | :--- | :--- |
| E2E-11 | Requester 群聊 `@Bot` 提需求 → Owner 私聊审批卡片点击批准（form 覆写 `adapter=mock / workspace=sandbox / profile=readonly`）→ 本机 Mock Worker 真实执行（`run.pid>0`、`profile=readonly`、`cliSessionId=mock-session`、summary `Mock response 4`）→ 审批/进度卡片更新为「已批准 / 已完成」并回传结果 | ✅ |
| E2E-12 | Requester 引用父任务进度卡片追问 → 子任务 `parentTaskId`/`resumeSessionId=mock-session`/`requiredWorkerId=同 Worker`；批准后子任务以同一 session、同一 Worker 执行成功 | ✅ |
| E2E-13 | 10 个飞书审批回调（不同 `event_id`）+ 面板 `POST /api/v1/tasks/:ref/approve` 并发 → 卡片成功数 + HTTP 200 **恰好 1**；`audit_logs task.approve` 1 条；仅 1 个 Run / 1 次 dispatch；最终两端卡片「已批准 / 已完成」且 `feishu_messages.cardTaskVersion` 与任务 version 一致 | ✅ |
| 运维 | 飞书凭据缺失（无 `FEISHU_APP_ID/SECRET`）→ Feishu Fiber `FAILED` 但 `/readyz` 仍 200、`overview.feishu.state='failed'`、Hub 其余功能可建任务 | ✅ |
| 运维 | `hub.parallel('hub/drain')` ≤ 3.5 s 返回；`overview.hub.draining=true`；新消息回复「系统维护中，请稍后重试」；卡片回调返回同 toast 且任务不变；drain 冲刷终态卡片（「已完成」确保落盘） | ✅ |

---

## 7. 观察项（不阻断 Phase 5 门禁，供主 Agent 裁决）

### O-1（P3 · 规格偏差）卡片超限截断顺序与 `05 §6.3` 不一致

- 规格：超出 `cardMaxBytes` 时“依次截断：**进展行 → 结果摘要 → 需求摘要**”。
- 实现：`packages/hub/src/plugins/channel-feishu/cards/index.ts:28` 的 `fit()` 从字段数组末尾向前截断，而字段顺序为 `[prompt, ...progress, resultSummary]`，因此实际顺序是 **结果摘要 → 进展行 → 需求摘要**。
- 复现证据（只读探针，已在验收后删除）：`prompt=100×'P'`、`progress=5×6000×'X'`、`resultSummary=500×'R'`、上限 28 KiB → 结果 JSON 中 `R` 被截断为 0 个，而 4 行进展各 6000 字符完整保留。
- 影响：卡片超限时 Owner/Requester 先丢失“结果”，而非先丢进展行；体积上限与 JSON 合法性不受影响（FS-23 门禁通过）。
- 建议：按规格调整截断优先级（进展 → 结果 → 需求），并补一条针对性单测。

### O-2（P3 · 风险）`feishu_event_dedupe` 无 TTL 清理

- 规格 `05 §4.1`：去重键 TTL 7 天，由 retention 清理。
- 现状：全仓未实现 retention（Phase 6 的 DB-9/DB-10 范围）；仅 `router.ts:82` 在“无权限私聊”分支内删除超过 24 h 的 `denied:` 键，其余 `evt:`/`msg:`/`act:` 键永久增长。
- 影响：长期运行下该表行数单调增长（每事件 2~3 行），属容量风险而非 Phase 5 功能缺陷；建议在 Phase 6 retention 落地时纳入。

---

## 8. Codex 既有测试（`phase5-feishu.test.ts`，9 个定义 / 11 个执行用例）覆盖缺口

现有用例已验证了主要 happy path（FS-8/9/10 部分、FS-16、FS-18、FS-19 单元、FS-21 近似、FS-22、FS-25、FS-26 四模式、FS-24 快照、热配置与非关键 Fiber），本轮发现并补齐的缺口：

1. **FS-11**：仅覆盖同 `event_id`；缺少“不同 `event_id` 但重复 `message_id`”的二次去重断言（已补）。
2. **FS-12**：只断言丢弃，未断言 Owner 汇总提示文案与新鲜消息仍可建单（已补）。
3. **FS-15**：只断言继承字段，未构造“原 Worker 离线 → 保持 queued + 卡片等待提示”（已补）。
4. **FS-17**：完全缺失旧版本卡片自愈路径（toast + 返回最新卡片 + `cardTaskVersion` 自愈）（已补）。
5. **FS-21**：只验证了“3 次限流后吞吐减半”，未显式断言单卡 **2 s → 4 s** 指数退避与 5 分钟恢复（已补）。
6. **FS-23**：只有渲染层体积断言，缺少“补充文本消息”集成验证与 30 000 字需求卡片实测（已补）。
7. **FS-24**：快照仅覆盖进度卡；审批卡/审核卡/Worker 列表/任务列表的结构与动作值合法性未校验（已补）。
8. **FS-25**：只验证“reconnect 后补推一张新卡（dead 场景）”，未断言暂停期 **0 patch** 与恢复后 **每卡仅 1 次最新补推**（已补）。
9. **SEC-18**：只覆盖审批按钮，未覆盖 `owner_review` 的 `publish_result` 越权（已补）。
10. **SEC-19 / SEC-20**：完全缺失（已补：跨用户取消/续接、受众信息隔离）。
11. **E2E-11~13**：现有测试用进程内 `FakeWorker`，未使用真实 Worker 子进程 + `mock-cli`；E2E-13 也未与面板 REST 并发竞争（已补）。
12. **运维项**：凭据缺失时 `/readyz` 与 `overview.feishu.state`、`hub/drain` 冲刷终态卡片未覆盖（已补）。

---

## 9. 未纳入本轮（按矩阵属其他阶段/手工）

- `E2E-14`（真实飞书预发环境手工验收）：需真实凭据，属上线前手工门禁。
- retention / 容量护栏（`DB-9/DB-10`）、`PERF-*`、`SOAK-1`：Phase 6。
- `WIN-*` 与飞书无关。

---

## 10. 结论

Phase 5 门禁 **FS-7 ~ FS-27、SEC-18 ~ SEC-20、E2E-11 ~ E2E-13** 全部通过，且构建/静态检查/依赖规则/全量测试均为绿；每张卡片生命周期、跨渠道并发审批、受众隐私隔离与结果审核投递在真实 Worker 端到端场景下均符合规格。仅有 2 项 P3 级偏差/风险（O-1 截断顺序、O-2 去重表无 TTL），不阻断本阶段验收，建议纳入后续小修与 Phase 6 retention 计划。
