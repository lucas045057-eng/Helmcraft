# Pi 独立验收报告 · Phase 3（真实 CLI 适配器 + Windows 常驻与诊断命令）

> 验收人：Pi（独立测试工程师） · 工作区：`E:\Agent工作流`
> 依据：`docs/handoff/pi-test-matrix.md`（§7 `AD-1`~`AD-8`、§8 `WIN-6`~`WIN-12`、§16 Phase 3 门禁）、规格 `docs/specs/06-worker-adapters-security.md`
> 基线：工作区非 git 仓库，以当前文件树为准。**本轮未修改任何业务实现代码**。

---

## 0. 结论

**Phase 3 门禁：通过（无 P0 / 无 P1）**。4 条 P2/P3 观察项见 §4，均不阻塞放行。

| 项目 | 结果 |
| :--- | :--- |
| `pnpm -r build` | ✅ 通过（6 包全量增量构建） |
| `pnpm lint` | ✅ 通过（0 error / 0 warning） |
| `pnpm depcheck` | ✅ 通过（120 modules / 329 dependencies，no violations） |
| `pnpm test` | ✅ **40 files / 751 passed / 1 skipped** |
| 新增 `*.pi.test.ts` | **3 文件 / 68 用例**，全部通过 |
| 新增测试文件类型检查 | ✅ `tsc --noEmit`（继承 `tsconfig.base.json` + `rewriteRelativeImportExtensions`）**0 error** |

唯一 skip 是 Phase 2 已有的 POSIX 专属用例（`packages/worker/test/process.test.ts › terminates an independent POSIX process group`），在 Windows 上按设计跳过，与本轮无关。

**关键结论**：Codex 交付的实现与规格一致，且与**本机实采 CLI 基线**一致——`codex-cli 0.166.0` 的 `exec resume` 子命令确实没有 `--sandbox` / `-C`，用 `-c sandbox_mode=...` 覆写是**唯一正确**做法（本报告 §3.1 用实采 `--help` 反向证明了这一点）；Gemini/opencode 二进制不在本机，其权限 flag 与 env 变量名只能按规格静态核对（见 §4 未验证项）。

### 本轮新增测试文件

| 文件 | 用例数 | 覆盖 |
| :--- | :--- | :--- |
| `packages/worker/test/phase3-adapters.pi.test.ts` | 55 | AD-1 ~ AD-8 + opencode 临时权限配置 |
| `packages/worker/test/phase3-windows.pi.test.ts` | 7 | WIN-8 / WIN-10 / WIN-11 / `doctor` |
| `packages/worker/test/phase3-spawn-contract.pi.test.ts` | 6 | WIN-12（`windowsHide` / `shell: false`） |

### 验收环境

| 项 | 实测值 |
| :--- | :--- |
| OS / Node / pnpm / vitest | Windows（NTFS）/ `v24.14.1` / `11.17.0` / `4.1.12` |
| `codex` | `codex-cli 0.166.0`（npm 全局 shim，已用 ChatGPT 登录） |
| `claude` | Claude Code `2.1.330`（npm 全局 shim） |
| `gemini` / `opencode` | **未安装**（`where` 无结果） |
| Job Object（koffi） | 可用，`doctor.jobObject = { status: "ok", mode: "job" }` |
| API Key | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 均未设置；**全程未发起任何真实 LLM 请求** |

---

## 1. Codex 现有测试的覆盖缺口与本轮补强

Codex 已有 `phase3-adapters.test.ts`（17 用例）与 `phase3-ops.test.ts`（8 用例），质量较高；本轮的独立验收刻意**不复用其断言方式**，逐 ID 找出并补齐了以下缺口：

| ID | Codex 已有 | 缺口 | Pi 补强方式 |
| :--- | :--- | :--- | :--- |
| AD-1 | 48 组合遍历，但 profile/模型/续跑多为 `toContain` | ① 只验证「整段 prompt 不在 args」，未验证注入**片段**；② claude/gemini/opencode 无精确 argv；③ 未与实采 `--help` 基线交叉验证；④ 无超长 prompt | 4×3×2×2 = **48 组合全量 argv 深度相等**；7 个注入片段逐一断言；40 000 字符 prompt；用 `fixtures/codex/0.166.0` 的 `exec-help.txt` / `exec-resume-help.txt` **反向校验每个 flag 是否被该子命令声明**，并断言 `exec resume` 未声明 `--sandbox/-s/-C/--cd`、`--sandbox` 的 possible values 与实现取值完全一致 |
| AD-2 | 序列/会话/summary/usage 基本覆盖 | ① 未断言 `cacheReadTokens`、`costUsd`；② 未逐事件过 `AgentEvent.parse`；③ 未验证 summary「取最终结果而非中间态」；④ 未验证 codex `error` 非致命语义 | 4 夹具逐事件 schema 校验 + 精确 `usage`（含 `cacheReadTokens`/`costUsd`）+ summary 优先级 + `filesChanged` 去重 |
| AD-3 | 追加 `invalid N` 行 | 未按「非法 JSON / 未知 type / 半截行 / 缺字段」四类**逐适配器**验证，也未覆盖 NUL/二进制/超长/非法转义 | 4 类 × 4 适配器逐条断言「返回单条 log 且不抛」；13 条垃圾输入（含 `\u0000`、`\uD800`、5 KiB 文本、ANSI）不抛且产出全部 schema 合法 |
| AD-4 | 55 行非法 + 退出码 0 | ① 未测「**恰好** 50%」边界；② 未验证非 0 退出时**不误报**格式告警；③ 未验证 `code=null`（信号致死） | 覆盖 >50% / 恰好 50% / 退出码 1 / `timedOut` / `cancelled` / `code=null` 六种情形 + 4 种结构化致命失败 + codex 顶层 `error` 非致命 |
| AD-5 | 仅原生 `.exe` shim | **PATH 查找、缺失、非法名、坏 shim 家族（多目标/逃逸/空/目标缺失/超大/`..\native.exe`）、扩展名白名单全部未覆盖** | 补齐上述全部 7 类坏 shim + PATH 命中（含引号包裹、多段 PATH）+ 本机真实 `codex.cmd` 解析结果 |
| AD-6 | 断言 `--local-profile` 出现、默认 flag 消失（内存态） | 未证明参数**真的到达子进程**，也未验证 stdin 未被破坏 | 4 适配器 × 3 profile 用 `spawnRun` 真实起子进程，回读 `process.argv` 与 stdin，断言 **argv 逐项相等 + stdin 字节相等 + cwd 不变**；并验证 gemini `-o` 抑制默认 `--output-format`、readonly 覆盖不泄漏到 edit |
| AD-7 | 5 s 超时 + 并发 ≤ 2（假计时器） | 用 `vi.useFakeTimers` 观测，未测「快适配器不被慢适配器阻塞」的真实时序，也未实测并发峰值 | 真实计时：假 CLI `sleep(10 000)` 实测 elapsed ∈ [4.8 s, 8.0 s)；断言 fast adapter 在 slow 超时**之前**已 ready；5 适配器实测同时运行峰值 ≤ 2；probe 抛异常被吞并降级 |
| AD-8 | 1000 delta ≤ 20 | 未断言「500 ms 窗口内**零**事件」、未验证 `finish` 冲刷尾段、未验证单 delta 超长分块 | 全部补齐 + `tool_use` 立即冲刷的**顺序**断言（`[message, tool_use]`）+ 5×4000 字符分块每块 ≤ 16 000 |
| opencode `tempFiles` | 成功/取消/spawn 失败/物化失败 4 条 | 未验证「非法文件名拒绝」的具体集合、未验证重启回收的**保留语义**、未核实 Windows 上 `0o600` 的真实效力 | 补齐 `../x`、`a/b`、`.`、`..`、`''` 五种非法名；重启回收只删 `run-XXXXXX`、保留无关目录、幂等；**实测 NTFS 上 `0o600` 不产生 ACL 收紧**（§4 P2-2） |
| WIN-8 | ❌ 未覆盖 | 中文+空格工作区全链路（cwd / filesChanged / 乱码） | 见 §3.2 |
| WIN-10 | ✅ 已覆盖 | 未断言 `schtasks /Query` 文本可见性、未断言 action 中中文配置路径原样保留 | 见 §3.3 |
| WIN-11 | ✅ 已覆盖 | 未断言 icacls 输出**恰好 1 条 ACE**、未断言拒绝非 Ed25519 私钥 | 见 §3.3 |
| WIN-12 | ❌ 未覆盖 | `windowsHide` / `shell: false` 全链路 | 见 §3.4 |
| `doctor` | ✅ 基本覆盖（用 mock 适配器） | 未验证**真实 codex** 探测、未验证 `--dump-help` 的实采基线、未验证报告顶层字段集合稳定 | 见 §3.5 |

---

## 2. 门禁逐 ID 结果

### 2.1 适配器全矩阵（AD）— `packages/worker/test/phase3-adapters.pi.test.ts`

| ID | 结果 | 证据 |
| :--- | :--- | :--- |
| **AD-1** | ✅ | 48 组合（4 适配器 × readonly/edit/full × fresh/resume × 无 model/`provider/model-x`）argv **深度相等**；`stdin === prompt`；prompt 含 `-& calc.exe " \| del %PATH% ^ %COMSPEC% 中文 🚀\r\n` 时，args 中 7 个注入片段（`calc.exe`/`%PATH%`/`COMSPEC`/`del `/`第二行`/`中文`/`🚀`）**逐一为 false**，无 CR/LF，单参数 < 1 KiB；40 000 字符 prompt → argv 总长 < 1 KiB。codex 续跑断言 `-c sandbox_mode="<mode>"`，非续跑断言 `--sandbox <mode>` 且**不含** `--sandbox`/`-C`（续跑）。 |
| **AD-2** | ✅ | 4 夹具回放事件类型序列分别为 `thinking,command,file_change,tool_use,tool_use,error,message,usage` / `init,thinking,tool_use,tool_result,message,usage` / `init,message,tool_use,tool_result,message,usage` / `message,tool_use,tool_result,usage,usage`；`session` 事件恰好 1 条 `session-1`；`usage` 精确到 `cacheReadTokens=3`、`costUsd=0.02`；`filesChanged=['src/a.ts']`（codex/claude）；3 行坏数据降级为 stdout log；每个事件通过 `AgentEvent.parse` 与长度上限；summary 取最终结果（claude 中间态「中间态」被「最终结论」覆盖）；同一路径改两次只记一次。 |
| **AD-3** | ✅ | 4 适配器 × 4 类坏行（`{not json`、未知 `type`、半截 `{"type":`、缺字段）= 16 条，全部返回**单条** `{kind:'log',stream:'stdout',text:<原文>}` 且不抛；stderr 恒为 log；13 条垃圾输入（`''`、`' '`、`null`、`[]`、`"str"`、`123`、嵌套对象、`\u0000\u0001`、5 KiB 文本、ANSI、`\uD800`、`path:null`、`inputTokens:"12"`）不抛且产出全部通过 `AgentEvent.parse`。 |
| **AD-4** | ✅ | 10 合法 + 100 非法 + 退出码 0 → `succeeded`，`summary` **逐字等于最后 50 行**，`errorMessage` 同时含「输出格式无法识别」「CLI 版本可能不兼容」，`errorCode` 为空；恰好 50%（10/20）→ **不降级**；退出码 1 → `failed/NONZERO_EXIT` 且**不含**格式告警；`timedOut→timed_out`、`cancelled→cancelled`、`code=null+signal→failed`；`turn.failed` / `is_error:true` / `result.status=error` / opencode `error` 在退出码 0 下均 `failed/ADAPTER_ERROR`；codex 顶层 `error` 按规格是**非致命**（`succeeded` + `errorMessage`），只有 `turn.failed` 或非 0 退出才 `failed`。 |
| **AD-5** | ✅ | 显式 `command`：绝对可执行文件 ready；相对路径 / 不存在 / 目录 / `.txt` / `.bat` / `.ps1` 全部 `error`。PATH：原生 `.exe`（POSIX 可执行位）命中、`"dir"` 引号包裹命中、多段 PATH 命中、缺失 `missing`、`../escape`/`..`/`has space` → `error`。`.cmd` shim：npm shim → `process.execPath` + `[<...>/main.js]`；同目录有 `node.exe` 时优先它；纯 `.exe` shim → 直接 `command=<exe>`；**7 类坏 shim**（双目标、`..\evil.js` 逃逸、无目标、目标不存在、>64 KiB、`..\native.exe`、空文件）全部 `error` 且提示 `adapters.<id>.command`。本机真实 `codex` shim → `E:\Node\node.exe` + `C:\Users\...\npm\node_modules\@openai\codex\bin\codex.js`。 |
| **AD-6** | ✅ | 4 适配器 × 3 profile 设 `argsOverride[profile]` 后：默认 profile flag（`--sandbox`/`--approval-mode`/`--permission-mode`/`--disallowedTools`）**全部消失**；真实子进程回读 `process.argv` 与 `invocation.args` **逐项相等**，stdin **字节相等**于 prompt，cwd 不变；gemini `-o json` 覆盖时抑制默认 `--output-format`；只覆盖 `readonly` 不影响 `edit`；opencode 的临时配置仍按 profile 生成（`argsOverride` 不污染 `tempFiles`）。 |
| **AD-7** | ✅ | 假 CLI `setTimeout(()=>console.log('9.9.9'), 10000)`：`registry.probe()` 实测 elapsed **≥ 4.8 s 且 < 8.0 s**，`status='error'`、`error` 含 `5 s`；健康的 gemini 在慢 codex 超时**之前**已 `ready`（真非阻塞）；5 个适配器实测 probe 并发峰值 **≤ 2**；probe 抛异常被吞并降级为 `error`。 |
| **AD-8** | ✅ | 1000 个 `delta:true` 在 500 ms 窗口内产出 **0** 事件；推进 501 ms 后 `flushPending()` → **1** 条 `message`；随后 `tool_use` 触发的返回序列严格为 `['message','tool_use']`（立即冲刷）；`finish` 冲刷尾段；全程 `message` 事件 **≤ 20**，拼接正文 **逐字等于** `'词 '×1000 + '末段' + '尾巴'`，`summary` 同值；5 个 4000 字符 delta → 分块 8000/8000/4000，每块 ≤ 16 000，无丢字。 |
| opencode `tempFiles` | ✅ | 内容 = `{"permission":{...}}` 且与 profile 表一致；`OPENCODE_CONFIG` 被改写为**绝对路径**；POSIX 下 `mode & 0777 === 0o600`；文件内无密钥特征；非法文件名 `../escape.json`、`a/b.json`、`.`、`..`、`''` 全部 `throw /Invalid Run temp filename/` 且工作区外无任何文件落盘；Worker 重启回收只删 `run-<6 alnum>` 目录、保留 `keep-me` 与 `run-toolongname`、重复调用幂等、根目录不存在不抛；`removeRunTempDir` 重复调用幂等（对应取消 / spawn 失败 / 物化失败三条清理路径）。 |

### 2.2 Windows 实机门禁（WIN）— `phase3-windows.pi.test.ts` + `phase3-spawn-contract.pi.test.ts`

#### WIN-8 中文 + 空格工作区 ✅

- **路径层**：真实创建 `<tmp>/中文 工作区 测试/子 目录`；`resolveWorkspaceSubdir(root)` / `(root,'子 目录')` / `(root,'子 目录/')` 均返回 `realpathSync.native` 结果；全部结果通过「无 `\uFFFD`、JSON 往返一致、UTF-8 往返一致」三重乱码检查。
- **拒绝项**：`../../../escape.txt`、`..\..\escape.txt`、`C:\Windows\...\hosts`、`\\server\share\x`、`con`、`aux.txt`、`x:stream` 全部抛错；`subdir` 为 `../..`/`..`/`C:\Windows`/`\\server\share`/`con`/`x `（尾随空格）/`a:stream` 全部抛错。工作区**内部**的 `..`（`子 目录/../文件 一.txt`、`.`、`子 目录/../..`）不会逃逸。
- **完整 `RunManager` 链路**（真实 codex 适配器 + 真实 codex 解析器 + 真实子进程，仅替换可执行文件）：子进程 `process.cwd()` **逐字等于** `realpathSync.native(<root>/中文 工作区 测试/子 目录)`；prompt 字节相等；`finished = { status:'succeeded', cliSessionId:'会话-1', summary:'完成 ✅ 中文', filesChanged:['子 目录/文件 一.txt','子 目录/深 层/deep.txt','<outside-workspace>','<outside-workspace>'] }`；每个 `file_change` 事件路径与 `filesChanged` 一致、全为 `/` 分隔、无乱码；`../../../escape.txt` 与 `D:/Windows/System32/x.txt` 均被改写为 `<outside-workspace>` 并产生 `PATH_REJECTED` 告警；本地日志落在 `日志 根目录/<runId>/output.log`，内容含「完成 ✅ 中文」且无乱码。
- **真实 mock-cli**：在 `中文 工作区 测试/子 目录` 中执行 `#scenario: success n=3` → `succeeded`、`summary='Mock response 3'`、`cliSessionId='mock-session'`、`started.effectiveProfile='edit'`、本地日志含 `Mock response 3`。（注：mock-cli 不上报自身 cwd，故 cwd 断言由上一段的真实 codex 适配器完成。）

#### WIN-10 计划任务安装 / 卸载 ✅

- 任务名 `AgentWorkerPiTest_<8 hex>`；`install-task` 返回 0 后：
  - `schtasks /Query /TN <name>` **成功且输出含任务名**（确实存在）；
  - `schtasks /Query /TN <name> /XML`（UTF-16LE 解码）含 `<LogonTrigger>`、`<LogonType>InteractiveToken</LogonType>`、`<Hidden>true</Hidden>`、`<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count>`；**不含** `ServiceAccount` / `Password` / `S4U` / `HighestAvailable`；
  - `Export-ScheduledTask` 明确含 `<RunLevel>LeastPrivilege</RunLevel>`（`schtasks /XML` 会省略这个默认值，故必须用此路径核对）；
  - `Principal.RunLevel='Limited'`、`Principal.LogonType='Interactive'`、**Princial SID = 触发器 SID = 当前登录用户 SID**（即「不管用户是否登录都要运行」未勾选）；
  - Action 为 `-WindowStyle Hidden ... -EncodedCommand`，base64→UTF-16 解码后含 `agent-worker.mjs`、`worker 配置.yaml`（中文 + 空格路径原样保留）、`-WindowStyle Hidden`。
- `uninstall-task` 后 `schtasks /Query /TN`（文本与 XML）**均抛错**、`Get-ScheduledTask` 返回 `absent`。
- **`finally` 铁律**：卸载放在 `finally`，即使断言中途失败也会执行；本轮全部跑完后用 `Get-ScheduledTask` 复核 `*PiTest*` 残留数 = **0**。

#### WIN-11 Ed25519 私钥 ACL ✅

- `loadIdentity(key, true)` 生成 Ed25519 PEM；`icacls` 输出**恰好 1 条 ACE**、**无 `(I)` 继承标记**、无 `BUILTIN\Administrators` / `NT AUTHORITY\SYSTEM` / `EVERYONE` / `BUILTIN\Users`。
- `Get-Acl`：`AreAccessRulesProtected=True`、规则数 `1`、`IdentityReference` = 当前用户 SID、`Allow` 且含 `Read`。
- 破坏测试：`icacls /grant *S-1-1-0:(R)` 后 `identityPermissionsArePrivate()===false`；再次 `loadIdentity` 自动收紧（fingerprint 不变）→ 回到 `true` 且 `EVERYONE` 消失。
- 拒绝把**目录**当私钥；拒绝 **RSA** 私钥（`/Ed25519/`）。

#### WIN-12 窗口隐藏 / 不使用 shell ✅（`phase3-spawn-contract.pi.test.ts`）

通过拦截 `node:child_process` 实测 worker 自己的调用参数（非读源码猜测）：

| 调用点 | 断言 |
| :--- | :--- |
| `spawnRun` | `windowsHide: true`、`shell: false`、`stdio: ['pipe','pipe','pipe']`、`detached === (platform !== 'win32')`、`cwd` 原样、`command`/`args` 原样 |
| `realCli().probe`（codex） | `execFile` 的 `windowsHide: true` / `shell: false` / `timeout: 5000`，`args === ['--version']`（含 `login status` 二次调用） |
| `mockAdapter.probe` | 同上（`timeout: 5000`） |
| `installTask` / `uninstallTask` | `execFile(powershell.exe, ...)`，`windowsHide: true` / `shell: false` / `timeout: 20 000`，参数含 `-EncodedCommand` |
| 静态扫描 | `packages/worker/src` + `packages/mock-cli/src` 全量 `.ts` 中 **`shell: true` 出现 0 次**；显式 `shell: false` ≥ 3 处 |

#### `doctor` 诊断命令 ✅

- 身份缺失时退出码 1，但 stdout 是完整结构化 JSON：`node{version:'v24.14.1',status:'ok'}`、`config{status:'ok',path}`、`workspaces[{id:'repo',path:<realpath>}]`、`workspaceStatus:'ok'`、`identity{status:'missing'}`、`hub{status:'skipped'}`、`jobObject{status:'ok',mode:'job'}`；顶层字段集合**恰好** `adapters/config/hub/identity/jobObject/node/ok/workspaceStatus/workspaces`（无漂移字段）；且**未擅自生成** `identity.key`。
- **正确探测本机 codex-cli 0.166.0**：`adapters[0] = { id:'codex', status:'ready', version:'codex-cli 0.166.0', features:{resume:true,liveInput:false,structuredOutput:true}, binPath:'E:\Node\node.exe', exe:{ command:'E:\Node\node.exe', prefixArgs:['C:\Users\...\@openai\codex\bin\codex.js'] } }`；若某机器未登录则必须是 `status:'error', error:'not authenticated'`（不允许静默 ready），用例同时兼容两种状态但始终断言 `version`。
- 写入身份后 → 退出码 0、`ok:true`、`identity{status:'ok',type:'ed25519',acl:{status:'ok'}}`。
- `--check-hub` 指向不可达地址 → `hub.status='error'`、退出码 1。
- `--dump-help`（真实 CLI 实采）：`exec --help` 含 `--sandbox` 与 `[possible values: read-only, workspace-write, danger-full-access]`；`exec resume --help` **不含** `--sandbox` 但含 `-c, --config`；`--help` 以 `Usage: codex` 开头。
- 坏 YAML / 缺失文件 / 工作区不存在 → 返回结构化失败（`config.status='missing'|'error'`、`workspaceStatus='error'` + `workspaceError`），**不抛异常、不创建文件**。

---

## 3. 关键实测基线（不依赖实现自证）

### 3.1 codex 0.166.0：为什么续跑必须用 `-c sandbox_mode=...`

| 断言 | 结果 |
| :--- | :--- |
| `codex exec` 声明 `--json` / `--skip-git-repo-check` / `-s,--sandbox` / `-C,--cd` / `-c,--config` / `-m,--model` | ✅ 全部存在 |
| `codex exec resume` 声明 `--json` / `--skip-git-repo-check` / `-c,--config` / `-m,--model` | ✅ 存在 |
| `codex exec resume` 声明 `--sandbox` / `-s` / `-C` / `--cd` | ✅ **均不存在**（`resumeFlags.has(...)===false`） |
| `--sandbox` 的 possible values | ✅ 恰为 `read-only, workspace-write, danger-full-access`，与实现取值完全一致 |
| 两个子命令的 `[PROMPT]` 文档说明 `-` 表示从 stdin 读 | ✅ `exec`：「if `-` is used」；`resume`：「If `-` is used, read from stdin」 |
| 实现产出 argv 中的**每个** flag 都属于对应子命令的声明集合 | ✅ 48 组合全部通过 |

### 3.2 claude-code 2.1.330（人工核对，非断言）

实机 `claude --help` 中确认存在：`-p,--print`、`--output-format {text,json,stream-json}`、`--verbose`、`-r,--resume`、`--model`、`--permission-mode {acceptEdits, auto, bypassPermissions, manual, dontAsk, plan}`、`--disallowedTools`、`--allowedTools`。实现使用的 `plan` / `acceptEdits` / `bypassPermissions` 均在枚举内，`--output-format stream-json` 与 `--verbose` 均为合法组合。

---

## 4. 缺陷与观察项（均不阻塞放行）

### P2-1 · `mapWorkspaceFile` 可返回空字符串，导致 `file_change.path === ''`

| 项 | 内容 |
| :--- | :--- |
| 位置 | `packages/worker/src/security/workspace.ts` → `mapWorkspaceFile()` |
| 复现 | 工作区 `<root>`，cwd `<root>/a`，CLI 上报 `path = 'a/../..'`（等价于 `.`/`x/..` 之类解析到工作区根的形式）→ `mapWorkspaceFile(root, cwd, 'a/../..')` 返回 `''` |
| 影响 | `AgentEvent.file_change.path` 与 `finished.filesChanged` 会带上空字符串；协议 schema（`z.string().max(512)`）允许空值，因此会**静默上线**，在面板/日志里表现为一行空白路径。**不构成安全逃逸**（越界仍被改写为 `<outside-workspace>`）。 |
| 建议 | 当 `local === ''` 时与越界同样处理：返回占位符（如 `<workspace-root>`）或抛错走 `<outside-workspace>` + `PATH_REJECTED` 告警。 |
| 现有用例 | `phase3-windows.pi.test.ts › WIN-8 中文 + 空格工作区…` 已固定「内部 `..` 不越界」的契约（断言不以 `..` 开头、不含 `:`）；该空串行为**未**被固化为期望值，便于后续修复。 |

### P2-2 · opencode Run 临时权限配置在 NTFS 上没有真正的 ACL 收紧

| 项 | 内容 |
| :--- | :--- |
| 位置 | `packages/worker/src/runner/temp-files.ts` → `createRunTempDir()`（`mode 0o700`）、`writeRunTempFiles()`（`mode 0o600`） |
| 实测 | 在 NTFS 上 `fs.writeFileSync(path, '{}', { mode: 0o600 })` 的 `stat().mode & 0o777` 仍为 `0o666`；`icacls` 显示该文件继承了 `(I)(M)` / `(I)(F)` 给 `BUILTIN\Administrators`、`NT AUTHORITY\SYSTEM` 以及**其他本机用户 SID**。 |
| 影响 | Run 专属 `opencode.json`（内容仅为 profile 权限策略，**不含密钥**）对同机其他交互用户可读。与 `identity.key`（WIN-11 已用 `icacls` 硬收紧）形成防护不一致。威胁模型 06 §6.2 的 T1 建议「为对外工作区单独创建低权限 Windows 用户运行第二个 Worker」，在此场景下该配置即可被跨用户读取。 |
| 建议 | 复用 `identity.ts` 中的 `restrictWindowsIdentity()` 逻辑（`SetSecurityDescriptorSddlForm` 只保留当前用户）对 `run-*` 目录与其中的临时文件做一次 ACL 收紧；`doctor` 增加该能力探测。 |

### P3-1 · 信号致死（`code === null`）被记为 `NONZERO_EXIT`

`ParserState.finish()` 中 `status==='failed'` 且 `code !== 0`（含 `null`）时统一给 `errorCode:'NONZERO_EXIT'`。`code===null && signal!==null` 的进程并未「非 0 退出」，而是被信号杀死（例如外部 `taskkill /F`）。仅影响诊断语义与面板文案；用例已固化 `status==='failed'` 的正确性，未固化 `errorCode`。

### P3-2 · Gemini delta 合并窗口使用墙钟 `Date.now()`

`gemini.ts` 的 500 ms 窗口用 `Date.now()` 而非注入的 `Clock`。对 `FakeClock` 驱动的 RunManager 集成测试来说无法观测窗口过期（需配合 `vi.useFakeTimers`）。规格 06 §4.3 只要求「每 500 ms 或换段输出一次」，功能上正确；建议后续统一为 `ctx.clock` 以便确定性测试。

### 未验证项（环境受限，非遗漏）

| 项 | 说明 |
| :--- | :--- |
| gemini 权限参数（`--approval-mode default/auto_edit/yolo`）与 `--output-format stream-json` | 本机未安装 `gemini`，无法实机核对；仅按规格 06 §4.2/§4.3 静态断言。 |
| opencode 权限参数与 env 变量名（`OPENCODE_CONFIG` / `OPENCODE_PERMISSION` / `OPENCODE_DISABLE_PROJECT_CONFIG`） | 本机未安装 `opencode`，规格本身标注「Phase 0 核对变量名」，本轮无法核对；`tempFiles` 的落盘/清理/权限语义已独立验证。 |
| E2E-9 / E2E-10（真实 claude-code / codex 只读 prompt 实跑） | 按本轮要求**不发起真实 LLM 请求**（会付费 + 网络抖动导致假失败）。已用「真实 `--version` / `--help` / `login status` + 真实子进程 + 回放夹具」替代覆盖 argv 与解析两侧。 |

---

## 5. 复现方式

```powershell
# 全部新增验收用例（约 12 s + 一次真实计划任务往返）
pnpm vitest run --project worker test/phase3-adapters.pi.test.ts
pnpm vitest run --project worker test/phase3-spawn-contract.pi.test.ts
pnpm vitest run --project worker test/phase3-windows.pi.test.ts

# 门禁全量
pnpm -r build
pnpm lint
pnpm depcheck
pnpm test
```

本轮最后一次全量结果：

```text
 Test Files  40 passed (40)
      Tests  751 passed | 1 skipped (752)
   Duration  108.67s
```

---

## 6. 放行建议

1. **Phase 3 可以放行**：`AD-1`~`AD-8` 与 `WIN-8` / `WIN-10` / `WIN-11` / `WIN-12` / `doctor` 全部通过，构建 / lint / 依赖规则 / 全量测试四项门禁全绿。
2. 建议在 Phase 4 之前顺手处理 **P2-1**（空路径）与 **P2-2**（临时文件 ACL）——两者改动局部、风险低，且都在「会进入面板展示 / 涉及本机多用户」的路径上。
3. 建议把 **P3-2** 与 `codex resume` 的 `-c` 覆写理由一并写入 `docs/risks` 或规格 06 §4.3 的注脚，避免下次 CLI 升级时被误改回 `--sandbox`（本轮 §3.1 的用例就是这条约束的回归护栏）。
4. gemini / opencode 在装机的开发机上补跑一次 `agent-worker doctor --dump-help`，把 `--help` 与一次真实 stream 样本落到 `packages/worker/test/fixtures/<adapter>/<version>/`，即可把本轮的两处「未验证项」转为可回归的实采基线。
