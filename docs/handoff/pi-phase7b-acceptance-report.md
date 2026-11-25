# Pi 独立验收报告 · Phase 7b（本地验证引擎 + 反馈闭环）

> 验收人：Independent QA & Red-Team Engineer (Pi)
> 依据：`docs/specs/08-blackboard-harness.md`（唯一权威规格）、`docs/handoff/phase7-implementation-plan.md` §2「7b 退出门禁」/ §4「Pi 验收矩阵」
> 环境：Windows 11 · Node 24.14.1 · pnpm 11.17.0 · 单机（无 CI 矩阵）
> 被测范围：Phase 7b 全部交付物（worker 验证引擎 / hub 结论与门控 / 飞书与面板）；协议与迁移已由 7a 冻结，本次未改任何生产源码

---

## 0. 执行摘要（Executive Verdict）

**PASS（无条件通过 Phase 7b 退出门禁）**

- 7b 退出门禁要求的**全部 ID 逐条独立验证通过**：HP-12、VF-1 ~ VF-30、TR-1 ~ TR-9、CR-1 ~ CR-3、CR-7 ~ CR-9、RT-9 ~ RT-13、UX-11 ~ UX-16、BC-9 ~ BC-10、E2E-19 ~ E2E-22，以及 INV-1 ~ INV-15（INV-1~8 用 `assertInvariants`，INV-9~14 用修正版复核器，INV-15 用文件系统全树摘要）。**0 项 FAIL、0 项 SKIP**。
- 四道硬门禁**全绿**：`pnpm -r build`、`pnpm lint`（0 error / 0 warning）、`pnpm depcheck`、`pnpm test`（**90 文件 / 1325 用例：1324 passed · 0 failed · 1 skipped**，唯一的 skip 是基线既有的平台条件用例）。
- **未发现 Phase 7b 生产代码的 P0 / P1 缺陷，也未发现与 08 规格的实质性行为偏离。** 攻击面（环境隔离、验证即代码执行、配置暴露、篡改伪造、Requester 默认关闭、自动修复逃逸）全部按规格封闭。
- 发现 **3 项 P2（测试基础设施缺陷，均在 Codex 的 7a 不变量复核器中）** 与 **3 项 P3（可观测性/边缘语义观察）**，详见 §5。P2 的直接后果是：**7b 门禁要求的「每个集成用例都调用 `assertHarnessInvariants(db)`」在现状下无法对任何 7b 流程成立**（见 §5 P2-1 / P2-2）。Pi 未修改该 7a 帮助文件，而是以独立的修正版复核器 `packages/hub/test/pi/verify-invariants.ts` 完成验收，并把差异、复现方式与修复建议完整交付。
- 附带交付：**4 个独立测试文件 / 105 个用例**（worker 81、hub 验证 14、hub 飞书面板 5、hub 端到端 5）+ 1 个修正版不变量复核器。全部由 Pi 独立编写，未复用 Codex 的 7b 测试断言，也未触碰任何 `packages/*/src/**`。
- **零新增失败**：验收开始前的基线为 `86 文件 / 1220 用例（1219 passed · 0 failed · 1 skipped）`，验收后为 `90 文件 / 1325 用例（1324 passed · 0 failed · 1 skipped）`，新增 4 个文件 + 105 个用例全部通过。

---

## 1. 四门禁指标

| # | 门禁 | 命令 | 结果 | 指标 |
| :-: | :--- | :--- | :-: | :--- |
| 1 | 构建 | `pnpm -r build` | **PASS** | exit 0；protocol / common / hub / worker / mock-cli `tsc -b` + dashboard `vite build` 全绿 |
| 2 | Lint | `pnpm lint` | **PASS** | exit 0；**0 error / 0 warning**（含本次新增 5 个文件） |
| 3 | 依赖边界 | `pnpm depcheck` | **PASS** | exit 0；`no dependency violations found (184 modules, 572 dependencies cruised)` |
| 4 | 测试 | `$env:VITEST_MAX_WORKERS='2'; pnpm test` | **PASS** | exit 0；**90 test files / 1325 tests：1324 passed · 0 failed · 1 skipped**（334s → 374s） |

基线对照：

| 时点 | 文件 | 用例 | passed | failed | skipped |
| :--- | :-: | :-: | :-: | :-: | :-: |
| 验收开始前 | 86 | 1220 | 1219 | 0 | 1 |
| 验收结束后 | 90 | 1325 | 1324 | 0 | 1 |

> 新增用例 = 105（81 + 14 + 5 + 5），与套件增量完全一致；失败集合与基线相同（空集）。

### 1.1 本次新增的测试资产

| 文件 | 用例数 | 覆盖 ID |
| :--- | :-: | :--- |
| `packages/worker/test/phase7b-pi.test.ts` | 81 | VF-1 ~ VF-30、TR-1 ~ TR-9、RT-9、RT-10、RT-11（单元级）、CR-1 ~ CR-3、INV-15 |
| `packages/hub/test/phase7b-pi-verify.test.ts` | 14 | HP-12、VF-4/25/26/27/28/29、VF-11（采纳规则）、BC-9、BC-10、CR-7、CR-9、INV-11、INV-13、INV-14 |
| `packages/hub/test/phase7b-pi-ux.test.ts` | 5 | UX-11 ~ UX-16 |
| `packages/hub/test/phase7b-pi-e2e.test.ts` | 5 | E2E-19 ~ E2E-22、HP-12（真实 Worker）、RT-12 |
| `packages/hub/test/pi/verify-invariants.ts` | — | INV-9 ~ INV-14 的修正版复核器（见 §5 P2） |

### 1.2 测试夹具与独立性的取舍（供审查）

- **Worker 侧**直接驱动 `RunManager`（与 Codex 同层，但自带探针命令、自带 journal 断言），
  「没有启动任何验证进程」一律用 **journal 的 `run.process{role:'verify'}` 记录数**证明，而不是只看有没有 `verify` 事件——这能抓到「事件被吞但进程已跑」的假阴性。
- **Hub 侧**只用 `FakeWorker` + 公开 DTO/DB 读取；不引用生产查询封装做断言。
- **E2E** 使用真实 Hub（`createTestHub`）+ 真实 Worker 子进程（`bin/agent-worker.mjs`）+ `mock-cli`。
- **两处必须知道的 MOCK 陷阱**（已在本轮实际踩到，写入报告避免后人重踩）：
  1. D-BB-9：`mock` 只有在 prompt 首行含 `harness=1` 时才参与 Harness。交接子任务的默认文案（`HANDOFF_DEFAULT_PROMPTS`）不含 `harness=1`，因此测试交接/修复时必须显式传 `form.prompt = '#scenario:… harness=1'`，否则子 Run 根本没有 `harness` 指令（这不是缺陷）。
  2. `run.events` 的 `seq` 必须从 `last_seq + 1` 起严格连续；一旦跳号，Hub 的 IngestQueue 会**整批回滚**且不给 Worker 任何信号（见 §5 P3-2）。本轮的两次「验证结论丢失」都是这个原因造成的（测试侧写错 seq），修好后稳定通过。

---

## 2. 逐 ID 结果表

图例：**PASS(π)** = Pi 新增用例独立断言通过；**PASS(审查)** = 该 ID 由 Codex 的 7b 用例覆盖，Pi 逐行审计其断言非恒真且已被全量测试验证（并在需要处补充了独立断言）；**SKIP** = 按计划归属其它子阶段（本轮无）。

### 2.1 能力协商与 HP-12

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| HP-12 | **PASS(π)** | `phase7b-pi-verify` HP-12：Hub `workers.capabilities=['blackboard.v1']` 时 welcome/`capabilities()` 均为 `[blackboard.v1]`，派发**无 `harness.verify`**，`finished` 无 `verification` → `verification_status IS NULL`（**不**落 `unverified` 兜底），`verification` DTO 缺省，`harnessUnnegotiatedEvents=0`，连接未关闭（无 4400）。`phase7b-pi-e2e` HP-12：**真实 7b Worker** 对 blackboard-only Hub 跑完整任务，`verify` 进程数 0、`runHarness().verification===null`、连接全程 `online`。补充：`phase7b-pi-verify` 的 `downgradeEvent` 表驱动用例逐行验证 §5.5 下转换（`verify→progress{phase:'verify'}`、`finished.verification` 剥离、`harness.manifest` 剥离、`workspace.changes/tamper` 剥离、无 blackboard 时 `harness/workspace→progress`、协商成功时**同一引用**原样返回、`seq/ts` 不变）。 |

### 2.2 本地验证引擎（VF-1 ~ VF-30）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| VF-1 | **PASS(π)** | `VF-1`（23 个 `it.each` + 1 个组合用例）：`cmd/CMD/CMD.EXE/cmD.ExE/powershell/PowerShell.EXE/pwsh(.exe)/bash/BASH.EXE/sh/zsh/dash/fish/ksh/csh/tcsh/wsl(.exe)`、绝对路径解释器（`C:\Windows\System32\cmd.exe`、`…\WindowsPowerShell\v1.0\powershell.exe`、`/bin/bash`、`/usr/bin/sh`）全部 `VERIFY_SHELL_FORBIDDEN`；`./node`、`../node`、`sub/node`、`sub\node`、`.\node.exe`、`node `（尾空格）、` two`、`node:flavour`、空串、含 NUL、单参数 4097、9×4000 超 32 KiB 全部拒绝；`node` / `process.execPath` / `node.exe` 通过。 |
| VF-2 | **PASS(π)** | `VF-2`：裸名与绝对路径 `ready`；不存在的裸名 `missing`；真实 `probe.cmd`（npm shim 形态）解析为 `node <script>`（`prefixArgs` 指向 shim 同目录的 `.js`，命令为 `node(.exe)`）；垃圾 `.cmd` 解析为 `error`（配置问题而非代码失败）。`VF-2/RT-10`：不可解析命令 → `unverified/COMMAND_UNAVAILABLE`、`attempts=1`、结果 `status='unavailable'`、**journal 内 `role:'verify'` 记录为 0**、`finished.errorCode` 缺省。 |
| VF-3 | **PASS(π)** | `VF-3/RT-9`：验证进程内断言 `CI==='1'`、`MARK`（`cmd.env`）生效、`TOKEN_FROM_PROCESS`（`cmd.passEnv`）生效；同时断言**不存在**任何 `ANTHROPIC*`/`OPENAI*`/`GEMINI*`/`GOOGLE_*`/`CLAUDE_*`/`OPENCODE*` 键（adapter env 与进程环境中的 LLM 凭据均未透传）、不存在 `AGENT_WORKER*`、`HUB_*`、`FROM_HUB`。`VF-3`（第二条）：未列入 `allowedEnvOverrideKeys` 的 Hub env 不生效（`FROM_HUB` 缺省）。 |
| VF-4 | **PASS(π)** | `VF-4`（worker）断言事件顺序（`started`→`harness`→`workspace`→`verify.started`→…→`verify.result`→`finished`）、`verification={passed,attempts:1,failed:[]}`、日志前缀 `[verify:check] `、INV-14 关系。`VF-4/VF-25`（hub）断言 `verification='pending'`（派发即置位）→ `running` → `passed`、`tasks.last_progress` 含命令 id、`RunView.harness.verification`、`RunHarnessView.verification.attempts[0]`、owner+passed 自动采纳（`accepted_by='auto'`）与 `assertInvariants`/INV-9~14。 |
| VF-5 | **PASS(π)** | `VF-5/24`：首条 `exit 2` → `failed`、后续 `not_run`、`tail` 含 `boom`、**已脱敏**（`LEAK_ME` 的合成密钥不出现在 `tail`/事件 JSON/本地 `output.log`）、`finished.status='succeeded'` 且无 `errorCode`（INV-11 语义）。 |
| VF-6 | **PASS(π)** | `VF-6`：`failFast:false` 时 3 条命令全部执行（`passed/failed/passed`），`failed=['b']`。 |
| VF-7 | **PASS(π)** | `VF-7`：命令自带 `timeoutMs=1500` + 派生进程树 → 事件 `status='timed_out'`，**进程树（父 + 子）在 15s 内全部消失**，`finished.status='succeeded'`、`verification.status='failed'`。 |
| VF-8 | **PASS(π)** | `VF-8`：Run `timeoutMs=300000` 耗尽 → `unverified/BUDGET_EXHAUSTED`、`finished.status='succeeded'`、`errorCode` 缺省、`verify` 事件 `status='aborted'`、进程树被杀。 |
| VF-9 | **PASS(π)** | `VF-9`：验证期间 `cancel` → `finished.status='succeeded'` + `unverified/CANCELLED`，进程树终止（Hub 侧 `cancelling→succeeded` 由 02 既有单元格保证，未被改动）。 |
| VF-10 | **PASS(π)** | `VF-10`：验证期间 `cancelAll()`（Worker 关机）→ `unverified/WORKER_SHUTDOWN`，进程树终止。 |
| VF-11 | **PASS(π)** | worker：`ops=[]` → `skipped/NO_CHANGES`、`attempts=0`、无 `verify` 事件、无验证进程。hub：`VF-11` 四段链（R1 passed→采纳 seq1；R2 `NO_CHANGES` 且 `predecessorAccepted` → **采纳** seq2；R3 failed → 不采纳；R4 `NO_CHANGES` 但前驱未被采纳（`lastAcceptedSeq=2 ≠ 3`）→ **不采纳**），指针 `lastAcceptedRunId` 逐步断言。 |
| VF-12 | **PASS(π)** | `VF-11/VF-12`：只写 `.board/HANDOFF.md` → `boardOnly=true` → `skipped/NO_CHANGES`、`attempts=0`、无验证进程、命令未执行（哨兵文件不存在）。 |
| VF-13 | **PASS(π)** | `VF-13/RT-10`：未配置命令 → `skipped/NO_COMMANDS`、`applied.verify=false`、降级 `{field:'verify',reason:'NO_COMMANDS'}`、journal 内 `role:'verify'` 记录 0、无 `verify` 事件。 |
| VF-14 | **PASS(π)** | `VF-14`：`configExposed` → `skipped/CONFIG_EXPOSED`、降级原因 `CONFIG_EXPOSED`、**黑板不受影响**（`applied.board='write'`）、验证进程 0、探针文件未被写入。 |
| VF-15 | **PASS(π)** | `VF-15`：CLI 失败（`scenario fail`）→ 任务 `failed`、`skipped/CLI_NOT_SUCCEEDED`、验证进程 0。 |
| VF-16 | **PASS(π)** | `VF-16/19`：`autoFixMaxRetries=1` + `fixOps` 修复 → 2 次尝试、`autoFix={attempts:1,stoppedBy:'PASSED'}`、`workspace` round `[0,1]`、`verify` attempt `[1,2]`、`summary`/`cliSessionId` 取最后 0 退出轮、`usage` 跨轮求和（`inputTokens 5+5=10`、`outputTokens 0+1=1`）。hub `VF-4/25`/E2E-20 同步复核。 |
| VF-17 | **PASS(π)** | `VF-17`：`retries=2` 恒失败 → `failed` + `autoFix={attempts:2,stoppedBy:'MAX_RETRIES'}`、`attempts=3`、round `[0,1,2]`。 |
| VF-18 | **PASS(π)** | `VF-18`：`timeoutMs=60000` 剩余预算 < `max(120s,0.2×timeoutMs)` → 不进入修复轮，结论保持上一次 `failed`、`autoFix={attempts:0,stoppedBy:'BUDGET'}`、round `[0]`。 |
| VF-19 | **PASS(π)** | `VF-16/19`（同一用例）：修复轮 prompt 含 `mode="autofix"`、`AUTOFIX 1/1`；另 Codex 的 resume/non-resume 对照用例（审计通过：非 resume → 完整前导 + 重新读取的黑板快照；resume → 紧凑前导且不注入黑板正文）。 |
| VF-20 | **PASS(π)** | `VF-20`：恶意 Hub 在 `trust=requester` 时请求 `autoFixMaxRetries=2`（本机上限也是 2）→ `applied.autoFixMaxRetries=0`、round `[0]`、`attempts=1`、无 `autoFix` 字段（Requester 永不自动修复，双保险在 worker 侧独立成立）。`VF-20b`：Hub 请求 2 / 本机 0 → 0；本机 1 → 1 且 `MAX_RETRIES`（D-7 本机上限）。hub 侧 `UX-15` 复核 Requester 派发恒为 `autoFixMaxRetries:0`。 |
| VF-21 | **PASS(π)** | `VF-21`：只写 `node_modules/pkg/index.js` / `dist/bundle.js` → `NO_CHANGES`（默认排除目录不扫描）；写 `.github/workflows/ci.yml` → `TAMPER_RISK` 且 `tamper.paths` 含该路径。 |
| VF-22 | **PASS(π)** | `VF-22/TR-6`（清单级）：敏感文件仅 mtime 变化 → `total=0`；内容变化 + `utimes` 还原 mtime（同 size）→ 靠 `sha256` 判 `modified` 且 `tamper` 命中；size 变化 → `modified`；Windows 上仅大小写改名（`Readme.txt`→`README.txt`）→ `total=0`（小写比较键 + rename 保 mtime），POSIX 上为 `2`。另审计 Codex 的「新建链接 → `link`」用例。 |
| VF-23 | **PASS(π)** | `VF-23`：`maxFiles=1000`，修复轮创建 1000 个文件 → Post 清单截断 → `unverified/MANIFEST_INCOMPLETE` + `autoFix={attempts:1,stoppedBy:'MANIFEST_INCOMPLETE'}`、`changes.truncated=true`、只有 1 次验证尝试。 |
| VF-24 | **PASS(π)** | `VF-5/24`：假密钥（`cmd.env` 注入的 20+ 字符）在 `tail`、完整事件 JSON 与 `output.log` 中均被脱敏；成功/失败行都带 `[verify:<id>] ` 前缀。 |
| VF-25 | **PASS(π)** | `VF-4/VF-25`（hub）：`verify{started}` → `verification_status='running'` + `tasks.last_progress` 含命令 id；`verify{result}` 写入 attempts；`finished` 写入结论；`RunHarnessView.verification.attempts` 含 `commands/status/results`。`INV-13/INV-14` 用例断言 `attempts=[1,2]` 与最后一次 attempt = 最后 round+1。 |
| VF-26 | **PASS(π)** | `VF-26`（hub，两条）：`finished` 缺 `verification` → `unverified/INTERNAL`；带 `errorCode='WORKER_RESTARTED'` → `unverified/WORKER_RESTARTED`；两种情况均**不自动采纳**，`RunHarnessView.verification.outcome` 与 INV 复核一致。 |
| VF-27 | **PASS(π)** | `VF-27/CR-8`：`gracePeriodMs=100`，验证进行中断链 → `verification_status='unverified'`、`outcome.reason='RUN_LOST'`、审计 `task.harness.verification` **恰好 1 条**、指针未采纳。（审计 Codex 的 `dispatching` 阶段 `DISPATCH_LOST` 变体亦通过。） |
| VF-28 | **PASS(π)** | `VF-28`：13 行规格表逐条断言 + fast-check 300 组属性对拍（trust/readonly/runStatus/verificationRequested/outcome/predecessorAccepted 全组合与 08 §8.5.3 参考实现逐点一致）。 |
| VF-29 | **PASS(π)** | `VF-29`：Requester（覆写开启验证）验证失败且 `requesterReplyPolicy='auto'` → `result_delivery_status='pending_review'`、`harness_json.gated='VERIFICATION'`、审计 `task.harness.result_gated`、指针未采纳、INV 复核通过。（审计 Codex 的 `MANIFEST_INCOMPLETE`/`TAMPER_RISK`/`CONFIG_EXPOSED` 门控矩阵。） |
| VF-30 | **PASS(π)** | `VF-30`：只读 Run 修改 `src/app.ts`（并顺带写 `.board/LESSONS.md`）→ `readonlyCheck='violation'`、`readonlyPaths` 含 `src/app.ts`、任务仍 `succeeded`。 |

### 2.3 篡改风险（TR-1 ~ TR-9）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| TR-1 | **PASS(π)** | 19 个 `it.each` 覆盖 `**`（含零段）、`*`、`?`、`{a,b}`、根级限定（`AGENTS.md` 不匹配 `docs/AGENTS.md`）、`**/X` 匹配根、`**/*.config.*`、`**/tsconfig*.json`、`.github/**`、`**/package.json`（含 `node_modules/x/package.json`）；另有 Windows 折叠（`AGENTS.MD`）与 POSIX 精确匹配对照。 |
| TR-2 | **PASS(π)** | `TR-2`：改 `package.json` → `skipped/TAMPER_RISK`、`attempts=0`、**journal 内 `role:'verify'` 记录 0**、无 `verify` 事件、哨兵文件未创建、`tamper.paths=['package.json']`。E2E-21 用真实 Worker 复核同一结论（`verify` 进程数前后不变）。 |
| TR-3 | **PASS(π)** | `TR-3`：一次运行同时改 `vitest.config.ts`、`tsconfig.json`、`.github/workflows/ci.yml`、`AGENTS.md`、`pnpm-lock.yaml`、`docs/AGENTS.md` → 全部出现在 `tamper.paths`、结论 `TAMPER_RISK`、验证进程 0。 |
| TR-4 | **PASS(π)** | `TR-4`：改 `.board/HANDOFF.md`/`LESSONS.md`/`DECISIONS.md`（Pre 已有 `PROJECT_STATE.md`）→ 无 `tamper` 字段、结论 `NO_CHANGES`（`.board/**` 永不参与敏感匹配）。 |
| TR-5 | **PASS(π)** | `TR-5`：`argv=[node, scripts/verify.mjs]`，Pre 已有脚本、Run 中改写 → `TAMPER_RISK`、`paths` 含 `scripts/verify.mjs`、验证进程 0（argv 引用文件自动进入敏感集合）。 |
| TR-6 | **PASS(π)** | `VF-22/TR-6`：`package.json` 内容变化后 `utimes` 还原 mtime（大小相同）→ 仍由 `sha256` 判定 `modified` + `tamper`。 |
| TR-7 | **PASS(π)**（Windows） | `TR-7`：在 `vendor/alias` 新建指向 `vendor/real` 的联接点 → `TAMPER_RISK`、`tamper.links=1`、`paths` 含 `vendor/alias`（任意目录的链接变化都计入）。 |
| TR-8 | **PASS(π)** | `TR-8`：`extraPaths:['local.settings']` → 改该文件触发；`replaceDefaults:true` 时改 `package.json` **不再**触发（结论正常 `passed`、无 `tamper`），而改 `extraPaths` 内文件仍触发（并集/替换语义正确）。 |
| TR-9 | **PASS(π)** | `TR-9`：round 0 验证失败、修复轮写 `tsconfig.json` → 结论 `skipped/TAMPER_RISK`、`autoFix={attempts:1,stoppedBy:'TAMPER_RISK'}`、`failed=[]`（**不**报告上一尝试的 `failed`），round 仍为 `[0,1]`。 |

### 2.4 崩溃与恢复（CR-1 ~ CR-3、CR-7 ~ CR-9）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| CR-1 | **PASS(π)** | `CR-1`（journal）：`accepted` + `progress(7)` + `process(cli)` + `cli_exited{round:0,succeeded,verifyRequested:true}` 后恢复 → 合成 `finished{seq:8,status:'succeeded',verification:{unverified,WORKER_RESTARTED,attempts:0}}` 且**无** `errorCode`。`CR-1b`：`cli_exited{status:'failed'}` → 合成 `failed` + `NONZERO_EXIT` + `skipped/CLI_NOT_SUCCEEDED`（不被改写为 `WORKER_RESTARTED`）。E2E-22 用真实 Worker 复核「验证中崩溃 → 重启」的端到端形态。 |
| CR-2 | **PASS(π)**（Windows） | `CR-2`：真实 detach 子进程 + journal `run.process{role:'verify',pid,pidStartTime}` → 新 `Journal.recover()` 按 pid+启动时间清理孤儿树（10s 内确认死亡）；**同代 pidStartTime 不匹配的旁证进程不被误杀**。E2E-22 用真实 Worker + 真实验证树复核整棵树消失。 |
| CR-3 | **PASS(π)** | `CR-3`：`cli_exited(round0 succeeded)` + `cli_exited(round1 failed)` → 合成 `succeeded` + 最后 0 退出轮的 `summary`/`cliSessionId`、`usage` 跨轮求和、`verification={unverified,WORKER_RESTARTED,attempts:1}`。 |
| CR-7 | **PASS(π)** | `CR-7`：验证期间断链 → 带 `runs:[{state:'running',lastSeq:5}]` 重连并补发 `verify{result}` + `finished` → 最终 `verification_status='passed'`、`attempts=[passed]`、审计 `task.harness.verification` 恰好 1 条、INV-1~14 全成立。（审计 Codex 的真实 Worker + ChaosProxy + Hub 重启复通用例，同样通过。） |
| CR-8 | **PASS(π)** | `VF-27/CR-8`（宽限期外，`gracePeriodMs=100`，`running`/`dispatching` 两种阶段）→ `RUN_LOST → unverified/RUN_LOST`、审计 1 条、不采纳。（宽限期内续传完整由 CR-7 覆盖。） |
| CR-9 | **PASS(π)** | `CR-9`：由真实 `Journal` 产出的 7b `finished`（含 `verification`）→ 冻结的 Phase 6 字段表 `assertPhase6Event` **抛错 `/verification/`**；删除该字段后同一对象即可通过（证明拒绝只来自新增字段）。E2E-22 在真实 Worker journal 上复核同一结论。 |

### 2.5 红队（RT-9 ~ RT-13）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| RT-9 | **PASS(π)** | `VF-3/RT-9`：验证命令主动 dump `process.env` 的键集 → 无任何 LLM 凭据键、无 `AGENT_WORKER_*`、无 `HUB_*`、无 Hub 下发的 `FROM_HUB`；`CI=1` 强制存在；`cmd.env`/`cmd.passEnv` 的显式变量按规格生效。 |
| RT-10 | **PASS(π)** | `VF-13/RT-10`：恶意 Hub 对没有命令的工作区请求验证 → `skipped/NO_COMMANDS`、**journal 中 `role:'verify'` 记录 0**、无 `verify` 事件、无哨兵文件。 |
| RT-11 | **PASS(π/审查)** | π：`RT-11` 在配置层直接攻击 `loadWorkerReload`——`worker.yaml` 位于工作区内（`configExposed=true`）时，(a) 给**另一个**工作区新增 `verify.commands` → 回调收到 `blocked('other')` 且该工作区 `verify.commands` 保持 `[]`；(b) 改写暴露工作区自己的命令 → `blocked('repo')` 且命令逐字保留；(c) 改 `label` 等非验证字段 → 正常生效且无告警。审查：Codex 的 E2E `RT-11` 在真实 Worker 上验证 `VERIFY_CONFIG_RELOAD_BLOCKED` 告警与旧配置保留（通过）。 |
| RT-12 | **PASS(π)** | `phase7b-pi-e2e` RT-12（真实 Worker）：Requester 任务默认（无覆写）→ `done.verification` 缺省、`run.harness.verify` 缺省、**`role:'verify'` 记录 0**、`RunHarnessView.verification===null`、指针未被采纳。 |
| RT-13 | **PASS(审查)** | 文档化残余风险成立：Codex 的 `RT-13` 用例把测试改写成恒真后验证仍 `passed`，并断言 manifest diff 里能看到 `example.test.cjs`（审计通过）。Pi 的 E2E-20/21 同样断言 `changes.sample` 暴露改动路径（审计/面板可见性）。 |

### 2.6 飞书与面板（UX-11 ~ UX-16）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| UX-11 | **PASS(π)** | `UX-11`：终态验证失败卡片含 `[带报错修复]` 与 `[换 CLI 修复]`；点击 `a:'fix'`（无 `cli` 表单）→ 子任务 `handoff_from_run_id` 正确、派发 `adapter=mock`、**`resume` 复用捕获的会话**、`inject='resume'`、`facts.handoff.intent='fix'` 且 `facts.handoff.from.runId` 指向源 Run。 |
| UX-12 | **PASS(π)** | `UX-12`：表单 `[换 CLI 修复]`（`form.cli='codex'`）→ 子任务 `adapter='codex'`、**`resume` 缺省（新会话）**、`inject='handoff'`、`facts.handoff.from.verificationDetail.status='failed'`（完整注入 + 失败细节）。 |
| UX-13 | **PASS(π)** | `UX-13/UX-16`：`extractProgress` 对同一 `verify` 事件在 owner 下产出 `验证 #2：unit、lint` / `验证 #2 未通过：unit`，在 requester 下两者都是 `正在进行自动验证`（不泄露命令 id）。 |
| UX-14 | **PASS(π)** | `UX-14`（Playwright + 真实 dashboard dist）：`verification-panel` 徽章 `已跳过验证` → `验证失败`；`Pipeline` 卡片 `task-card-<n>` 上的 `verification-badge` 同步；面板渲染 `TAMPER_RISK · N 个路径` 与具体路径（`package.json`、`vitest.config.ts`）、`自动修复 0 次 · TAMPER_RISK` / `自动修复 1 次 · MAX_RETRIES`、失败 tail（`expected 2`）；两个修复入口 `verification-fix-same`/`verification-fix-switch` 在 `failed` 时可见、在 `TAMPER_RISK` 时不出现（与 `VerificationPanel` 的 `allowFix && state==='failed'` 一致）。 |
| UX-15 | **PASS(π)** | `UX-15`：审批卡片选择 `board_verify` → `tasks.harness_request_json.overrides={blackboard:true,verify:true}`、派发 `harness={trust:'requester',board:'write',verify:{autoFixMaxRetries:0}}`；对照任务不选覆写 → 派发无 `harness.verify`、`verification` DTO 缺省（Requester 验证默认关闭端到端成立）。 |
| UX-16 | **PASS(π)** | `UX-13/UX-16`：`verify{started}` 后卡片被 patch 成含 `⏳ 验证中`；`finished(passed)` 后同一 `message_id` 被 patch 成含 `✅ 验证通过` 且不再含 `⏳ 验证中`（patch 节流下最终一致）。 |

### 2.7 向后兼容（BC-9 ~ BC-10）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| BC-9 | **PASS(π)** | `BC-9/BC-10` + `HP-12`：7b Worker ↔ 7a Hub（`capabilities=['blackboard.v1']`）：真实 Worker 与 FakeWorker 两条路径都**不请求验证、无 verify 事件、无 4400**；7a Worker（只发 `blackboard.v1` 头）↔ 7b Hub：`welcome.capabilities=['blackboard.v1']`、派发无 `harness.verify`、连接保持。 |
| BC-10 | **PASS(π)** | `BC-9/BC-10`：热更新 `workers.capabilities=['blackboard.v1']` 后重连 → 新连接 `capabilities=['blackboard.v1']`、新派发无 `verify`；**已有数据仍可读**（`RunHarnessView.verification.outcome.status='passed'`、`verification_status='passed'`）。 |

### 2.8 端到端（E2E-19 ~ E2E-22）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| E2E-19 | **PASS(π)** | 真实 Hub + 真实 Worker：写入 → 验证失败（任务 `succeeded`，`verification=failed`，指针**未**推进）→ Owner 卡片 `[带报错修复]` → 子 Run `passed` 且被**自动采纳**（`lastAccepted.runId=child`），`facts.handoff.from` 含 `verification='failed'`、`changes={source:'manifest',paths:['src.txt']}`、`verificationDetail.failed[{id:'check',exitCode:2,tail:'expected fixed'}]`。 |
| E2E-20 | **PASS(π)** | 真实 Worker + `autoFixMaxRetries=1`：单个 Run 内两次尝试 `[failed,passed]`、`autoFix={attempts:1,stoppedBy:'PASSED'}`、`board.postRound=1`、`role:'verify'` 记录恰好 2 条、自动采纳。 |
| E2E-21 | **PASS(π)** | 真实 Worker：改 `package.json` → `verification.attempts=[]` + `outcome.skipped/TAMPER_RISK`、`tamper.paths` 命中、**验证进程数不变**（一条都没起）、指针停留在此前通过的 Run；随后 Owner 手动 `acceptRun` 成功（`acceptedBy=owner.id`）。 |
| E2E-22 | **PASS(π)** | 真实 Worker 验证中（派生进程树）被杀 → 重启后 `succeeded + unverified/WORKER_RESTARTED`（`attempts=1`），journal 终态 `finished` 被冻结的 Phase 6 字段表拒绝（CR-9），指针未采纳，**孤儿进程树（父+子）在 20s 内全部消失**。 |

### 2.9 不变量（INV-1 ~ INV-15）

| ID | 结果 | 证据 / 断言要点 |
| :--- | :-: | :--- |
| INV-1 ~ INV-8 | **PASS(π)** | 每个 hub 集成/E2E 用例结束都调用 `assertInvariants(db)`（阶段 6 复核器，未改动），全部通过。 |
| INV-9 | **PASS(π)** | `verify-invariants` 在每个 hub 用例中复核：`attempt_counter` = 已受理写入型 Run 数、`last_attempt_seq` = 最大 `workspace_seq`、`last_accepted_seq ≤ last_attempt_seq`、无重复 seq。 |
| INV-10 | **PASS(π)** | 同上（**从 `verification_json.outcome` 重建结论**后重算 `autoAcceptDecision`）：`accepted_by='auto'` 的 Run 全部满足 `accept=true`（含 `passed` 与 `NO_CHANGES`+前驱已采纳两种）。 |
| INV-11 | **PASS(π)** | `INV-11`（hub）：同一事件流分别在「带 verify 事件 + `finished.verification`」与「去掉两者」的 Hub 上重放 → 任务 `status` 与 `version` **完全相同**。修正版复核器对「已收到 `finished`」的失败/未验证 Run 追加断言 `task.status='succeeded'`（`RUN_LOST` 场景按 08 §8.4.2 不适用，见 §5 P2-2）。 |
| INV-12 | **PASS(π)** | 修正版复核器扫描 `task_logs` 的 `harness/workspace/verify` 行，断言不存在 `board.files[].content`（真实 Worker E2E-19/20/21/22 与 FakeWorker 流程均通过）。 |
| INV-13 | **PASS(π)** | `INV-13/INV-14`：`verification_status='running'` 期间同工作区第二个写入型任务 400ms 内**未**收到 `run.dispatch`（写锁持有到 `finished`），且复核器断言 `running|cancelling` 之外无其他活动写入型 Run。 |
| INV-14 | **PASS(π)** | `INV-13/INV-14`：修复链 `verify result attempt=2` 等于最后 `workspace` 事件 `round=1` + 1；复核器对所有 `passed/failed` Run 逐条检查（含 E2E-20 的真实修复轮）。 |
| INV-15 | **PASS(π)** | `INV-15`：完整 prepare→verify→autofix（2 轮）流程前后对整个工作区做递归 `{path,size,mtime}` 摘要对比，唯一差异来自 mock CLI 子进程写入的 `src.txt`；Worker 未创建（含 `.board/`）、未修改、未删除任何路径。 |

---

## 3. 安全攻击面复核（要点）

| 攻击 | 结果 | 依据 |
| :--- | :--- | :--- |
| 经解释器重新引入 shell 字符串语义 | 封闭 | VF-1：23 种解释器（含绝对路径、大小写变体）全拒；`resolveVerifyCommand` 只做 PATH/绝对路径解析，`spawn` 恒 `shell:false` |
| 验证进程窃取 LLM/Worker/Hub 凭据 | 封闭 | VF-3/RT-9：adapter `passEnv`、`AGENT_WORKER_*`、`HUB_*`、未白名单的 Hub env 全部不进验证进程 |
| 伪造「验证通过」（改清单/改配置/改脚本） | 封闭 | TR-2/3/5/6/8 + VF-22：敏感集合、argv 引用文件、哈希优先；篡改即关闭（不跑命令、不采纳、Requester 门控） |
| 用链接/联接点绕过 | 封闭 | TR-7 + BB-8/9（7a）：扫描范围任意链接变化 → `TAMPER_RISK`；黑板读取拒绝链接/硬链接 |
| 借自动修复无限消耗或绕过门控 | 封闭 | VF-17/18/20/20b/TR-9：`MAX_RETRIES`/`BUDGET`/`TAMPER_RISK`/`MANIFEST_INCOMPLETE` 四种停止条件 + Requester 恒 0 次 |
| 改写暴露的 `worker.yaml` 给其他工作区加命令 | 封闭 | RT-11：验证段热重载在 `exposureSeen` 下对所有工作区冻结，命令从未执行 |
| Requester 借验证执行任意代码 | 封闭（默认） | RT-12/UX-15：Requester 验证默认关闭，需 Owner 显式覆写；覆写后仍 0 次自动修复、不注入黑板、不自动采纳 |
| 版本错配导致 4400 / 验证结论丢失 | 封闭 | HP-12/BC-9/BC-10 + `downgradeEvent` 表驱动：能力缺失时新帧全部下转换为 Phase 6 形态，`seq/ts` 不变 |
| 崩溃/断网留下孤儿验证进程 | 封闭 | CR-2 + E2E-22：`run.process{role:'verify',pid,pidStartTime}` + 启动时间校验 → 只杀自己的树 |

---

## 4. 与基线的一致性

| 检查 | 结果 |
| :--- | :--- |
| Phase 0–6 既有用例 | 全部通过（未修改任何既有测试或生产代码） |
| 新增依赖 / 新帧类型 / 新子协议 | 无（`pnpm depcheck` 184 modules / 572 deps 不变） |
| `docs/specs/02` 状态机矩阵 | 未触碰（INV-11 用例证明验证结论不影响 `TaskStatus`） |
| 生产源码改动 | **零**（`packages/*/src/**` 与 `packages/*/bin/**` 未修改；仅新增测试文件） |

---

## 5. 缺陷与观察

### P0（必须阻断）：无

### P1（应修复后再发布）：无

### P2（测试基础设施缺陷，影响 7b 门禁的可执行性）

**P2-1 · `assertHarnessInvariants` 的 INV-10 无法重建验证结论 → 所有「请求了验证且被自动采纳」的 7b Run 都被误报违规**

- 位置：`packages/hub/test/pi/invariants.ts:114-117`
- 现象：`autoAcceptDecision({ … verificationRequested: !!record?.directive?.verify })` 只读 `harness_json.directive.verify`，**从不读取 `verification_json.outcome`**，于是 `verification` 恒为 `undefined` → `decision.accept === false`、`reason === 'MISSING'`。
- 影响：7b 退出门禁要求「所有 I/E 用例结束时调用 `assertHarnessInvariants(db)`」，但现状下**任何**自动采纳的 7b 流程都无法通过它（包括 `passed`）。这也是该缺陷至今未被发现的原因：该复核器只在 7a 流程（`phase7-pi-hub`、`phase7-pi-gateway`，`verificationRequested=false`）里被调用过，从未被 7b 数据触及。
- 复现：把 `packages/hub/test/phase7b-pi-verify.test.ts` 中 `VF-4/VF-25` 用例的 `assertVerificationInvariants(db)` 换回 `assertHarnessInvariants(db)`，得到：
  `Error: INV-10: pi-vf4/sandbox auto-accepted run run_… but autoAcceptDecision says MISSING`
- 修复建议（一行级）：读 `run.verification_json` 的 `outcome` 并传入 `autoAcceptDecision({ …, ...(outcome && { verification: outcome }) })`。
- Pi 的处理：未修改该 7a 帮助文件，改为交付修正版 `packages/hub/test/pi/verify-invariants.ts`（同样「只读 DB + 原生 SQL」），并在 7b 的全部 hub 集成/端到端用例中调用（纯单元/属性用例除外：`VF-28` 属性对拍、`downgradeEvent` 表驱动、CR-9 形态断言）。

**P2-2 · `assertHarnessInvariants` 的 INV-11 把 `RUN_LOST` 场景误判为违规**

- 位置：`packages/hub/test/pi/invariants.ts:121-128`
- 现象：规则为「`verification_status ∈ {failed, unverified}` ⇒ 任务状态必须 ∈ {`succeeded`, `running`, `cancelling`}」，但 08 §8.4.2 明确规定 `RUN_LOST`/`DISPATCH_LOST` 时把 `pending|running` 的验证置为 `unverified(RUN_LOST)`，而任务此时会走 `lost` 路径变成 `failed`。两者叠加即恒违规。
- 影响：任何覆盖 `RUN_LOST` 的 7b 用例都无法调用该复核器；且该规则与 INV-11 原文（"去掉 verify 事件后重放，任务状态与 version 序列完全相同"）不等价——它把「验证结论造成状态变化」与「丢失去造成状态变化」混为一谈。
- 复现：把 `VF-27/CR-8` 用例的 `assertVerificationInvariants(db)` 换回 `assertHarnessInvariants(db)`：
  `Error: INV-11: run run_… verification=unverified changed task status to failed`
- 修复建议：仅对「该 Run 已收到 `finished`」（`task_logs` 中存在 `kind='finished'`）的 Run 应用该断言；或直接实现规格原文的重放对拍（Pi 的 `INV-11` 用例即此形态）。

**P2-3 · 7b 门禁的「每个 I/E 用例都调用不变量复核器」实际上从未被执行**

- 现象：`grep assertHarnessInvariants` 只命中 `hub/test/phase7-pi-hub.test.ts`（11 处）、`hub/test/phase7-pi-gateway.test.ts`（4 处）与定义处；**所有 7b 用例（Codex 的 `phase7b-*.test.ts` 与新增 Pi 用例）都没有调用**。
- 影响：INV-9 ~ INV-14 在 7b 阶段处于「有复核器、无执行」的状态，导致 P2-1 / P2-2 两个缺陷长期潜伏。
- 修复建议：先修 P2-1 / P2-2，再把 `assertHarnessInvariants` 加进全部 7b 的 I/E 用例（或直接采用 `verify-invariants.ts`）。

### P3（观察 / 边缘语义，不阻断）

**P3-1 · 验证尝试的 reason 优先级与 08 §7.5 表格顺序不一致（极窄场景）**

- 位置：`packages/worker/src/harness/verify-runner.ts:128`
  `const reason = aborted ?? (results.some(r => r.status === 'unavailable') ? 'COMMAND_UNAVAILABLE' : undefined)`
- 规格 §7.5 的顺序是 #7 `unavailable → COMMAND_UNAVAILABLE` 先于 #8 `aborted`，实现却是 `aborted` 优先。
- 可达条件：同一次尝试里既有 `unavailable` 命令、又在后续命令上耗尽预算/被取消（如 `failFast:false`，第一条不可解析、第二条长跑被预算中止）。此时结论为 `unverified/BUDGET_EXHAUSTED` 而非 `unverified/COMMAND_UNAVAILABLE`。
- 影响：仅错误分类（两者都不采纳、都要求修复），但会影响值班判断（配置问题 vs 预算问题）。建议交换两者优先级或显式在规格里说明。

**P3-2 · 非连续 `run.events` 会静默吞掉整批事件**

- 位置：`packages/hub/src/plugins/store-sqlite/ingest-queue.ts:132`（`throw new Error('Non-contiguous run events')`）
- 现象：该抛错发生在 `store.tx` 内，事务回滚后 `job.reject()`，但**网关既不回帧也不计数**，Worker 侧看不到任何异常；若同一 flush 批次里还夹着别的 Run 的 job，也会一起回滚。本轮 QA 中两次「验证结论丢失」都是这个机制造成的（测试写错 seq，随后静默回滚）。
- 说明：该行为属 Phase 2 既有实现，不是 7b 回归；但 7b 的验证结论恰好是最经不起静默丢失的数据。建议增加指标（例如 `eventsRejectedNonContiguousTotal`）与审计，或在网关日志中明确告警。

**P3-3 · 断言口径提示（给后续 QA）**

- `packages/hub/test/pi/invariants.ts` 的 INV-10/INV-11 与 7b 语义不兼容（P2-1/P2-2）；在修好之前，请用 `packages/hub/test/pi/verify-invariants.ts` 作为 7b 的不变量口径（它同样只读 DB、只用原生 SQL，且对 `RUN_LOST` 与 `verification_json` 做了正确处理）。
- 交接/修复的 mock 子任务必须显式给 `harness=1` 的 prompt，否则子 Run 不带 `harness`（D-BB-9），相关断言会「假通过」为「没有 harness 也没有报错」。

---

## 6. 残余风险（已文档化，非缺陷）

| 风险 | 说明 | 依据 |
| :--- | :--- | :--- |
| 弱化测试（断言改成恒真）不属 `TAMPER_RISK` | 由 Owner 审阅 + 前导 R6 约束；diff 路径在审计/面板可见 | 08 §11.2 T17、RT-13 |
| 敏感文件 > 8 MiB 只记 size/mtime（不算哈希） | 规格 §7.2 的既定上限 | VF-22 覆盖 ≤8 MiB 路径 |
| 被排除目录（`node_modules`/`dist`/…）内的敏感文件不受保护 | 规格 §7.2 明确「已知限制」 | VF-21 |
| 带外（非本系统任务）改动不在本期检测范围 | 规格 §0.2 | E2E/穿插检测只覆盖经 Hub 受理的写入型 Run |
| 验证是「可执行代码」而非 OS 沙箱 | Requester 验证默认关闭 + Owner 显式覆写；建议对外工作区用低权限 Worker | 08 §11.2 T18 |

---

## 7. 复现方式

```powershell
# 四道门禁（本报告数据来源）
cd E:\Agent工作流
pnpm -r build
pnpm lint
pnpm depcheck
$env:VITEST_MAX_WORKERS='2'; pnpm test

# 仅跑本次新增的独立验收套件（105 用例）
$env:VITEST_MAX_WORKERS='2'
pnpm vitest run packages/worker/test/phase7b-pi.test.ts
pnpm vitest run packages/hub/test/phase7b-pi-verify.test.ts
pnpm vitest run packages/hub/test/phase7b-pi-ux.test.ts
pnpm vitest run packages/hub/test/phase7b-pi-e2e.test.ts

# 复现 P2-1 / P2-2：把用例里的 assertVerificationInvariants 换回 assertHarnessInvariants
pnpm vitest run packages/hub/test/phase7b-pi-verify.test.ts -t 'VF-4/VF-25'
pnpm vitest run packages/hub/test/phase7b-pi-verify.test.ts -t 'VF-27/CR-8'
```

---

## 8. 卫生声明（Hygiene）

- **未修改任何生产源码**（`packages/*/src/**`、`packages/*/bin/**`、`worker.yaml` 示例、迁移脚本）。
- **未修改/覆盖任何既有 Phase 6 / 7a 测试或夹具**（`packages/hub/test/pi/phase6.ts`、`phase7.ts`、`frozen.ts`、`invariants.ts`、`harness.ts`、`feishu.ts` 全部原样；Codex 的 `phase7b-*.test.ts` 亦未改动）。
- 仅新增：4 个 `*.pi.test.ts` 验收套件 + 1 个修正版不变量复核器 `packages/hub/test/pi/verify-invariants.ts` + 本报告。
- 临时调试文件（`zz-dbg*.test.ts`、`tmp-*.mjs`、`test-*.log`）已全部删除；工作区无残留。
