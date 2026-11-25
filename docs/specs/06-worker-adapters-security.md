# 06 · 本机 Worker、CLI Adapter 与安全边界

> 对应代码：`packages/worker/`、`packages/protocol/src/agent-event.ts`、`packages/common/src/redact.ts`。
> **核心原则（D-SEC-1）：Worker 是本机安全的最终裁决者。** Hub 只能“请求”（adapter、workspaceId、profile、env、args），Worker 依据本地 `worker.yaml` 进行白名单校验与降级。即使云端 Hub 被攻破，攻击面也被限制在本机配置允许的范围内。

---

## 1. 包结构

```text
packages/worker/
├── bin/agent-worker.mjs
└── src/
    ├── cli.ts                    # 子命令：run | enroll | doctor | probe | install-task | uninstall-task
    ├── config/
    │   ├── schema.ts             # worker.yaml Zod schema
    │   └── load.ts               # 解析 + realpath 校验工作区
    ├── identity.ts               # Ed25519 密钥加载/生成，文件权限收紧
    ├── tunnel/
    │   ├── connection.ts         # WS 连接、握手、心跳、退避重连
    │   ├── outbox.ts             # 每 Run 有序缓冲、seq 分配、ack 释放、在途窗口、降级丢弃
    │   ├── commands.ts           # 命令分发 + 幂等（seenCmdIds LRU）
    │   └── clock-offset.ts
    ├── runner/
    │   ├── run-manager.ts        # 槽位、工作区写锁、Run 生命周期、超时/空闲计时
    │   ├── spawn.ts              # 进程启动（stdin 喂 prompt、env 构造、窗口隐藏）
    │   ├── line-reader.ts        # 流式 UTF-8 解码 + 行切分 + 单行上限
    │   ├── kill-tree.ts          # Windows taskkill / Job Object；POSIX 进程组
    │   ├── journal.ts            # 本地 journal（崩溃恢复、孤儿清理、持久终态）
    │   └── local-log.ts          # runs/<runId>/output.log（脱敏、滚动上限）
    ├── security/
    │   ├── workspace.ts          # 路径白名单 / 穿越防护
    │   ├── env.ts                # 环境变量白名单构造
    │   ├── profile.ts            # profile clamp
    │   └── args.ts               # extraArgs 白名单
    └── adapters/
        ├── types.ts              # CliAdapter 接口
        ├── registry.ts           # 注册 + probe 缓存（启动、每 10 min、收到 worker.probe）
        ├── resolve-exe.ts        # 可执行文件解析（Windows .exe / .cmd shim 处理）
        ├── claude-code.ts
        ├── codex.ts
        ├── gemini.ts
        ├── opencode.ts
        └── mock.ts               # 驱动 mock-cli
packages/mock-cli/                # 独立包：脚本化的假 CLI（测试专用，Pi 主要依赖）
```

---

## 2. `CliAdapter` 接口

```ts
// packages/worker/src/adapters/types.ts
export interface CliAdapter {
  readonly id: AdapterId
  readonly displayName: string
  readonly features: { resume: boolean; liveInput: boolean; structuredOutput: boolean }

  /** 探测：解析可执行文件 + 执行 `--version`（5 s 超时）。不得抛异常。 */
  probe(signal: AbortSignal): Promise<ProbeResult>

  /** 纯函数：根据请求与本地策略构造调用。不得访问网络/文件（便于单测）。 */
  buildInvocation(input: InvocationInput): Invocation

  /** 每个 Run 创建一个有状态解析器 */
  createParser(): OutputParser
}

export interface ProbeResult {
  status: 'ready' | 'missing' | 'error'
  version?: string
  exe?: ResolvedExe
  error?: string
}

export interface ResolvedExe {
  command: string          // 绝对路径：.exe 或 node 可执行文件
  prefixArgs: string[]     // 例如 shim 解析后为 [<cli.js 绝对路径>]
}

export interface InvocationInput {
  exe: ResolvedExe
  prompt: string
  cwd: string              // 已通过 security/workspace 校验的绝对路径
  profile: Profile         // 已 clamp
  resumeSessionId?: string
  model?: string
  extraArgs: string[]      // 已通过白名单过滤
  adapterConfig: AdapterLocalConfig  // worker.yaml 中该 adapter 的配置（含 argsOverride）
}

export interface Invocation {
  command: string
  args: string[]           // 绝不包含 prompt
  stdin: string            // prompt 通过 stdin 传入
  env: Record<string, string>   // adapter 额外需要的变量（与 security/env 合并）
  tempFiles?: Array<{ path: string; content: string }>   // 例如生成的临时配置，Run 结束删除
}

export interface OutputParser {
  /** 每行 stdout（已去除 \r\n）。返回 0..n 个归一化事件。非 JSON 行必须降级为 log 事件而不是抛错。 */
  onStdout(line: string): ParsedItem[]
  onStderr(line: string): ParsedItem[]
  /** 进程退出时调用，产出最终结果 */
  finish(exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean }): ParsedOutcome
}

export type ParsedItem =
  | { kind: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'agent'; event: AgentEvent }
  | { kind: 'session'; cliSessionId: string }
  | { kind: 'progress'; phase: string; detail?: string }
  | { kind: 'input_request'; question: string; options?: string[] }

export interface ParsedOutcome {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  errorCode?: string
  errorMessage?: string
  summary: string
  cliSessionId?: string
  usage?: TokenUsage
  filesChanged?: string[]
}
```

**关键规则**：

1. **Prompt 一律走 stdin**，绝不放在命令行参数中。理由：(a) 规避 Windows 命令行 32 767 字符上限与引号转义问题；(b) prompt 不出现在进程列表（`tasklist /v`、`ps`）中；(c) 杜绝参数注入（以 `-` 开头的 prompt 被当成 flag）。
2. **禁止 `shell: true`**。Node ≥ 18.20.2 / 20.12.2 起 `spawn` 直接执行 `.cmd/.bat` 会抛 `EINVAL`（CVE-2024-27980 修复）；而 `shell: true` 会引入 cmd 元字符注入。`resolve-exe.ts` 处理方式见 §4.1。
3. 解析器必须**容错降级**：任何 JSON 解析失败、未知事件类型、字段缺失 → 产出 `{kind:'log', stream:'stdout', text: line}`，并累加 `parseErrors` 计数（在 `finished` 时若 `parseErrors / totalLines > 0.5` 且退出码 0 → 仍判定 succeeded，但 summary 退化为“最后 50 行 stdout”，并在 `errorMessage` 提示“输出格式无法识别，CLI 版本可能不兼容”）。

---

## 3. 归一化 Agent 事件（`AgentEvent`）

```ts
// packages/protocol/src/agent-event.ts
export const AgentEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), model: z.string().optional(), tools: z.array(z.string()).max(200).optional() }),
  z.object({ type: z.literal('thinking'), text: z.string().max(8000) }),
  z.object({ type: z.literal('message'), role: z.enum(['assistant', 'user']), text: z.string().max(16000),
    final: z.boolean() }),
  z.object({ type: z.literal('tool_use'), id: z.string().optional(), name: z.string().max(128),
    summary: z.string().max(1000) }),                 // 例如 "Bash: npm test"、"Read: src/a.ts"
  z.object({ type: z.literal('tool_result'), id: z.string().optional(), ok: z.boolean(),
    summary: z.string().max(2000) }),
  z.object({ type: z.literal('command'), command: z.string().max(2000), exitCode: z.number().int().nullable(),
    outputTail: z.string().max(4000).optional() }),
  z.object({ type: z.literal('file_change'), path: z.string().max(512),       // 相对工作区
    change: z.enum(['add', 'modify', 'delete', 'rename']) }),
  z.object({ type: z.literal('usage'), inputTokens: z.number().int().optional(), outputTokens: z.number().int().optional(),
    costUsd: z.number().optional() }),
  z.object({ type: z.literal('error'), message: z.string().max(4000), fatal: z.boolean() }),
])
```

---

## 4. 各 CLI 适配规格

> ⚠️ **版本漂移风险**：以下命令行与事件格式为截至 2026 年的基线参考，各 CLI 迭代很快。Phase 0 必须执行 `agent-worker doctor --dump-help`，对每个本机已安装 CLI 记录 `--help` 输出与一次真实 stream 输出样本，存入 `packages/worker/test/fixtures/<adapter>/<version>/`，解析器以这些样本做回归测试。命令与本文不一致时**以实测为准**，并通过 `worker.yaml → adapters.<id>.argsOverride` 提供不改代码的修正通道。

### 4.1 可执行文件解析（`resolve-exe.ts`）

查找顺序：

1. `worker.yaml → adapters.<id>.command`（显式绝对路径）。
2. 在 `PATH` 中查找原生可执行文件：Windows 依 `PATHEXT` 但**只接受 `.exe`**；POSIX 查找可执行位。
3. Windows 下找到 `<name>.cmd`（npm 全局 shim）：解析 shim 文本，提取 `"%dp0%\node_modules\...\xxx.js"` 形式的目标脚本路径 → `command = process.execPath`（或 shim 同目录的 `node.exe`），`prefixArgs = [脚本绝对路径]`。解析失败 → `probe.status='error'`，提示用户在配置中填写 `command`。
4. 均未找到 → `missing`。

探测结果缓存；`probe` 并发上限 2；`--version` 输出取第一行匹配 `\d+\.\d+\.\d+`。

### 4.2 Profile → CLI 权限参数映射

| Profile | 语义 | `claude-code` | `codex` | `gemini` | `opencode` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `readonly` | 只读分析，不改文件、不执行命令 | `--permission-mode plan` 或 `--allowedTools "Read,Grep,Glob,LS"` + `--disallowedTools "Bash,Edit,Write,NotebookEdit"` | `--sandbox read-only` | `--approval-mode default`（非交互下需审批的工具被拒） | 通过生成的临时配置禁用 edit/bash 权限 |
| `edit` | 可改工作区文件、可执行受限命令 | `--permission-mode acceptEdits` | `--sandbox workspace-write` | `--approval-mode auto_edit` | 临时配置：edit 允许，bash 询问→拒绝 |
| `full` | 不受限（仅 Owner 且需工作区允许） | `--permission-mode bypassPermissions` | `--sandbox danger-full-access` | `--approval-mode yolo` | 临时配置：全部允许 |

> 注意：这些是 CLI 自带的软边界，**不是操作系统级沙箱**。见 §6 威胁模型 T1。

### 4.3 命令构造与输出解析

#### `claude-code`

| 项 | 值 |
| :--- | :--- |
| 命令 | `claude -p --output-format stream-json --verbose [--resume <sid>] [--model <m>] <profile 参数>`，prompt 经 stdin |
| 输出 | NDJSON，每行一个对象，按 `type` 分派 |
| 映射 | `system/init` → `init` + `session`(`session_id`)；`assistant.message.content[]`：`text` → `message(final=false)`，`tool_use` → `tool_use(name, summary=摘要化 input)`，`thinking` → `thinking`；`user.message.content[].tool_result` → `tool_result`；`result` → 记录 `result`（最终文本）、`session_id`、`usage`、`total_cost_usd`、`is_error`、`subtype` |
| 成功判定 | 退出码 0 且 `result.is_error != true` |
| summary | `result.result`；缺失时取最后一条 assistant 文本 |
| 续跑 | `--resume <session_id>` |
| 文件改动 | 从 `tool_use` 中 `Edit/Write/MultiEdit` 的 `file_path` 推导（转为相对路径） |

#### `codex`

| 项 | 值 |
| :--- | :--- |
| 命令 | `codex exec --json --skip-git-repo-check -C <cwd> [--model <m>] <profile 参数> -`（`-` 表示从 stdin 读 prompt）；续跑：`codex exec resume <sid> --json -`（Phase 0 核对 resume 子命令与 `--json` 的组合方式） |
| 输出 | JSONL 事件：`thread.started{thread_id}`、`turn.started`、`item.started/updated/completed{item}`、`turn.completed{usage}`、`turn.failed{error}`、`error` |
| 映射 | `thread_id` → `session`；`item.type`：`agent_message` → `message`，`reasoning` → `thinking`，`command_execution` → `command`，`file_change` → `file_change`（每个变更一条），`mcp_tool_call`/`web_search` → `tool_use`，`error` → `error`；`turn.completed.usage` → `usage` |
| 成功判定 | 退出码 0 且无 `turn.failed` |
| summary | 最后一个 `agent_message` 的文本（也可用 `--output-last-message <tmpfile>` 作为后备） |
| Windows 注意 | Codex 的 Windows 沙箱能力有限/实验性，`workspace-write` 在 Windows 上的实际隔离强度需 Phase 0 验证并写入风险登记 |

#### `gemini`

| 项 | 值 |
| :--- | :--- |
| 命令 | `gemini --output-format stream-json [--model <m>] [--resume <sid>] <profile 参数>`，prompt 经 stdin（非 TTY stdin 触发非交互模式；若版本要求显式 `-p`，以 `argsOverride` 修正） |
| 输出 | JSONL：`init{session_id, model}`、`message{role, content, delta}`、`tool_use`、`tool_result`、`error`、`result{status, stats}` |
| 映射 | `init` → `init` + `session`；`message(assistant, delta=true)` 累积为 `message`（每 500ms 或换段输出一次，避免事件爆炸）；`tool_use/tool_result` 直映；`result.stats` → `usage` |
| 降级 | 旧版本无 `stream-json` → 以 `--output-format json`（结束时单个 JSON）或纯文本运行，`features.structuredOutput=false` |

#### `opencode`

| 项 | 值 |
| :--- | :--- |
| 命令 | `opencode run --format json [--model <provider/model>] [--session <sid>]`，prompt 经 stdin（若该版本只接受位置参数，则使用 `argsOverride` 并接受命令行长度限制） |
| 输出 | JSON 事件流：`step_start`、`text`、`tool_use`、`step_finish`、`error`，均带 `sessionID` |
| 映射 | `sessionID`（首次出现）→ `session`；`text` → `message`；`tool_use` → `tool_use`/`tool_result`；`step_finish` 中的 tokens/cost → `usage` |
| 权限 | 通过 `tempFiles` 生成 Run 专属配置文件，并以环境变量 `OPENCODE_CONFIG` 指向它（Phase 0 核对变量名） |

#### `mock`（测试专用，必须首先实现）

`packages/mock-cli` 是一个 Node 脚本（经 `process.execPath` 启动），从 stdin 读取 prompt，prompt 首行形如 `#scenario: <name> [k=v ...]` 选择剧本：

| 剧本 | 行为 | 用途 |
| :--- | :--- | :--- |
| `success` | 输出 N 条结构化事件后退出 0 | 主链路 |
| `fail` | 输出错误后退出 `code` | 失败路径 |
| `slow ms=<n>` | 每秒 1 行，持续 n ms | 超时、取消、断线 |
| `flood mb=<n> line=<bytes>` | 尽快输出 n MiB | 背压、防 OOM |
| `huge-line bytes=<n>` | 单行 n 字节 | 行截断 |
| `malformed` | 混合非法 JSON / 半截 JSON / 二进制垃圾 | 解析降级 |
| `need-input` | 发出 input_request 并阻塞读 stdin 后续行 | Live 输入 |
| `ignore-sigterm` | 屏蔽信号，忽略 Ctrl+C | 强杀路径 |
| `spawn-tree depth=<d> width=<w>` | 递归派生子孙进程（每个都 sleep） | 进程树清理 |
| `orphan` | 派生孙进程后父进程立即退出 | Windows 孤儿检测（Job Object） |
| `secrets` | 输出各类假密钥 | 脱敏 |
| `unicode` | 输出中文/emoji/跨 chunk 边界的多字节字符 | 解码 |
| `crash` | 输出一半后 `process.abort()` | 异常退出 |
| `idle ms=<n>` | 静默 n ms 不输出 | 空闲超时 |

Mock adapter 声明 `features = { resume: true, liveInput: true, structuredOutput: true }`。

---

## 5. 进程管理

### 5.1 启动

```ts
spawn(inv.command, [...inv.exe.prefixArgs, ...inv.args], {
  cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  detached: process.platform !== 'win32',   // POSIX：独立进程组以便整组终止
  shell: false,
})
child.stdin.end(inv.stdin, 'utf8')          // live-input 适配器保持 stdin 打开
```

- **编码**：stdout/stderr 用 `new TextDecoder('utf-8', { fatal: false })` 流式解码（`stream: true`，正确处理跨 chunk 的多字节字符）；行切分兼容 `\r\n`/`\n`，去除 ANSI 控制序列后再送解析器（原文保留给 Raw 视图）。可选 `adapters.<id>.stderrEncoding: gbk`（使用 `iconv-lite`）用于输出本地代码页的工具。
- 子进程环境强制：`NO_COLOR=1`、`FORCE_COLOR=0`、`TERM=dumb`、`CI=1`（防止交互式 TUI/分页器）、`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`。
- 计时：墙钟 `timeoutMs`；空闲 `idleTimeoutMs`（stdout/stderr 均无输出）；超时触发 §5.2 终止流程，最终状态 `timed_out`（errorCode `TIMEOUT` / `IDLE_TIMEOUT`）。

### 5.2 终止进程树（取消 / 超时 / Worker 退出）

**Windows**

```text
阶段 1（优雅，graceMs 默认 5000）：
   - 关闭子进程 stdin
   - 执行 taskkill /PID <pid> /T          （不带 /F：向进程树窗口发送关闭请求；对控制台程序通常无效，但无害）
阶段 2（强制）：
   - Job Object 可用 → TerminateJobObject(job)        （覆盖已脱离父子链的孙进程）
   - 否则 → taskkill /PID <pid> /T /F
阶段 3（校验）：
   - 等待 child 'exit' 事件，最长 3 s
   - 以 journal 记录的 pid+创建时间查询（PowerShell Get-CimInstance Win32_Process）：仍存活 → 记录告警 ORPHAN_SURVIVED 并上报 log(system)
```

**Job Object（D-WK-1）**：Worker 在 spawn 后立即通过 FFI（`koffi`）调用 `CreateJobObjectW` + `SetInformationJobObject(JOBOBJECT_EXTENDED_LIMIT_INFORMATION{ LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE })` + `AssignProcessToJobObject`。效果：
- 取消时 `TerminateJobObject` 一次性杀死包括“孤儿”在内的整个进程树；
- **Worker 进程自身崩溃时，Job 句柄被系统关闭，所有子孙进程自动被杀** —— 这是避免孤儿进程的唯一可靠手段。
- 竞态：spawn 与 Assign 之间（微秒级）子进程派生的孙进程可能逃逸；CLI 启动初期不会立即派生子进程，接受该残余风险，并由阶段 3 校验兜底。
- Job Object 作为 Phase 2 的必须项；FFI 加载失败时降级为 `taskkill /T /F` 并在 `doctor` 与面板中显示警告。

**POSIX**：`process.kill(-pid, 'SIGTERM')` → 等待 `graceMs` → `process.kill(-pid, 'SIGKILL')`。

### 5.3 孤儿清理（Worker 启动时）

对 journal 中 `accepted` 但无 `finished` 的 Run：若 pid 存活**且进程创建时间与 journal 记录一致**（防 PID 复用误杀）→ 执行 §5.2 阶段 2；然后合成 `finished{failed, WORKER_RESTARTED}`（03 §7.3）。

### 5.4 本机常驻

- **必须以登录用户身份运行**（而非 LocalSystem 服务）：Claude/Codex/Gemini 的登录凭据保存在用户目录（`%USERPROFILE%`），以 SYSTEM 运行将无法使用这些凭据。
- `agent-worker install-task`：注册 Windows **计划任务**：触发器“用户登录时”，操作 `node.exe <path>\agent-worker.mjs run`，设置“如果任务失败，每 1 分钟重启，最多 999 次”，“不管用户是否登录都要运行”**不勾选**（需要用户凭据环境），隐藏窗口。
- 单实例：启动时在 `%LOCALAPPDATA%\agent-worker\worker.lock` 取得排他锁（`fs.open` + `wx` + pid 写入并校验存活），已有实例 → 退出码 3。
- macOS：launchd `~/Library/LaunchAgents`；Linux：systemd `--user` unit。

---

## 6. 威胁模型与安全护栏

### 6.1 资产与信任边界

```text
[外部接收方] ──飞书──► [飞书平台] ──长连接──► [Hub(云)] ──WSS──► [Worker(本机)] ──spawn──► [AI CLI] ──► [本机文件/网络/凭据]
   不可信                   可信传输             半可信                可信（裁决者）        不可信（可被 prompt 操控）
```

资产：本机源代码与文件、本机凭据（SSH 密钥、云凭据、浏览器数据、CLI API Key）、Hub 数据库（任务内容、日志）、飞书 App Secret、Worker 私钥。

### 6.2 威胁与控制

| ID | 威胁 | 场景 | 控制措施 | 残余风险 |
| :--- | :--- | :--- | :--- | :--- |
| **T1** | **Prompt 注入导致越权操作**（最高风险） | 外部接收方让 Agent 读取 `~/.ssh`、上传代码、执行破坏性命令 | ① Requester 任务默认需审批（02 §5.2 H1/H2）；② Requester profile 上限 `edit`，默认 `readonly`；③ CLI 权限模式按 profile 收紧（§4.2）；④ 工作区隔离：cwd 限定白名单目录；⑤ 结果回传前脱敏 + 可选 `owner_review`；⑥ **建议**为对外工作区单独创建低权限 Windows 用户运行第二个 Worker 实例（不同 workerId），该用户无法访问主用户目录 | CLI 自带权限模式非 OS 沙箱，`edit`/`full` 下的命令执行可越出工作区；必须在 README 中显著告知 |
| T2 | Hub 被攻破 → 远程代码执行 | 攻击者控制 Hub 下发任意任务 | Worker 端：工作区白名单、profile 上限、env/args 白名单、adapter 白名单均由本地配置决定；Hub 无法下发任意命令或路径 | 攻击者仍可在允许的工作区内让 Agent 执行允许档位内的操作 |
| T3 | 路径穿越 | `workspaceId`/`subdir` 指向工作区外 | §6.3 | — |
| T4 | 环境变量注入 | Hub 下发 `NODE_OPTIONS=--require evil.js`、`PATH` 劫持 | §6.4：只透传白名单键，Hub 下发的 env 只接受 `allowedEnvOverrideKeys`（默认空） | — |
| T5 | 参数注入 | Hub 下发 `--dangerously-skip-permissions` | `extraArgs` 只接受 `adapters.<id>.allowedExtraArgs` 中精确匹配或前缀匹配（默认空）；prompt 不进入 argv | — |
| T6 | 日志泄露密钥 | CLI 输出中出现 API Key / Token | §6.5 两级脱敏 | 无法识别的自定义格式密钥 |
| T7 | Worker 身份冒用 / 重放 | 窃听或重放握手 | Ed25519 挑战-应答 + 一次性 nonce + TLS（03 §3） | 本机私钥文件被窃取 |
| T8 | WSS 暴力连接 / DoS | 扫描、撞库、慢连接 | 03 §8 | 大规模 DDoS 需依赖上游（Caddy/云防护） |
| T9 | 面板 CSRF / 会话劫持 | 恶意网页诱导请求 | SameSite=Strict + CSRF Token + Origin 校验 + HttpOnly（04 §1） | — |
| T10 | 飞书越权操作 | Requester 点击审批按钮、伪造他人身份 | 回调中以 `operator.open_id` 鉴权；Requester 只能操作自己的任务 | 飞书账号本身被盗 |
| T11 | 外部人员获取内部信息 | 进度卡片暴露路径/命令/工作区名 | Requester 受众渲染过滤（05 §8.3、§9） | — |
| T12 | 资源耗尽 | 日志洪泛、超大 prompt、超多任务 | 背压三级水位（03 §5.4）、Hub 每 Run 日志上限、prompt 长度上限、Requester 速率（默认 20 任务/小时）与并发上限 | — |
| T13 | 同仓库并发写冲突 | 两个 Agent 同时修改同一工作区 | 工作区写锁（02 §6.3-6） | — |
| T14 | 孤儿进程持续运行 | 取消/崩溃后 CLI 子进程残留并继续修改文件 | Job Object + taskkill 树 + 启动清理（§5.2/5.3） | Job 分配竞态窗口 |

### 6.3 路径防护（`security/workspace.ts`）

配置加载时（启动/热重载）：
1. `path` 必须为绝对路径；拒绝 UNC（`\\server\share`）、设备路径（`\\?\`、`\\.\`）、含 NTFS 备用数据流 `:`（盘符后的冒号除外）的路径。
2. `fs.realpathSync.native(path)` 解析符号链接/Junction；结果必须是目录；**以 realpath 作为工作区根**并记录。
3. 两个工作区的根不得互相包含（否则写锁语义失效）。

每次 Run（`subdir` 存在时）：
1. 拒绝：绝对路径、盘符、以 `\`/`/` 开头、包含 `..` 段、包含 `:`、包含 NUL/控制字符、Windows 保留名段（`CON`、`PRN`、`AUX`、`NUL`、`COM1-9`、`LPT1-9`，大小写不敏感，含扩展名）、尾随点或空格的段。
2. `candidate = path.resolve(root, subdir)`；`real = fs.realpathSync.native(candidate)`（不存在 → 拒绝）。
3. 判定 `real === root || real.startsWith(root + path.sep)`；Windows 下比较前统一 `toLowerCase()`（NTFS 默认大小写不敏感）。
4. 失败 → `cmd.ack{ok:false, PATH_REJECTED}`，记录告警（可能是攻击）。

Run 产出的 `filesChanged` 同样转换为相对路径，越出工作区的路径以 `<outside-workspace>` 代替并标记告警。

### 6.4 环境变量隔离（`security/env.ts`）

```text
childEnv = {}
1. 基础白名单（从 Worker 自身 env 复制，键名大小写不敏感匹配）：
   Windows：SystemRoot, SystemDrive, windir, ComSpec, PATHEXT, PATH, TEMP, TMP, USERPROFILE, USERNAME,
            HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles, ProgramFiles(x86),
            CommonProgramFiles, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE, OS, COMPUTERNAME
   POSIX：  PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, TZ
2. 代理白名单：HTTP_PROXY, HTTPS_PROXY, NO_PROXY（及小写）
3. adapter 白名单（来自 worker.yaml adapters.<id>.passEnv），默认：
   claude-code: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CONFIG_DIR, CLAUDE_CODE_*
   codex:       OPENAI_API_KEY, OPENAI_BASE_URL, CODEX_HOME
   gemini:      GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_CLOUD_PROJECT, GOOGLE_APPLICATION_CREDENTIALS
   opencode:    OPENCODE_*, 以及其所用 provider 的 *_API_KEY（显式列出）
4. adapters.<id>.env（本地配置的固定值）
5. Hub 下发 env：仅 allowedEnvOverrideKeys 中的键（默认空集）
6. 强制覆盖：NO_COLOR, FORCE_COLOR, TERM, CI, PYTHONIOENCODING, PYTHONUTF8
7. 强制删除（无论来源）：AGENT_WORKER_*, HUB_*, NODE_OPTIONS, NODE_PATH, ELECTRON_RUN_AS_NODE, 以及 Worker 私钥路径相关变量
```

### 6.5 日志脱敏（`@agent-hub/common/redact`，Worker 与 Hub 共用）

两级：Worker 发送前（主）+ Hub 持久化/外发前（二次，含 Hub 下发的附加规则）。

| 类别 | 规则（示例） |
| :--- | :--- |
| 已知密钥值 | Worker 启动时收集 §6.4 第 3/4 步中值长度 ≥ 8 的变量值，做精确子串替换为 `[REDACTED:<KEY名>]` |
| Anthropic | `\bsk-ant-[A-Za-z0-9_\-]{20,}` |
| OpenAI | `\bsk-(proj-)?[A-Za-z0-9_\-]{20,}` |
| Google | `\bAIza[0-9A-Za-z_\-]{35}` |
| GitHub | `\bgh[pousr]_[A-Za-z0-9]{36,}`、`\bgithub_pat_[A-Za-z0-9_]{50,}` |
| Slack | `\bxox[abprs]-[A-Za-z0-9-]{10,}` |
| AWS | `\bAKIA[0-9A-Z]{16}`、`(?i)\baws_secret_access_key\s*[=:]\s*\S+` |
| 飞书 | `(?i)\b(app_secret|tenant_access_token)(?:\s*[:=]\s*["']?|\W{0,3})[A-Za-z0-9]{16,}` |
| JWT | `eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}` |
| 私钥块 | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`（跨行：在行切分前对 chunk 缓冲做块级匹配，或在检测到 BEGIN 行后进入“屏蔽模式”直到 END 行） |
| 通用赋值 | `(?i)\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["']?[^\s"']{8,}` → 保留键名、替换值 |
| 连接串 | `(?i)\b(postgres|mysql|mongodb(\+srv)?|redis)://[^:\s]+:[^@\s]+@` → 替换密码段 |

- 正则全部预编译并通过 ReDoS 检查（单元测试中对 100 KiB 病态输入断言 < 50 ms）。
- 脱敏以“行”为单位（行 ≤ 16 KiB），跨行密钥仅私钥块有专门处理；已知局限写入风险登记。
- `commandSummary`、`tool_use.summary`、`command.command`、`finished.summary` 全部经过脱敏。

---

## 7. `worker.yaml` 规格

```yaml
# %APPDATA%\agent-worker\worker.yaml（或 --config 指定）
workerId: win-desktop
hub:
  url: wss://hub.example.com/ws/worker
  # 私钥路径默认 %APPDATA%\agent-worker\identity.key
maxConcurrency: 2
shutdown:
  drainTimeoutMs: 0
tunnel:
  runBufferBytes: 8388608
  totalBufferBytes: 67108864
  flushIntervalMs: 100
localLogs:
  dir: '%LOCALAPPDATA%\agent-worker\runs'
  maxBytesPerRun: 104857600
  retentionDays: 14
security:
  allowedEnvOverrideKeys: []
  useJobObject: true
workspaces:
  - id: backend
    label: 后端主仓库
    path: 'D:\code\backend'
    allowedAdapters: [claude-code, codex]
    maxProfile: edit          # Hub 请求 full 时 clamp 为 edit
    strictProfile: false
    maxConcurrent: 2          # readonly 并发上限；edit/full 恒为 1
  - id: sandbox
    label: 对外演示沙箱
    path: 'D:\agent-sandbox'
    allowedAdapters: [claude-code, codex, gemini, opencode]
    maxProfile: edit
adapters:
  claude-code:
    enabled: true
    # command: 'C:\Users\me\.local\bin\claude.exe'
    passEnv: [ANTHROPIC_API_KEY]
    allowedExtraArgs: ['--model', '--max-turns']
    argsOverride: {}          # 按 profile 覆盖参数，版本漂移时使用
  codex:
    enabled: true
  gemini:
    enabled: false
  opencode:
    enabled: false
  mock:
    enabled: false            # 仅测试/演示环境打开
```

配置文件变更：Worker 监听文件，工作区/adapter 变更在**无活动 Run 的工作区上**立即生效并通过重新 hello（主动断开重连）上报；`hub.url`/`workerId` 变更需重启。

## 8. Worker 本地存储布局

```text
%APPDATA%\agent-worker\            （Roaming，配置与身份）
  worker.yaml
  identity.key                      （ACL：仅当前用户）
%LOCALAPPDATA%\agent-worker\       （本地状态）
  worker.lock
  state\journal.jsonl
  runs\<runId>\output.log           （已脱敏，滚动）
  logs\worker-YYYY-MM-DD.log        （Worker 自身日志，保留 14 天）
```

---

## 9. Phase 7 增量（Blackboard & Harness，权威规格见 [08](08-blackboard-harness.md)）

> D-SEC-1 不变：验证命令只来自本机 `worker.yaml` 的 `argv[]`；Worker 从不写工作区（含 `.board/`）；能力协商只增加功能、不削弱任何既有控制。

| 本文位置 | Phase 7 增量 | 08 |
| :--- | :--- | :--- |
| §1 包结构 | 新增 `src/harness/{session,board-reader,compose-run,manifest,tamper,glob,verify-runner,autofix,downgrade}.ts` | §1.4 |
| §2 `CliAdapter` | 接口不变；Worker 以组合后的 prompt **再次**调用纯函数 `buildInvocation()`；前导一律经 stdin（D-8） | §3.7、§6.3 |
| §4.3 `mock` | `harness=1` 显式参与（MOCK-1）；首行上提并追加 `hx=<nonce>`（MOCK-2）；mock-cli 消费 Harness 块（MOCK-3）；新剧本 `echo-harness`、`fs`（MOCK-4） | §3.6 |
| §5 进程管理 | 验证命令与自动修复轮次同样纳入 Job Object；journal 新记录 `run.process`、`run.cli_exited` | §6.8、§7.1 |
| §6.2 威胁 | 新增 T15–T23 与安全不变量 BB-SEC-1~13 | §11 |
| §6.3 路径防护 | `.board/` 与 `AGENTS.md` 的安全读取：拒绝链接/联接点/硬链接/逃逸/TOCTOU，单文件 ≤ 16 KiB | §6.2 |
| §6.4 env | 验证命令只用基础白名单 + 命令级 `env/passEnv`，**不继承** adapter 的 LLM 凭据，不应用 Hub 下发 env | §7.1 |
| §6.5 脱敏 | 黑板正文在 Worker 与 Hub 两级脱敏；正文不进入日志表、`run/events` 与飞书 | §6.2、§8.4.1 |
| §7 `worker.yaml` | 根 `harness.enabled`（本机总开关，关闭即不发能力头）；`workspaces[].harness.blackboard`（7a）与 `verify` / `tamper` / `manifest`（7b）；`argv[0]` 禁止命令解释器；工作区包含 Worker 配置/状态目录时禁用验证（`CONFIG_EXPOSED`） | §6.9、§7.1 |
| §8 本地存储 | 无新增持久文件（Pre 清单只在内存）；journal 记录类型增加 | §5.6、§7.2 |
