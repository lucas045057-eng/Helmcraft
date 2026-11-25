# Agent Hub 生产运维手册

生产环境由公网 VPS 上的 Caddy、Hub 和本地 SQLite 数据卷，以及从 Windows 主动连出的 Worker 组成。以下 Linux 命令均在仓库的 `deploy/` 执行。Windows 命令从仓库根目录执行。

## 1. 在 VPS 上启动 Hub

1. 将域名的 A 记录指向 VPS。如果有 AAAA 记录，确认 IPv6 同样可达。开放 TCP 80、443，安装 Docker Engine 及 Compose v2。Hub 只在 Compose 网络暴露 8080。SQLite 使用本地块设备文件系统，预留 WAL 和至少一份完整快照的额外空间。
2. 复制模板。容器以 `node` 用户（UID 1000）写入数据卷。使用 rootless Docker 时，按实际 UID 映射设置卷权限。

```sh
cd deploy
umask 077
cp -n .env.example .env
cp -n hub.example.yaml hub.yaml
sudo install -d -m 0700 -o 1000 -g 1000 data
```

3. 在私密终端执行以下命令，保存显示的管理员登录口令。将另外两行填入 `.env`。如果 VPS 没有 Node，可以在本机生成。飞书自建应用的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 也填在该文件中。暂时只使用面板时，将 `hub.yaml` 的 `feishu.enabled` 设为 `false`。

```sh
node -e "const c=require('node:crypto'),r=()=>c.randomBytes(32).toString('base64url'),t=r();console.log('Login token:',t);console.log('HUB_ADMIN_TOKEN_SHA256='+c.createHash('sha256').update(t).digest('hex'));console.log('HUB_SESSION_SECRET='+r())"
chmod 600 .env
```

4. 把 `Caddyfile`、`server.publicUrl` 和 `dashboard.allowedOrigins` 的域名换成同一个真实域名。`trustProxy` 应匹配 Compose 的专用子网。若与 VPS 现有路由重叠，同步调整两处网段。确认容器用户可以读取绑定的 `hub.yaml`，例如 `chmod 644 hub.yaml`；文件中仅存策略与配置。
5. 构建并启动，在浏览器打开站点，用管理员口令登录。`/healthz` 返回 `{"ok":true}`，`/readyz` 返回 HTTP 200 与 `{"ready":true}`。随后检查系统治理页的 Fiber 状态及首页飞书连接状态。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS https://hub.example.com/healthz
curl -fsS https://hub.example.com/readyz
docker compose logs --tail 100 hub caddy
```

修改 Caddyfile 后执行 `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`。保留命名卷 `caddy_data`，其中包含证书和 ACME 账户。反代使用 `flush_interval -1` 与 `read_timeout 0` 支持长连接。[Caddy 反代配置](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 2. 接入飞书开放平台

1. 在开发者后台创建企业自建应用，添加“机器人”应用能力。在凭证页取得 App ID 和 App Secret，填入 VPS 的 `.env`。设置 `feishu.enabled: true`、`feishu.domain: feishu`，然后执行 `docker compose up -d --force-recreate hub` 载入凭证，等待 Hub 与平台建立出站长连接。
2. 在权限管理中申请下列租户身份权限，使授权范围覆盖使用者。消息更新使用本应用机器人发送的卡片。[飞书卡片机器人接入指南](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/quick-start) · [消息接口权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户私聊，供提交任务及 `/whoami` 使用 |
| `im:message.group_at_msg:readonly` | 接收群聊中 @机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份回复、发审批卡与结果卡 |
| `im:message:update` | 更新应用发送的卡片；按控制台对 PATCH 消息接口给出的可选授权配置 |

3. 打开“事件与回调”。事件订阅选择“使用长连接接收事件”，添加“接收消息 v2.0” `im.message.receive_v1`。回调配置也选择长连接，添加“卡片回传交互” `card.action.trigger`。确认保存成功后创建版本、配置可用范围并发布，按租户要求完成管理员审批。
4. 使用负责人的飞书账户私聊机器人 `/whoami`，把返回的本应用 `ou_…` 加入 `feishu.ownerOpenIds`。让需要提单的人分别私聊取得 ID，写到 `requesterAllowlist`。需要群内接单时把机器人加入目标群并配置 `allowedChatIds`，按需要填写 `chatDefaults`。`requesterPolicy: chat` 会扩大相应群内的请求者范围。
5. 确认 `defaultWorkspaceId` 对应在线 Worker 的工作区。由请求者发一条测试任务，核对负责人私聊收到审批卡、卡片按钮可更新状态、原会话收到结果。配置 `requesterReplyPolicy: owner_review` 后，负责人还需审核成功结果的投递。

## 3. Windows Worker 常驻

以实际运行 CLI 的 Windows 用户登录。源码构建使用 Node.js 24、pnpm 11.17.0。已构建 Worker 的启动脚本最低要求 Node.js 22.12。先在该用户下运行 CLI 自带的登录流程，再确认 `codex --version` 正常。

```powershell
npm install -g pnpm@11.17.0
pnpm install --frozen-lockfile
pnpm --filter @agent-hub/worker... -r build
$workerCli = (Resolve-Path .\packages\worker\bin\agent-worker.mjs).Path
$workerDir = Join-Path $env:APPDATA 'agent-worker'
$configFile = Join-Path $workerDir 'worker.yaml'
New-Item -ItemType Directory -Force $workerDir, 'C:\AgentWork\sandbox' | Out-Null
if (-not (Test-Path -LiteralPath $configFile)) { Copy-Item .\deploy\worker.example.yaml $configFile }
notepad $configFile
```

将 `hub.url` 换成本站 `wss://域名/ws/worker`，选择唯一的 `workerId`。工作区白名单中的每个绝对路径必须存在，根目录不能重叠。按业务所需设置 `allowedAdapters`、`maxProfile` 与并发数。默认只启用 Codex；启用其他 CLI 时还要在对应工作区授权。

在面板“系统治理”签发一次性注册令牌，建议绑定 Worker ID，有效期 10 分钟。在本机执行 `agent-worker enroll`；下例直接调用仓库内同一 CLI 入口。保留源码安装位置，计划任务会记录该入口的绝对路径。

```powershell
$enrollToken = Read-Host 'Paste enrollment token'
node $workerCli enroll --config $configFile --token $enrollToken
Remove-Variable enrollToken
node $workerCli doctor --config $configFile --check-hub
.\deploy\windows\install-worker.ps1 -Config $configFile
Start-ScheduledTask -TaskName AgentWorker
Get-ScheduledTaskInfo -TaskName AgentWorker
```

`doctor` 输出 JSON。核对 `ok`、`identity.acl`、`adapters`、`jobObject` 与 `hub`。面板应显示 Worker 在线、工作区可用。任务使用当前用户交互登录身份在登录时启动；需要立即启动时使用上面的 `Start-ScheduledTask`。卸载前先排空并等待运行数归零，停止已运行的任务，再执行 `.\deploy\windows\uninstall-worker.ps1`。卸载保留身份文件与历史记录。

## 4. Worker、密钥与热更新

| 操作 | 步骤 |
| --- | --- |
| 新增 Worker | 签发新注册令牌，在相应 Windows 用户下生成独立身份，按上一节 enroll、doctor、启动。每台机器使用唯一 ID。 |
| 维护与排空 | 在系统治理打开 Drain，或调用 `POST /api/v1/workers/{id}/drain` 并传 `{"drain":true}`。确认活动 Run 结束后进行维护。恢复时传 `false`。 |
| 吊销身份 | 核对机器 ID，调用 `POST /api/v1/workers/{id}/revoke` 并传 `{"confirm":"该机器ID"}`，或使用面板的吊销操作。既有密钥失去连接资格。 |
| Worker 私钥轮换 | 排空旧机器，停止旧任务。在新的配置目录用新 Worker ID、新身份路径和一次性令牌注册，核对新机指纹和工作区，再吊销旧 ID。已有 ID 的重复注册返回 409。 |
| 管理员登录口令 | 重新生成明文及 SHA-256，保存新明文，更新 `.env` 并执行 `docker compose up -d --force-recreate hub`。现存浏览器会话使用数据库中的独立令牌。 |
| 会话失效 | 当前版本用随机 Cookie 和服务端令牌哈希验证，`HUB_SESSION_SECRET` 为预留配置。需要强制所有会话退出时，停 Hub，用 SQLite 执行 `UPDATE dashboard_sessions SET revoked_at=unixepoch()*1000 WHERE revoked_at IS NULL;`，然后启动 Hub。 |
| API Token 与飞书密钥 | 系统治理中新建最小权限 API Token，更新调用方，验证后吊销旧令牌。飞书在平台重置 App Secret 后，更新 `.env` 并重新创建 Hub，检查机器人状态。 |

Hub 校验 `hub.yaml` 后按配置段应用，审计记录 `config.applied`。无效配置会产生面板告警，进程继续使用上一份有效配置。`logs.maxDbBytes`、`logs.retentionDays`、`retention.sliceRows`、`sliceIntervalMs`、`backupDir` 均可热更新。主机地址、端口、时区、SQLite 路径等冷键需重启。单文件绑定挂载遇到编辑器原子替换时，容器可能仍持有旧文件；用 `docker compose exec hub cat /app/hub.yaml` 比较内容，必要时 `docker compose up -d --force-recreate hub`。环境变量变更同样需要重新创建容器。

## 5. 数据保留、备份与恢复

成功任务的终态 Run 按 `finished_at` 保留日志 30 天，其他终态保留 90 天。活动 Run 始终保留。默认每 10 秒处理一个 Run，最多删除 5,000 行日志。元数据保留 365 天，清完日志后按依赖顺序回收。审计保留 365 天，飞书去重键 7 天，幂等键 24 小时，会话及注册令牌保留至过期后 7 天。

管理员可从 `GET /api/v1/system/metrics` 读取 `dbSizeBytes`、`walSizeBytes`、`retentionDeletedRowsTotal`、`storageLevel` 和 `lastBackupAt`（Unix 毫秒）。删除计数统计本次 Store 生命周期内清理的行。备份尚未成功时，时间为 `null`。

| 容量档位 | 可见行为与处理 |
| --- | --- |
| `warning`，主数据库达到上限的 80% | 面板告警，日志保留期减半。检查数据卷剩余空间、WAL 与备份大小。 |
| `critical`，达到 95% | 新日志正文以连续 `gap` 区间占位，任务状态、结构化事件仍保存。需要正文时，在 Worker 的本地保留期内按 Run ID 读取。 |
| 回落 | 下一次容量采样低于 95% 即可恢复正文写入，低于 80% 恢复完整保留期。若调整 `maxDbBytes`，先核对卷的真实可用空间。 |

按 `server.timezone` 每日 04:00 执行 WAL checkpoint、优化和 `VACUUM INTO`；文件库的快照在后台线程生成。默认快照位于 `data/backup/hub-YYYY-MM-DD.sqlite`，仅轮换日期命名的快照，保留最新七份。迁移前备份使用独立的 `.bak-` 命名。检查 `lastBackupAt`、备份日期与磁盘空间，将完成的快照复制到独立存储。

手动备份示例，在 VPS 安装 `sqlite3` 后运行。为避免同日快照冲突，手动快照使用单独目录与 UTC 时间戳。

```sh
umask 077
sudo install -d -m 0700 data/manual
snapshot="data/manual/hub-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sudo sqlite3 data/hub.sqlite ".timeout 5000" "VACUUM INTO '$snapshot';"
sudo sqlite3 -readonly "$snapshot" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

恢复先排空 Worker，核对快照的日期及目标版本，验证 `integrity_check` 为 `ok` 且 `foreign_key_check` 没有结果。恢复会使任务状态、身份、会话和吊销记录回到快照时刻。以下命令保留完整旧库及其 WAL 以便回退，将文件名替换为已验证的快照。

```sh
set -eu
snapshot=data/backup/hub-YYYY-MM-DD.sqlite
test "$(sudo sqlite3 -readonly "$snapshot" 'PRAGMA integrity_check')" = ok
test -z "$(sudo sqlite3 -readonly "$snapshot" 'PRAGMA foreign_key_check')"
docker compose stop hub
old="data/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "$old"
for file in data/hub.sqlite data/hub.sqlite-wal data/hub.sqlite-shm; do
  if sudo test -f "$file"; then sudo mv "$file" "$old/"; fi
done
sudo install -m 0600 -o 1000 -g 1000 "$snapshot" data/hub.sqlite
docker compose up -d hub
curl -fsS --retry 12 --retry-all-errors --retry-delay 2 https://hub.example.com/readyz
```

检查任务、Worker 与策略，重新核对自快照以来轮换或吊销的凭证。验证通过后恢复接单。回滚时同样先停 Hub，将本次恢复后的库及旁文件移到新目录，再放回 `pre-restore-*` 中同一组文件。

## 6. 日志与故障定位

Hub 输出结构化日志到容器标准输出，用 `docker compose logs --since 30m hub` 查对应时间和请求 ID。反代与证书问题查 `docker compose logs caddy`。Worker 默认将每个 Run 的输出放在 `%LOCALAPPDATA%\agent-worker\runs\<runId>\output.log`，运行日志账本在 `%LOCALAPPDATA%\agent-worker\state\journal.jsonl`。在任务计划程序中查上次运行结果，或排空停机后前台执行 `node $workerCli run --config $configFile`。

| 现象或代码 | 检查与操作 |
| --- | --- |
| `/healthz` 正常而 `/readyz` 返回 503 | 确认 Hub 已完成启动且未排空，从 Hub 日志及系统 Fiber 页检查数据库路径、权限、迁移。 |
| HTTP 401 `UNAUTHENTICATED` | 登录用管理员明文口令，API 用有效的 `ahk_` Bearer 令牌，注册用未过期的一次性令牌。核对调用入口和凭据类型。 |
| HTTP 403 `CSRF_FAILED` / `FORBIDDEN` | 核对浏览器 Origin、HTTPS 及 CSRF token；API 核对 scope，读取系统指标需要 admin。 |
| HTTP 409 `VERSION_CONFLICT` / `INVALID_TRANSITION` | 刷新任务版本与状态，再决定是否重试。注册冲突时选新 Worker ID。 |
| WS 4401 / 4403 / 4409 | 分别检查签名身份与系统时间、是否已吊销、是否另一进程使用同一 Worker ID。 |
| WS 4426 / 4429 | 核对 Hub 与 Worker 协议版本，检查代理真实 IP 与握手频率。 |
| `SPAWN_ERROR`、任务排队、CLI 不可用 | 查看任务调度提示，检查 Drain、可用槽位、工作区 ID、目录 ACL 和允许的适配器。在计划任务所属用户下重跑 doctor，检查可执行文件与 CLI 登录状态。 |
| 飞书无卡片或按钮无响应 | 查看连接状态、发布的应用版本、事件和回调订阅、机器人的可用范围及补丁权限。群内消息需 @机器人。 |
| 备份时间过旧、数据库容量告警 | 查 `daily maintenance` 日志，检查 `backupDir` 权限、空间、时区和 04:00 时 Hub 是否在线。修复后可手动备份并做完整性检查。 |
