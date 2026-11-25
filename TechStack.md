# Helmcraft 增量技术设计（TechStack）

> 版本：1.0  
> 日期：2026-11-25  
> 迭代：Phase 8 — 个人三角色开发工作流  
> 状态：待实现技术合同；本文中的新增类型、接口和文件不是已有 API。  
> 产品规格：同目录 PRD.md  
> 代码基线：c7cd204519fc4853bc7520ac7f13b4b6fd649f7f。

## 1. 技术决策与约束

### 1.1 沿用现有栈

| 层 | 现有选择 | 本次决策 |
|---|---|---|
| 运行时 | Node.js >=22.12，README/CI 使用 Node 24 | 开发与 CI 统一 Node 24；不升级大版本 |
| 包管理 | pnpm@11.17.0，workspace monorepo | 以 packageManager 和 lockfile 为准，frozen-lockfile 安装 |
| 语言 | TypeScript ~5.9.3，ESM | 沿用严格类型与现有构建 |
| 协议 | Zod 4.x | 新增 workflow schema；protocol 不引入 Node 内置模块 |
| Hub | Cordis 4.0.0-rc.13、Fastify 5.x、ws 8.x | 新增一个 Cordis 项目流程服务 |
| 数据库 | SQLite、better-sqlite3 13.x、Drizzle 0.45.x | 增量迁移，继续单 Hub 数据库 |
| Worker | Node 子进程、CLI adapter、journal、outbox | 复用运行器，补候选采集、角色策略和占用检查 |
| Dashboard | React 18、Vite 7、Zustand、TanStack、xterm | 扩展项目页面，复用组件、认证和实时事件 |
| 测试 | Vitest 4、Playwright、mock-cli | 补状态机、故障注入、Git 交付与浏览器测试 |
| 质量 | ESLint 9、dependency-cruiser 17 | 保留既有门禁和依赖边界 |

版本来自当前 package.json/lockfile，不代表建议另行安装这些依赖的最新版。[T1]

不增加数据库服务、通用队列、通用 DAG 引擎、模型网关或通用 sandbox。新增文件按职责拆分，手写代码文件不超过 1000 行。保持 protocol → common → hub/worker 的现有边界，dashboard 不直接依赖 Worker 内部实现。

### 1.2 权威关系

- PRD.md：目标、范围、默认预算和 AC-01 至 AC-36。
- 本文：状态、数据、协议、权限、候选、交付和测试合同。
- TASKS.md：由主 Agent 生成的计划和人可读进度，不是执行真相源。
- Hub 数据库：项目状态、轮次、证据、步骤关联和验收状态的真相源。
- Worker：Git、文件、进程与验证命令结果的观测源；AI 文本不是这些事实的权威来源。

旧 TaskStatus、RunStatus、harness lastAccepted 和普通 Task 的成功语义保持兼容。workflow 在上层增加更严格的门禁，不把旧语义悄悄改成项目验收。[T2]

## 2. 架构与代码落点

### 2.1 职责

新增 project-workflow 服务，职责限定为：

1. 保存项目和计划，决定下一个阶段。
2. 为角色调用创建永久步骤，委托 Orchestrator 执行 Task/Run。
3. 收集可信证据，校验角色结果和阶段门禁。
4. 管理预算、唯一触发、仓库占用和恢复。
5. 生成最终三份报告的数据模型。

Worker 继续不直接写目标仓库。它可读取 Git/文件、执行固定验证、监督进程，并写平台自己的 journal、outbox 和证据状态。计划、代码、TASKS、黑板、Git stage/commit/push 均由 Main CLI 完成。

### 2.2 模块落点

| 路径 | 改动 |
|---|---|
| packages/protocol/src/workflow/ | 新增公共 schema、状态、错误码、结果、证据和 API 类型 |
| packages/hub/src/services/project-workflow.ts | 新增 Cordis 服务接口 |
| packages/hub/src/plugins/project-workflow/ | state、dispatch、contracts、candidates、recovery、reports 等实现 |
| packages/hub/src/plugins/store-sqlite/ | schema、迁移和 workflow repos |
| packages/hub/src/plugins/orchestrator/ | 内部步骤关联创建、托管 Task 入口限制和事件转交 |
| packages/hub/src/plugins/worker-gateway-ws/ | 在既有命令/回执路径增加限定 inspection 与 workflow 事件 |
| packages/hub/src/plugins/dashboard-api/ | 项目 REST、状态动作和只读报告接口 |
| packages/worker/src/workflow/ | inspection、candidate、reservation、role-policy、result-parser |
| packages/worker/src/runner/run-manager.ts | 调度前占用检查；新增验证前后候选捕获；阶段权限校验 |
| packages/worker/src/harness/verify-runner.ts | 有界管道收尾与清理状态 |
| packages/worker/src/adapters/ | 三 CLI 的能力探测、参数映射和严格角色结果提取 |
| packages/dashboard/src/ | 按既有页面与 store 组织新增项目功能 |

这是职责划分，不要求机械创建每个文件；可以复用现有模块，但不能把全部流程塞进一个大文件。

### 2.3 事件接入

WorkerGateway 的 setInboundHandler 已由 Orchestrator 单独使用。新插件不得注册第二个 handler 抢走消息。[T3]

沿用现有路径：Worker outbox → gateway/run inbox → Orchestrator 持久化 → Cordis 事件 → project-workflow。新增证据在该路径落库后触发推进。

run/events、run/updated、task/transitioned 是唤醒通知，不是唯一事实来源。控制器每次推进都在数据库中重新读取状态；Hub 重启扫描可恢复步骤。

工作流推进使用项目键互斥和数据库 CAS。同一项目的事件只推进一次。实现不需要新的消息代理；已持久化的 planned 步骤就是待派发记录。

## 3. 数据模型与迁移

### 3.1 四张领域表

字段名可按仓库命名规范调整，但语义、唯一约束和不可变性必须保留。

| 表 | 关键字段与约束 |
|---|---|
| project_workflows | id、version、status、currentStage、pauseRequested、workerId、workspaceId、repositoryIdentity、branch、remoteName、remoteRef、definitionRevision、definitionJson、definitionDigest、requirementsDigest、rolePresetsJson、preflightJson、budgetJson、usageJson、reservationEpoch、reservationState、blockedReason、finalCommit、reportSetId、acceptedAt |
| workflow_items | id、workflowId、itemKey、ordinal、title、requirementRefsJson、acceptanceRefsJson、dependenciesJson、verifySetId、activeFromRevision、retiredAtRevision、resolutionJson、budgetRootItemId、status、stage、version、validReviewRounds、reviewRejectCount、repairSteps、debugNoRootCauseCount、activeMs、currentCandidateId、approvedCandidateId、commitSha、pushReceiptJson；UNIQUE(workflowId,itemKey) |
| workflow_steps | id、workflowId、scopeKey、logicalKey、attempt、kind、role、status、requestHash、inputJson、taskId、resultJson、errorCode、chargedActiveMs、startedAt、finishedAt、lastRunId、lastEventSeq；UNIQUE(workflowId,scopeKey,logicalKey,attempt)，taskId 唯一可空 |
| workflow_candidates | id、workflowId、itemId、producerStepId、definitionRevision、baseHead、branch、sourceManifestJson、sourceDigest、indexManifestJson、indexDigest、diffDigest、reviewPacketJson、verifyEvidenceJson、rolePolicyDigest、progressProjectionJson、candidateDigest、createdAt；记录一旦成立不可原位替换 |

reviewPacketJson 保存有界但完整的冻结审查材料，包括实际差异、新增文件内容和所引用的需求/验收文本；不能只存一个 digest，恢复时再从已变化的工作区拼凑旧输入。候选批准、finalize 证据、commit/push 回执存入对应不可变 step result。不要反复覆盖一个候选记录来假装它一直没变。

scopeKey 是非空字符串，例如 project 或 item:T07，避免 SQLite 对 NULL 的唯一约束允许重复。logicalKey 例：plan:r1、review:r2、advice:review2:T07、finalize:candidateId、commit:candidateId。重复请求相同键但 requestHash 不同，返回冲突，不能当成功去重。

角色咨询、审查和主要调试结论均保存在 steps，不新增泛化消息系统。计划和角色配置修订通过不可变步骤记录旧版本，project_workflows 保存当前引用；audit 记录是谁、为何改变了版本。

definitionJson 明确每个修订的 activeItemIds 和 projectVerifySetId。已移出范围的项保留原状态、[!]、resolutionJson 和修订关联，不伪造为 done。新 ID 若延续同一需求范围，budgetRootItemId 指向原逻辑工作项；轮次、修复次数和累计活动时间从该根记录读取并原子更新，不能各自获得新预算。不同范围的新根必须由明确修订说明，不由模型自行宣布。

### 3.2 永久 Task 关联

在现有 tasks 表增加可空唯一字段 workflow_step_id。只有内部 workflow 创建入口能设置。

当前 createTask 的 idempotencyKeys 有 24 小时有效窗口，不能支撑长期工作流的执行去重。[T3] 必须先写 workflow_steps，再用该永久键创建或找回 Task：

~~~text
持久化 planned step
→ createWorkflowTask(stepId, requestHash, attemptLimit=1)
→ 已存在同 stepId 的 Task：返回原 Task
→ 不存在：事务内创建并关联
→ 更新 step 状态
~~~

一个 workflow Task 只允许一次有效 Run 执行尝试。故障重试由 workflow 创建新的 step attempt。尤其 commit/push 不能由通用 RUN_LOST/Owner retry 直接重放。新增 attemptLimit 只能收紧现有策略，公开请求不能提高它。

### 3.3 事务边界

以下操作必须在同一事务中完成：

- 接受一份有效角色结果、更新轮次、记录 trigger 或下一步 planned、推进 item/project 版本。
- 批准候选与写入当前 approvedCandidateId。
- 确认 push receipt、将 item 标为 done、登记下一项可执行。
- 人工验收及绑定 reportSetId/finalCommit/definitionRevision。
- 创建占用或释放占用与项目状态更新。

网络和 CLI 执行不放入 SQLite 事务。派发前后崩溃依靠 step 唯一关联对账。

### 3.4 保留与升级

迁移必须支持旧数据库升级，普通 Task 的 workflow_step_id 为 NULL。降级不自动删除项目表或历史证据。

进行中项目、待验收项目及其引用的 Run/证据不得被现有 retention 删除。终态项目按配置保留；清理需保持引用闭包，不能留下报告指向已删除证据而仍显示完整。

## 4. 状态机与推进规则

### 4.1 项目与工作项

项目状态使用 PRD 第 6 节的八种状态。WorkItem 使用 pending、running、blocked、done；stage 单独记录。

主要阶段：

~~~text
preflight → planning → plan_advice
→ implementing → verifying → reviewing
→ finalizing → final_verifying → committing → checking_commit
→ pushing → checking_push → 下一工作项
→ project_verifying → final_advice → reporting → awaiting_acceptance
~~~

阶段间存在修复、咨询、阻塞、暂停和取消分支，不使用无边界的 while 重试。

| 当前条件 | 下一动作 |
|---|---|
| 预检完整、没有已导入计划 | Main 生成 TASKS |
| 计划可信导入 | Advisor PLAN_READY；有实质计划变更则导入新修订后重新咨询 |
| 依赖全部 done | Main 实现当前项 |
| 代码与验证证据有效 | Reviewer 审查当前候选 |
| 第 1 次有效 REJECT | Main 修复 |
| 第 2 次有效 REJECT | Advisor 完成后才允许 Main 修复 |
| 第 3–4 次有效 REJECT | 在预算内继续修复 |
| 第 5 次有效 REJECT | item blocked、项目 blocked，记录 [!] |
| PASS | 精确 finalize，再复验、commit、push |
| 验证失败且根因未明 | Main 有界调试；连续两轮无根因先咨询 Advisor |
| 当前项已确认远端交付 | done，解锁下一项 |
| 当前修订有效项全部 done | project_verifying，核对最终提交的完整验证证据与现场；缺失则补 project_check |
| 最终验证与新现场检查通过 | final_advice，生成三份报告 |
| 证据齐全、终审完成、无 blocker | awaiting_acceptance |
| 人验收当前报告和提交 | accepted |

有效 review 定义为第 7 节合同全部满足的 PASS 或 REJECT。第五轮仍为硬上限。一次审查中列出多个问题仍只算一轮。PASS 之后若出现投影外变化或需要修改交付内容，旧批准失效，按第 8.4 节恢复并消耗剩余审查轮次；已用完 5 轮则阻塞。仅临时执行前提失败、且证据证明与内容无关时，可以在有界预算内复验同一内容，不把未通过状态直接转绿。

最终完成门禁检查当前 activeItemIds 和仍有效的 blocker。历史失败项继续出现在报告，但已明确撤销的范围不会永久阻塞新修订；当前依赖图不得引用 retired 项。移除失败项也必须先处理其遗留修改并核验已知边界，不能只改数据库就继续运行。

### 4.2 工作流 Task 的权限入口

为托管 Task 在 orchestrator.retry/handoff、Dashboard API 和飞书通用入口增加统一检查。只能转交 workflow action 或明确返回 WORKFLOW_MANAGED。

不能允许 Owner 身份绕过五轮上限、候选绑定和步骤占用。Owner 可明确结束项目或批准修订，但历史事实不清零。

Main 的各阶段采用不同提示和允许动作。implement/repair 禁止提交与推送；finalize 只允许固定进度变更；restore_progress 只允许撤回未交付的固定 checkbox；commit 禁止 push；push 禁止代码修改；project_check 使用 readonly profile，禁止修改、stage、commit、push。

这是对已支持 CLI 工具策略和阶段结果的约束，不承诺防御任意恶意本地进程。若 CLI 支持对应命令限制，必须启用；阶段后还要独立核验 HEAD、内容和远端。发现提前提交或推送时记录实际副作用并阻塞，不虚构“未发生”。

### 4.3 占用

项目在启动时登记持久 reservation。Hub 按规范化仓库身份排他；Worker 按 Git 根目录的真实路径再次检查别名。

同一仓库未结束的 project_workflows 只能有一个有效占用。Worker 的本地占用记录保存在已有 state 目录，不写目标仓库。双方核对 projectId 和 reservationEpoch，旧代次命令拒绝执行。

占用不是自动过期后可抢占的 lease。Worker 失联、进程未清理或 push 状态未知时不能转移给另一个 Worker。不同主机共享同一物理仓库的识别不在本版范围，预检明确禁止该部署方式。

暂停及 awaiting_acceptance 保留占用。需要释放时，必须确认无活跃进程、保存候选/现场并显式结束或解除绑定；恢复要重新预检。

## 5. 协议与固定用途 inspection

### 5.1 能力协商

增加 workflow.v1 能力。只有 Hub/Worker 双方支持时才发送新字段、命令和事件。旧 Worker 可以继续处理普通 Task，但不能处理项目工作流。

RunDispatch 新增可选 workflow 字段：

~~~typescript
type WorkflowBinding = {
  projectId: string
  itemId?: string
  stepId: string
  stepKind: "plan" | "implement" | "repair" | "debug" | "review"
    | "advice" | "finalize" | "restore_progress" | "commit" | "push" | "project_check"
  role: "main" | "reviewer" | "advisor"
  definitionRevision: number
  reservationEpoch: number
  candidateId?: string
  expectedCandidateDigest?: string
  verifySetId?: string
  verifyConfigDigest?: string
  effectivePolicyDigest: string
}
~~~

schema 严格校验枚举、长度、绑定和 role/stepKind 组合。不能由 prompt 自行提升 profile。

### 5.2 限定 inspection

新增一个限定用途的 Worker inspection 命令，operation 固定为：

- preflight：仓库、CLI、环境和 Git 目标检查。
- read_plan：读取固定根目录 TASKS.md。
- inspect_candidate：完整内容、index、HEAD 和差异捕获。
- inspect_commit：只读核验目标提交。
- inspect_remote：只读查询固定 remote/ref。
- inspect_cleanup：读取进程清理和占用状态。

请求仅含注册 workspace、绑定、预期值和固定枚举；不接受任意 shell、任意 argv 或任意绝对路径。Worker 内部固定构造 Git argv，shell=false，校验路径与 ref，禁止参数注入。

沿用 workers.send、cmd.ack/outbox 等现有机制，增加专用结果分支，不占用新的 inbound handler。先登记 pending request，再执行扫描；结果携带 requestId、binding、captureTime、digest。旧 inspection 响应不能覆盖新候选。

验证仍复用 RunManager/Harness 的 verifyAttempt，不通过 inspection 开放远程任意命令执行。

### 5.3 证据与完整性

新增 workflow 证据事件，在既有 Run seq/ack/resend 链路传输，至少区分：

- candidate_observed
- role_result
- readonly_observed
- delivery_observed
- cleanup_observed

事件持久化以 runId + seq 去重；阶段消费还检查 stepId、当前 Run 和 reservationEpoch。先收到 CLI finished 但缺少必需证据时保持待对账，不推进。

现有 prompt 有 100,000 字符限制，Harness 组合 prompt 有 262,144 UTF-8 bytes 限制，传输还有帧限制。[T4] 角色输入必须同时满足这些限制和探测到的实际 CLI 限制，不擅自扩大原协议限制。

完整差异、必要上下文和结果不能走 UI 的截断摘要通道。超限返回 TASK_TOO_LARGE/EVIDENCE_TOO_LARGE。禁止截掉文件或差异后仍标记 complete=true。此版不引入分片并行审查系统。

建议新增大小上限：TASKS 原文 128 KiB、角色最终 JSON 64 KiB；最终可用上限取其与已有传输/适配器限制的较小值。大小是运输与内存限制，不是 token 配额。

## 6. TASKS.md 格式与计划合同

### 6.1 固定格式

TASKS 使用 UTF-8、LF、普通文件。定义区、进度区和 decisions 区各出现一次；标记、ID、checkbox 唯一且可解析。Windows 项目需要保持 TASKS 的 LF；必要时 Main 在计划阶段为 .gitattributes 添加 TASKS.md text eol=lf，并纳入首条候选审查。以下是格式示例，不是本次已经生成的执行计划：

~~~~markdown
# 项目任务

<!-- helmcraft:definition:start -->
~~~json
{
  "schemaVersion": 1,
  "planRevision": 1,
  "requirementsDigest": "sha256:<digest>",
  "projectVerifySetId": "project-required",
  "items": [
    {
      "id": "T01",
      "title": "修复验证管道收尾",
      "requirementRefs": ["PRD:B01", "PRD:F05"],
      "acceptanceRefs": ["AC-18", "AC-19"],
      "dependsOn": [],
      "scope": ["packages/worker/src/harness/verify-runner.ts"],
      "verifySetId": "required"
    }
  ]
}
~~~
<!-- helmcraft:definition:end -->

<!-- helmcraft:progress:start -->
- [ ] T01 修复验证管道收尾
<!-- helmcraft:progress:end -->

<!-- helmcraft:decisions:start -->
暂无执行假设。新增记录包含：工作项、未知事项、已查来源、推荐选择、依据、影响。
<!-- helmcraft:decisions:end -->
~~~~

存入项目的 TASKS 只有内部 JSON 围栏，不包含示例外层围栏。生成器和 schema 统一维护该格式，不允许自由变体破坏精确投影。

### 6.2 可信读取

Worker 从绑定根目录读取 TASKS，不接受 Main 转述的文件内容充当可信计划。

复用 board-reader 的路径安全原则：固定相对路径、拒绝符号链接/硬链接和路径逃逸、lstat/fstat 一致性、完整读取和上限检查。不接受含冲突标记、非法 UTF-8、CRLF 或针对 TASKS 的自定义 Git clean filter 的文件。

Hub 校验任务 ID、依赖图、AC、验证集合；保存：

- 全文原始字节与全文 digest。
- canonical definition JSON 与 definitionDigest。
- 进度行的唯一定位及原始字节。
- PRD/TechStack 各自摘要及合成 requirementsDigest。

不能把新读到的 [x] 当作执行完成证据。导入进度只能与已存在的 workflow delivery records 对账。

### 6.3 修订

冻结边界是首次 implement 派发。此前若需求、AC 和技术方向不变，Main 可根据 Advisor 调整任务拆分、顺序和依赖；控制器验证后自动保存新修订并重新触发该版本 PLAN_READY，不需要 Owner 逐步确认。已消耗的时间与调用次数保留。

冻结后改变定义区、需求文件或工作项范围，返回 DEFINITION_DRIFT。Owner 的修订操作包含新定义、影响条款和理由；系统保存旧版本并失效受影响候选与报告。

普通假设写入独立 decisions 区，Main 可在候选冻结前追加；每条包含工作项、未知事项、查询结果、选择及影响。该区纳入 TASKS 全文 hash 和审查输入，PASS 后不能追加。影响范围、验收、依赖或技术方向的决定必须走定义修订，不能藏进 decisions 绕过冻结。

修订不重置原工作项的 review/retry/活动时间。确需终止原工作项并建立新范围时，必须显式结束、保留 [!] 和关联新修订；相同需求的后继项继承 budgetRootItemId，不能通过拆成新 ID 绕过第五轮失败。完成门禁只检查当前有效项及未解决的必需问题，历史处理状态单列。

## 7. 角色策略与输出合同

### 7.1 配置与能力

项目保存每个角色的 adapterId、cliId、modelPresetId、configuredModelId、resolvedModelId、actualCliVersion、effectiveInvocationPolicyDigest。CLI 或网关没有报告真实后端模型时，reportedModelId 为 unknown，不把配置字符串当作供应商实际回执。

默认预设按 PRD：Codex 主写手、Claude Reviewer、Gemini Advisor。effort 根据 CLI 的实际能力映射；不支持时阻塞，不能发送未经验证的参数。

cliId 引用 Worker 已配置 CLI。配置 command 时必须是现有绝对路径；使用 PATH 自动解析时省略 command，不能把 command: claude 或 command: gemini 当作有效显式路径。[T5]

不在此文档提供声称已经可用的新版 YAML。项目创建 API 和新增配置 schema 实现后，才生成与实际安装版本匹配的配置示例。

### 7.2 只读策略

现有 Claude readonly 会禁用 Bash、Edit、Write、NotebookEdit；因此 Reviewer 不负责自己执行 git diff 或测试，完整证据由 Worker 提供。现有 Gemini readonly 映射到 default approval mode，不能直接等同严格只读。[T5]

本版要求版本化 role policy：

1. 只允许实际需要的只读工具。
2. 禁止写工具、shell 执行、模式提权、再次委派、未批准的 MCP/外部工具等旁路。
3. 拒绝能削弱策略的 extraArgs/argsOverride。
4. 以实际 CLI 探测和专用夹具验证策略，包括写入尝试被拒绝。
5. 运行前后完整内容检查无变化；inconclusive 不能当 clean。
6. CLI 自身缓存或 session 写入可发生在其运行目录，不等于获准修改目标仓库。

如果当前 CLI 不能提供可验证的所需策略，预检阻塞 READONLY_UNSUPPORTED。不能在 UI 标记 enforced 然后退回只靠 prompt。

本版的权限保证针对已支持 CLI 的工具调用路径和观测到的仓库内容；不声称隔离任意恶意二进制、内核攻击或其他本地用户进程。

### 7.3 角色输入

每次调用都自包含：

- project/item/step/role 和需求、计划修订。
- 相关 PRD 段落、AC、范围和禁止扩展范围的规则。
- 当前代码身份、完整差异与新增文件、必要原文件上下文。
- 固定验证命令的实际结果及完整性标记。
- 前轮 findings、修复说明、已排除假设和未采纳建议。
- 输出 JSON schema、阶段权限、剩余次数和时间。
- Reviewer 额外获得允许的精确 progressProjection；Advisor 获得 trigger 与所需判断目标。

持久会话只能优化上下文成本，不替代这些字段。会话复用至少匹配 project、role、Worker、workspace、adapter、model preset、CLI version 和 role policy；不匹配时开新会话。

### 7.4 Reviewer JSON

~~~json
{
  "schemaVersion": 1,
  "projectId": "project-id",
  "itemId": "T07",
  "stepId": "step-id",
  "role": "reviewer",
  "candidateId": "candidate-id",
  "candidateDigest": "sha256:<digest>",
  "progressProjectionDigest": "sha256:<digest>",
  "decision": "REJECT",
  "findings": [
    {
      "id": "R2-F1",
      "severity": "major",
      "requirementRef": "AC-19",
      "path": "packages/worker/src/harness/verify-runner.ts",
      "location": "execute 的超时收尾路径",
      "problem": "后台后代仍持有输出管道时不会终结",
      "impact": "当前工作项无法退出，项目一直占用仓库",
      "evidenceRefs": ["verify:detached-pipe-holder"]
    }
  ],
  "evidenceRefs": ["candidate:candidate-id"]
}
~~~

使用严格 schema 和受限字符串/数组，拒绝额外顶层字段。最终结果是一个 JSON 对象，不从任意自然语言中猜测 PASS。

PASS 不允许未关闭 blocker/major。REJECT 至少包含一个与范围相关的 blocker/major 及具体证据；minor/note 可作为非阻断记录。新范围或纯风格建议不能构成 REJECT。

有效审查还要求：正确 Run 正常结束、完整结果未截断、角色绑定匹配、候选仍有效、只读检查 clean、必需验证完整。无效结果不计 review round，消耗该逻辑请求 attempt 和活动时间。

### 7.5 Advisor 与调试结果

Advisor JSON 共用身份和证据字段，增加 trigger、assessment、recommendations、missingEvidence。assessment 为 no_blocking_concern 或 concern；不提供可代替 Reviewer PASS 的字段。

触发唯一键：

- PLAN_READY：project + planRevision。
- REVIEW_REJECTED_TWICE：item + 第二个有效 REJECT 的记录 ID。
- DEBUG_NO_ROOT_CAUSE_TWICE：item + debugEpisode。
- FINAL_READY：project + definitionRevision + finalCommit。

每轮 debug 的 Main 结果包含 hypothesis、experiment、observations、rootCauseEvidenceRefs、rootCauseEstablished。布尔值为 true 但没有可解析的证据引用，按未建立根因处理。修复尝试总数和连续无根因计数分别保存。

Advisor 不采纳记录绑定 advice step ID 和理由。commit 时注入尚未记入提交的相关理由；终审后没有新提交则进入报告。

### 7.6 防止结果截断

现有 UI agent event/summary 通道会截断内容，不能从它反推严格角色 JSON。[T6]

在适配器解析路径捕获完整最终答复，写入有界 role_result 缓冲，验证完成后发专用 workflow 事件。超过上限、多个顶层对象、重复 final 或半截 JSON 均为 INVALID_ROLE_OUTPUT。

可以复用 structured adapter 共用逻辑；不得为每个角色重新实现一套 CLI 运行器。mock-cli 增加相应结果夹具。

## 8. 候选版本、验证与精确进度投影

### 8.1 候选内容身份

现有 manifest 并未为每个普通源码文件做完整内容 hash，不能直接作为审批身份。[T7]

新的 collector 必须覆盖全部 tracked/staged 交付文件。目录名是 dist/build 也不能自动忽略已跟踪文件。分别记录：

| 字段 | 内容 |
|---|---|
| baseHead / branch | 实现前预期 HEAD、当前分支 |
| sourceManifest | 工作树实际文件字节 SHA-256、路径、类型、模式；供验证前后比对 |
| indexManifest | path、mode、Git blob OID，按 Git 路径排序 |
| diffDigest | 相对 baseHead 的完整 staged diff 和新增文件材料的摘要 |
| requirementsDigest | PRD/TechStack 内容及当前定义修订 |
| verifyConfigDigest | 固定命令 ID、argv、cwd、超时及非敏感执行配置 |
| environmentEvidence | OS、Node、CLI、验证工具版本等实际观测，秘密值不写入 |
| progressProjectionDigest | 原 TASKS 内容与唯一预期变化的摘要 |
| candidateDigest | 对上述稳定字段的 canonical JSON 计算 SHA-256 |

Git OID 按仓库实际对象格式处理，不写死 40 字符。跨平台用 Git blob/index 比较提交内容，工作树字节 hash 比较实际被测试的内容；二者不能混为一谈。

.git 内部变化不纳入 sourceDigest；HEAD、index、branch、remote/ref 单独核验。候选身份不含会变化的时间戳，采集时间作为独立元数据。

拒绝不完整读取、非法路径、未解决 merge、未知 stage、逃逸链接和当前实现不支持的 submodule/gitlink。文件系统链接按类型处理，不跟随到仓库外读取。TASKS 必须是普通文件。若实现不支持某种条目，明确阻塞，不静默漏掉。

候选准备要求无未 stage 的交付改动、无未归属的未跟踪交付文件。临时文件只能在已登记的忽略路径中，不得把源码或测试移入忽略目录以逃避审查。

### 8.2 RunManager 中的验证位置

implement/repair 步骤结束后：

1. 完成 CLI 进程清理。
2. 捕获 staged 内容和验证前工作树。
3. 执行现有固定 verifyAttempt，workflow autoFixMaxRetries=0。
4. 验证结束后再次完整捕获工作树/index/HEAD。
5. 前后内容相同、必需命令全部 passed 才形成可审查候选证据。
6. 发完整 workflow 证据，再正常终结 Run。

不能只用当前 capturePost 的结果，因为它发生在 verifyAttempt 之前。[T6]

如果 CLI 失败或清理未确认，不启动验证。存在 TAMPER_RISK、CONFIG_EXPOSED、MANIFEST_INCOMPLETE、NO_COMMANDS 或未执行命令时，不形成通过候选。NO_CHANGES 不是实现完成证据；若工作项本来无需代码修改，应以明确计划修订解释已有实现及证据，不制造空提交。仅第 8.5 节受控的 project_check 是显式只验证阶段，必须执行必需检查，不能因无修改跳过。

验证策略变更需要明确授权记录，绑定 candidateDigest 和 verifyConfigDigest。已有会话授权能覆盖明确动作时复用，不重复索要确认；不能用通用“继续”覆盖未知命令。授权后仍要真实执行验证并保留风险记录。

### 8.3 精确 TASKS 投影

为满足“Review 通过后再勾选 TASKS、commit、push”，候选包含一项确定的允许变更：

~~~typescript
type ProgressProjection = {
  itemId: string
  candidateId: string
  originalTasksDigest: string
  originalTasksBlobOid: string
  oldLine: string
  newLine: string
  expectedFinalTasksDigest: string
  expectedFinalTasksBlobOid: string
  expectedFinalIndexDigest: string
}
~~~

oldLine 与 newLine 只有当前项 checkbox 从 [ ] 到 [x] 的差别。Worker 在内存里计算完整预期 TASKS 字节及对应 Git blob 身份，不写目标文件。Reviewer 批准 candidateDigest 和 progressProjectionDigest。

Main finalize 修改并 stage 后，Worker 核对：

- TASKS 完整内容恰好等于预期字节。
- index 中只有 TASKS 对应 blob 按预期变化；其余 path/mode/blob 均相同。
- PRD、TechStack、任务定义、AC 和 .board 没有新变化。
- HEAD 和分支不变，其他工作树字节不变。
- 重新运行全部必需检查，结束后再做完整捕获。

最终提交应等于“已批准 candidate 加已批准的唯一投影”，不是等于审查前原树。不能只比较 TASKS 定义 digest，也不能把整个 TASKS 文件排除。

finalize/restore_progress/commit/push 的 Harness board 模式固定为 capture 或 off，不注入“本轮更新黑板”的写入要求。该限制同样适用于恢复会话。

### 8.4 finalize 后失败的闭环

尚未 commit 时，若临时执行前提失败且交付内容未变，可在同一逻辑验证步骤的剩余尝试/时间内复验。功能断言失败不能仅凭一次重跑通过就宣称根因已修复。

确需改代码时，旧批准失效；先创建 Main restore_progress 步骤，仅把当前尚未交付的精确 [x] 投影恢复为 [ ]。Worker 核对 TASKS 全文字节回到原值、HEAD 未变、其余内容在该撤回步骤中未变，再允许 repair/debug。恢复后的新候选重新验证和审查，继续消耗原逻辑工作项预算。

若 TASKS 已有其他意外变化、HEAD 已变化或无法证明是该未交付投影，则阻塞，不能套用自动撤回。第 5 轮 PASS 后需要改代码也必须阻塞，不存在第 6 轮。已发生异常提交的情形继续按第 9 节对账，不自动 reset。

### 8.5 最终版本完整验证

projectVerifySetId 指向 Worker 本地预先配置的项目回归命令集合。每项 verifySetId 指向同一受信配置中的命令 ID 子集；协议只传 ID，命令的 argv/cwd/超时仍由本地固定配置提供。预检校验全部引用和集合并集，超出原有命令数量/结果长度限制时阻塞，不能截断。

最后一个有效工作项的 final_verifying 运行该项目集合与当前计划所有工作项必需集合的并集，按命令 ID 和配置 digest 去重。之后 commit tree 必须精确对应这些验证所见内容，才能将完整验证证据绑定 finalCommit。早期工作项的结果作为历史保留，不能直接把其 SHA 改成 finalCommit。

全部当前工作项 done 后进入 project_verifying。先做新的 inspection，核对 HEAD、工作树/index 和固定 remote/ref，确认完整验证证据的代码及配置绑定仍有效，然后进入 FINAL_READY。

若因批准的计划修订等原因，现有最终提交缺少完整集合证据，创建 Main project_check Task：readonly profile、board=capture/off、autoFixMaxRetries=0、禁止仓库写入，仅启动一次正常 CLI 步骤后由既有 RunManager/verifyAttempt 运行固定集合。仅此受控阶段免除 NO_CHANGES 跳过；仍执行内容前后捕获、篡改保护、清理确认和全部预算门禁。不建立第二套验证调度器、不制造空提交。

现有 resolveHarness 和 computeApplied 都会禁用 readonly 的验证，仅免除 NO_CHANGES 不足以执行该步骤。[T10] 两层必须新增受控授权分支，条件同时为：已协商 workflow.v1、role=main、stepKind=project_check、合法内部 step 绑定、有效 reservationEpoch、固定 verifySetId 与实际本地 verifyConfigDigest 匹配。该授权由控制器构造并由 Worker 独立校验，不能来自 prompt、公开 extraArgs 或普通 Task 覆写。普通 readonly Task、Reviewer、Advisor 继续禁止验证，不全局删除 readonly guard。readonly 限制 Main CLI 的工具；受信验证命令仍由 Worker 监督。旧 autoAcceptDecision 对 readonly 不接受的规则保持不变，项目只消费独立验证证据。

project_check 不计有效 review 或修复轮次，但计调用尝试和项目活动时间。验证产生 tracked/index 改动或检查失败时阻塞，不能在已交付版本上暗中修复；后续开发需明确计划修订。

## 9. Git 交付合同

### 9.1 commit

Main commit 只处理已批准的 final index，不运行 git add .，不合并其他工作，不修改文件。

Worker 通过固定 Git 读取检查：

- parent 等于候选的 baseHead。
- 提交位于固定当前分支。
- commit tree 的所有 path/mode/blob 与 expectedFinalIndexManifest 完全一致。
- 工作树仍等于通过最终复验的内容；无新增未归属改动。
- commit SHA 真实存在，Main 自报 SHA 仅为查找线索。

提交 hook 修改内容、跳到其他分支、生成意外 merge 或多次提交，均为 COMMIT_MISMATCH。保留真实提交，不自动 reset 或重写历史。

### 9.2 push

只有 commit 检查通过才创建独立 Main push 步骤。目标是预检固定的 remoteName 与 remoteRef，普通 fast-forward push；禁止 force 和临时改 remote URL。

Worker 用只读 Git 查询核验远端 ref 的实际 OID 等于目标 commit，保存 remote identity、ref、SHA、observedAt 和查询结果摘要。

若远端已前进到非预期提交，即使本地目标可能是祖先，也先返回 REMOTE_DRIFT，不自动把外部代码算进本次交付。Owner 明确处理后重新对账。

### 9.3 中断与重复

| 情况 | 处理 |
|---|---|
| commit 执行超时或断线 | inspect_commit 查实际 HEAD/tree；已生成预期 commit 则复用 |
| push 命令报错 | 查询 remote/ref；已是目标 SHA 则记录确认成功 |
| 本地 commit 存在，remote 仍为基线 | 在预算和授权内重试同一次交付，不重新实现或造新提交 |
| remote 查询不可用 | delivery_unknown，保留占用，不 done |
| remote 是意外新 SHA | REMOTE_DRIFT，禁止 force push |
| 输出声称成功但事实不匹配 | 使用 Worker 观测，阻塞并保留原始输出摘要 |

验收报告由 Hub 基于证据导出，默认不写回目标仓库，避免报告生成本身再次改变已经终审的代码。若用户以后要求报告入库，应作为显式后续文档交付，不改写本次 finalCommit。

## 10. 进程管道问题的修复合同

### 10.1 根因边界

当前 verify-runner 在子进程 close 上等待，而持有 stdout/stderr 的后台后代可能使 close 延迟。仅终止原进程组不能证明所有继承管道的进程都已消失。[T8]

修复需区分 process exit、pipe drain 和 process-tree cleanup 三件事，避免单个 Promise 永久等待。复用普通 CLI 路径已有的有界收尾思路，不复制一套无限等待。

### 10.2 必须行为

- child exit 时立即保存 code/signal，不依赖 close 才能记录。
- timeout/cancel/exit 的收尾只有一个 finalizer，重复信号不会重复发布终态。
- 进程终止、强制终止和输出 drain 都有上限。
- 默认 graceful termination 上限沿用 5 秒；强制清理确认和管道 drain 各最多 2 秒，总收尾最多 10 秒。
- 达到 drain 上限后解除监听并销毁父进程持有的管道，结束本次验证；保留截断和不确定原因。
- exitCode=0 但管道/清理不可信时不能给 passed。使用 unverified/VERIFY_CLEANUP_UNCONFIRMED 等明确原因。
- 无法确认后代已退出时，把 workspace 标为 quarantined，项目 blocked，保留占用；不得因验证 Promise 已结束就允许新 writer。
- 不通过无保护的 PID kill 误杀复用 PID；继续使用既有 pid start time / Job Object / process-group 机制。
- finally、日志 flush 和 journal 清理也不能引入新的无界等待。

具体收尾时间允许配置收紧；扩大上限必须有理由和测试。测试使用可控时钟，集成用例允许有限调度容差，断言“有界结束且不错误放行”。

### 10.3 必需回归夹具

1. 正常退出且所有管道关闭。
2. 父进程退出，普通子进程仍存活。
3. 后代脱离原进程组并继承 stdout/stderr。
4. timeout 和 cancel 同时发生。
5. spawn 失败、无 PID、exit 后迟到 close。
6. Hub 断线、Worker 关闭期间处于验证。
7. POSIX 与 Windows 各自真实进程机制，夹具结束后无残留。
8. 无法可靠杀死后代时，验证有界返回且工作区保持隔离。

## 11. 预算、失败分类与恢复

### 11.1 预算计算

默认数值严格使用 PRD F09。计数在事务内递增，不依赖模型自行报告。

- 一次有效审查：一个唯一 review step 结果被正式接受。
- 一次执行尝试：实际创建并派发的角色 step attempt；无效输出、timeout 和执行错误均消耗。
- 一次修复：初次实现之后的 repair/debug Main 步骤；同一重试不重复登记逻辑修复，但仍消耗执行尝试。
- 活动时间：按持久步骤区间累计，验证包含在该步骤内，不能把 Run 时间和 verify 时间重复相加。
- 定期保存已收费活动时间；恢复时只增加未登记部分，不能降低累计值。
- 单次 deadline 同时受角色、工作项和项目剩余时间的最小值约束。
- 外部状态不明时阻塞并对账；离线期间不默认记为零，也不能启动替代写手。

调用达到时间上限后，仍须有界完成进程清理。清理时间记录到使用量，不因为预算已经耗尽就跳过清理。

token 读取 CLI usage；缺失为 null/unknown，聚合展示已报告部分与未知步骤数，不编造总量，不设 tokenHardLimit。

### 11.2 错误类别

| 类别 | 示例 | 自动处理 |
|---|---|---|
| 执行前提 | CLI_MISSING、MODEL_UNAVAILABLE、READONLY_UNSUPPORTED | 阻塞，显示具体配置 |
| 证据/内容 | CANDIDATE_DRIFT、INVALID_ROLE_OUTPUT、EVIDENCE_TOO_LARGE | 安全且有预算时重新获取；内容变化需新候选 |
| 业务门禁 | REVIEW_LIMIT_REACHED、BUDGET_EXHAUSTED、DEPENDENCY_BLOCKED | 不自动绕过 |
| 验证信任 | TAMPER_RISK、CONFIG_EXPOSED、MANIFEST_INCOMPLETE | 阻塞；明确处理后重验 |
| 进程未知 | WORKER_OFFLINE、VERIFY_CLEANUP_UNCONFIRMED | 保留占用，对账/隔离 |
| Git 交付 | COMMIT_MISMATCH、DELIVERY_UNKNOWN、REMOTE_DRIFT | 先只读对账，不盲目重放 |

timeout 不等于远端动作失败；无效模型答复不等于有效 REJECT；未知状态不等于通过。

### 11.3 暂停与取消

pause 设置 pauseRequested，不再创建下一步；正在运行的步骤保存结果并到达边界后进入 paused。若该结果本身阻塞，以 blocked 及具体原因为准，仍保留暂停请求。

cancel 设置 cancelling，调用既有 orchestrator.cancel。确认 Task 终态、进程清理和交付现场后才 cancelled。不能确认时一直显示待对账，不释放占用。

取消后迟到事件只补齐历史事实，不触发新步骤或复活 PASS。所有推进检查项目状态与 reservationEpoch。

### 11.4 重启恢复算法

1. 找出未终态项目和 planned/dispatching/running 步骤。
2. 根据 workflow_step_id 查询永久关联 Task；存在则复用，不再 create。
3. 查询当前 Run、持久事件、Worker journal 恢复结果和实际进程状态。
4. 执行固定 inspection 核对仓库、候选与交付。
5. 幂等消费尚未记录的结果，补齐预算，不清空审查/触发记录。
6. 只有证据完整、无未知 writer、绑定一致时推进下一步；否则 blocked。
7. commit/push 先对账后决定是否重试；实现步骤中断后也先查看现有改动，不重新无差别生成代码。

现有 Worker restart 会把未完成 Run 处理成失败或 unverified/WORKER_RESTARTED，不是恢复同一个运行中的 CLI。[T6] 新流程应明确区分 transport reconnect 和 process restart。

## 12. API 与 Dashboard

### 12.1 新增 API 语义

以下路由追加在现有 Dashboard API 的认证前缀下，完整路径以仓库路由规范为准。

| 方法/路径 | 用途 |
|---|---|
| POST /projects | 创建草稿；保存固定绑定、角色预设、验证集合与预算 |
| GET /projects | 项目列表 |
| GET /projects/:id | 状态、阶段、版本、预算和摘要 |
| GET /projects/:id/items | 有序工作项及依赖、轮次、交付状态 |
| GET /projects/:id/steps/:stepId | 步骤、Task/Run、角色结果和证据 |
| GET /projects/:id/candidates/:candidateId | 候选摘要与完整性；敏感内容按现有权限控制 |
| POST /projects/:id/actions | start/pause/resume/cancel/retry_safe/revise/accept/reject_acceptance |
| GET /projects/:id/reports/:name | 三份报告的指定版本导出 |

所有写动作包含 expectedVersion 和 clientRequestId。相同 requestId 相同请求返回原结果，不同请求 hash 返回 409。accepted、cancelled 等终态不接受普通 resume。

accept 必须携带 reportSetId、definitionRevision、finalCommit。处理该请求时发起新的 inspection，核对 HEAD、内容、index 和 remote/ref 与最终证据一致；inspection 绑定本次 requestId/版本，在持有仓库占用时完成。网络不可用或有漂移则拒绝验收，不能只核对数据库 CAS。

reject_acceptance 保存具体问题，将项目 blocked。追加开发需显式计划修订，不能直接改 accepted 版本。

retry_safe 由控制器判定是否可重试，不接受用户任意 stage/run/profile。revise 保存理由、影响范围及旧版本引用，不清历史。

### 12.2 界面原则

复用现有组件和实时事件，新增“项目”导航。列表与详情展示 PRD F11 所需信息。

将“执行成功”“验证通过”“审查通过”“已交付”“人工已验收”分别展示。主状态由 Hub 返回，前端不能通过本地 [x] 或最后一条日志猜测。

操作按钮根据后端 allowedActions 展示，点击后仍做服务端校验。禁用时解释具体原因，如“第 5 轮未通过”“远端状态待确认”，不显示笼统“出错了”。

下载报告使用固定 reportSetId。新事件或代码变化时提示当前报告失效，不让用户在过期页面验收。

飞书本次只延续既有 Task 能力与必要通知链接，不增加完整项目管理 UI。

## 13. 三份交付文件的生成

由 Hub reports 模块从持久证据确定性生成 Markdown。AI 可提供判断文字，但不得决定或填补证据状态。

统一头部：

~~~yaml
schemaVersion: 1
reportSetId: <id>
projectId: <id>
requirementsDigest: <digest>
definitionRevision: <number>
planRevision: <number>
finalCommit: <actual-sha-or-null>
generatedAt: <timestamp>
completion: complete | incomplete
~~~

- ACCEPTANCE.md：当前生效需求的每个 AC 状态、工作项、审查和实际代码版本；明确关联 finalCommit 上的完整验证，历史逐项结果分别标注。没有证据则 unknown/not_run。
- ADVISOR_FINAL.md：终审 step、模型配置/实际报告信息、输入版本、原判断、建议和采纳情况。
- UNRESOLVED.md：所有 [!]，含影响、未解决原因、最后证据、修订/人工处理记录及“仍阻塞/需求已移除/由修订处理”等状态；不得删除历史问题来制造“无”，也不得把移出范围写成已修复。

三个文件同一事务读取一致快照，生成同 reportSetId。报告之后发生新交付、需求修订或证据失效，应生成新版本并拒绝旧版本验收。

Final Advisor 提出的新问题先分类：范围外建议只记录；有证据的未满足 AC/blocker 阻止 awaiting_acceptance 并转明确修订/处理，不借顾问直接扩大需求。

## 14. 测试与 CI

### 14.1 基线修复

评估引用的 CI Run 为 45537243334。Ubuntu 有 6 项失败，Windows 作业取消。[T9] 实施时核对最新运行，不能直接把旧结论当作最新结果。

重点：

- phase2-process.pi 中 Windows PowerShell RSS 采样不能在 Linux 上被 catch 为 0 后继续当有效观测。
- phase2-windows 的 taskkill/Job Object 断言只在相应平台运行；POSIX 夹具需与生产 detached 进程组前提一致。
- UNC 和 Windows 路径测试明确平台预期。
- phase3-adapters 的 Windows 全局 Codex 安装假设改用确定性 shim 夹具；真实 CLI 测试单独标记和报告。
- transport 关闭连接后等待明确事件/状态收敛，不用任意 sleep 修复时序。关闭竞态是待验证根因，不宣称已修复。
- 双平台矩阵建议 fail-fast=false，让一个平台失败时仍取得另一平台证据。
- 不以 test.skip 或删断言替代根因修复；确属平台特有用例才做平台限定。

### 14.2 本次自动化覆盖

| 测试层 | 关键用例 | 关联 AC |
|---|---|---|
| protocol/unit | schema、结果校验、预算、触发去重、状态转移、定义图校验 | 02、08–15、26 |
| store/integration | CAS、永久 step→Task 关联、重复事件、retention 引用、迁移 | 03、22、25、31 |
| worker/security | 角色限制、路径别名、只读写入尝试、内容漂移、输入超限 | 01、04–06、16、20 |
| worker/process | 父退出/后代持管道、timeout/cancel、清理未知与隔离 | 18–19、23–24 |
| candidate/git | tracked/staged 完整性、TASKS 精确投影、钩子改树、push 对账 | 16–17、29–30 |
| workflow/e2e | 两项依赖、第五轮 PASS/REJECT、四类 Advisor、暂停恢复、自动计划完善、历史失败移出范围 | 02、07–15、21–27、31、35 |
| dashboard/browser | 合法按钮、阶段展示、证据页、三份报告、过期验收 | 32–36 |
| compatibility | 普通 Task、旧 Worker、既有 lastAccepted、旧 autofix；仅受控 project_check 可在 readonly CLI 后验证，普通 readonly/Reviewer/Advisor 仍禁用 | 03–05、10、33 |

使用本地临时 bare Git remote 做交付测试，不向用户生产仓库推送测试提交。夹具位于测试目录/临时工作目录，清理时只清理自己创建的对象。

崩溃注入点至少覆盖：step 持久化后/Task 创建后、结果落库前后、轮次更新前后、finalize 后、commit 后未回报、push 后未回报、最终报告生成后。检查不存在重复写入和虚假 done。

补充闭环用例：首轮 PASS 后复验需改代码，精确恢复 [ ] 后在第二轮通过；第五轮 PASS 后同情形阻塞；Advisor 在首次实现前要求拆小任务时自主重新导入；普通假设追加不改变 definitionDigest；明确移除失败范围后保留历史 [!] 且不阻塞合法新范围；最终集合覆盖早期功能；人工验收期间外部内容/远端漂移被拒绝。

### 14.3 CI 命令与真实接入

继续使用仓库现有命令：

~~~bash
pnpm install --frozen-lockfile
pnpm -r build
pnpm lint
pnpm depcheck
pnpm test
~~~

保留 Dashboard 的既有构建与浏览器测试路径。环境所需浏览器安装按现有测试配置补齐，不把缺浏览器和产品失败混淆。

真实接入单独记录 OS/WSL、Node、CLI 版本、configured/resolved/reported model、实际权限、使用量与结果。至少实际调用三角色，验证拒绝写入和完整两项闭环。

mock 测试通过不等于真实模型权限已证明；真实 CLI 缺凭据、模型不可用或尚未执行，应如实标为未验证，并阻止完整验收。

## 15. 实施路线与完成门禁

顺序沿用 PRD P0–P6。依赖不可倒置：先修可信执行，再建持久流程，再建角色和证据，再交付 UI。

每个工作项遵守：

~~~text
Main 实现
→ 必需验证与候选捕获
→ Reviewer（最多 5 个有效结果）
→ 需要时 Advisor/修复
→ PASS 后精确 TASKS 变更与复验
→ Main commit
→ Worker 核验
→ Main push
→ Worker 核验远端
→ DB done
~~~

新编排器尚未完成时，开发宿主负责执行以上流程；不要让未实现的功能成为它自身开发的启动前提。

每次提交记录任务 ID、需求/AC、测试结果摘要以及本次未采纳顾问意见的理由。代码和验收证据完成后再更新 AGENTS.md/操作文档，保持真实。

最终完成标准：PRD 的 AC 全部有证据；双平台 CI 有完整结果；真实 CLI 路径已验证；三份报告同版本；Owner 验收明确提交。单独提供“实现完成但真实接入未验”的报告可以交付事实，但不得冒充 accepted。

## 16. 参考源码

这些链接用于确认现有行为和增量位置，新增合同以本文为准。

- [T1：根 package.json](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/package.json)
- [T2：Harness 既有规范](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/docs/specs/08-blackboard-harness.md)
- [T3：Orchestrator、创建去重与事件处理](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/hub/src/plugins/orchestrator/index.ts)
- [T4：Worker 命令 schema](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/protocol/src/worker/commands.ts)
- [T5：CLI 适配器与执行路径解析](https://github.com/lucas045057-eng/Helmcraft/tree/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/worker/src/adapters)
- [T6：RunManager 验证、事件和恢复配合](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/worker/src/runner/run-manager.ts)
- [T7：现有 manifest](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/worker/src/harness/manifest.ts)
- [T8：现有 verify-runner](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/worker/src/harness/verify-runner.ts)
- [T9：CI 评估记录](https://github.com/lucas045057-eng/Helmcraft/actions/runs/45537243334)
- [T10：Harness 权限策略](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/protocol/src/harness/policy.ts) 与 [Worker applied 策略](https://github.com/lucas045057-eng/Helmcraft/blob/c7cd204519fc4853bc7520ac7f13b4b6fd649f7f/packages/worker/src/harness/session.ts)

