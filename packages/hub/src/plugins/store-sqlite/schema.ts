import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { isNull, isNotNull } from 'drizzle-orm'
import type { TaskMethod } from '@agent-hub/protocol'

const ts = (name: string) => integer(name)                       // epoch ms
const bool = (name: string) => integer(name, { mode: 'boolean' })

// ───────────────────────────── meta（全局计数器与修订号）─────────────────────────────
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),              // 'schema_version' | 'task_no_seq' | 'policy_revision' | 'hub_boot_id'
  value: text('value').notNull(),
})

// ───────────────────────────── tasks ─────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),                                  // tsk_<ULID>
  taskNo: integer('task_no').notNull(),                         // 展示编号 #123，由 meta.task_no_seq 分配
  version: integer('version').notNull().default(0),             // 乐观锁，每次迁移 +1
  status: text('status', { enum: ['awaiting_approval', 'queued', 'dispatching', 'running', 'awaiting_input',
    'cancelling', 'succeeded', 'rejected', 'failed', 'timed_out', 'cancelled'] }).notNull(),
  handoffFromRunId: text('handoff_from_run_id'),
  methodJson: text('method_json', { mode: 'json' }).$type<TaskMethod>(),          // 方法库快照（docs/specs/10）
  harnessRequestJson: text('harness_request_json', { mode: 'json' }).$type<{ v: 1; fromRunId?: string; intent?: 'relay' | 'fix'; requestedModel?: string; overrides?: { blackboard?: boolean | undefined; verify?: boolean | undefined } }>(),
  parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id, { onDelete: 'set null' }),
  rootTaskId: text('root_task_id'),                             // 对话链根（自身为根时 = id）
  source: text('source', { enum: ['feishu', 'dashboard', 'api'] }).notNull(),
  originJson: text('origin_json', { mode: 'json' }).notNull(),  // TaskOrigin（飞书 chatId/messageId 等）
  requesterType: text('requester_type', { enum: ['owner', 'requester'] }).notNull(),
  requesterId: text('requester_id').notNull(),                  // open_id 或 'dashboard:owner'
  requesterName: text('requester_name'),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  priority: integer('priority').notNull().default(0),
  // —— 执行约束 ——
  adapter: text('adapter'),                                     // 明确指定的 adapter（null = 自动）
  adapterPrefsJson: text('adapter_prefs_json', { mode: 'json' }).$type<string[]>(),
  workspaceId: text('workspace_id').notNull(),
  subdir: text('subdir'),
  profile: text('profile', { enum: ['readonly', 'edit', 'full'] }).notNull(),
  model: text('model'),
  requiredWorkerId: text('required_worker_id'),
  preferredWorkerId: text('preferred_worker_id'),
  resumeSessionId: text('resume_session_id'),                   // Follow-up 继承的 cli_session_id
  timeoutMs: integer('timeout_ms').notNull(),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runSeq: integer('run_seq').notNull().default(0),              // 累计创建的 Run 序号（含 refused），用于 task_runs 唯一键
  attemptCount: integer('attempt_count').notNull().default(0),  // 有效尝试次数（不含 refused），对照 maxAttempts
  currentRunId: text('current_run_id'),                         // 不加 FK（与 task_runs 互相引用，避免插入顺序问题）
  // —— 策略与审批 ——
  policyDecisionJson: text('policy_decision_json', { mode: 'json' }).notNull(),
  approvalDeadlineAt: ts('approval_deadline_at'),
  decidedBy: text('decided_by'),
  decidedAt: ts('decided_at'),
  rejectReason: text('reject_reason'),
  // —— 结果 ——
  resultSummary: text('result_summary'),
  feishuResultVersion: integer('feishu_result_version'), // hybrid delivery: null for legacy, 0 until first complete delivery
  resultDeliveryStatus: text('result_delivery_status', { enum: ['not_required', 'pending_review', 'delivered', 'suppressed'] }).notNull().default('not_required'),
  resultDeliveredAt: ts('result_delivered_at'),
  cliSessionId: text('cli_session_id'),                         // 最近一次成功 Run 的会话
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  lastProgress: text('last_progress'),
  scheduleHint: text('schedule_hint'),
  // —— 时间 ——
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  queuedAt: ts('queued_at'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
}, (t) => [
  index('ix_tasks_handoff_from').on(t.handoffFromRunId),
  uniqueIndex('ux_tasks_task_no').on(t.taskNo),
  // 调度器扫描：WHERE status='queued' ORDER BY priority DESC, queued_at ASC
  index('ix_tasks_sched').on(t.status, t.priority, t.queuedAt),
  index('ix_tasks_created').on(t.createdAt),
  index('ix_tasks_requester').on(t.requesterId, t.createdAt),
  index('ix_tasks_parent').on(t.parentTaskId),
  index('ix_tasks_root').on(t.rootTaskId),
  index('ix_tasks_finished').on(t.finishedAt),                 // 保留策略与“今日统计”
])

// ───────────────────────────── task_runs ─────────────────────────────
export const taskRuns = sqliteTable('task_runs', {
  id: text('id').primaryKey(),                                  // run_<ULID>
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  runSeq: integer('run_seq').notNull(),                         // 任务内单调递增（含 refused）
  attempt: integer('attempt').notNull(),                        // 对应的尝试序号（refused 后下次复用同 attempt 但 runSeq 递增）
  workerId: text('worker_id').notNull().references(() => workers.id),
  adapter: text('adapter').notNull(),
  workspaceId: text('workspace_id').notNull(),
  profile: text('profile').notNull(),                           // 实际生效（可能被 Worker clamp）
  status: text('status', { enum: ['dispatching', 'running', 'awaiting_input', 'cancelling', 'succeeded',
    'failed', 'timed_out', 'cancelled', 'refused', 'lost'] }).notNull(),
  harnessJson: text('harness_json', { mode: 'json' }),                     // HarnessRecord（§8.4）
  workspaceSeq: integer('workspace_seq'),
  verificationStatus: text('verification_status', { enum: ['pending', 'running', 'passed', 'failed', 'skipped', 'unverified'] }),
  verificationJson: text('verification_json', { mode: 'json' }),           // VerificationRecord（§8.4）
  dispatchCount: integer('dispatch_count').notNull().default(1),// 派发重发次数
  notAfter: ts('not_after').notNull(),
  connectionEpoch: integer('connection_epoch'),                 // 受理时的连接纪元
  pid: integer('pid'),
  cliVersion: text('cli_version'),
  cliSessionId: text('cli_session_id'),
  commandSummary: text('command_summary'),
  exitCode: integer('exit_code'),
  signal: text('signal'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  summary: text('summary'),
  usageJson: text('usage_json', { mode: 'json' }),
  filesChangedJson: text('files_changed_json', { mode: 'json' }),
  lastSeq: integer('last_seq').notNull().default(0),            // 已持久化的最大连续 seq（= Hub ackSeq）
  logBytes: integer('log_bytes').notNull().default(0),
  logDroppedBytes: integer('log_dropped_bytes').notNull().default(0),  // Hub 侧截断 + Worker dropped 事件累计
  logTruncated: bool('log_truncated').notNull().default(false),
  cancelRequestedAt: ts('cancel_requested_at'),
  cancelReason: text('cancel_reason'),
  dispatchedAt: ts('dispatched_at').notNull(),
  ackedAt: ts('acked_at'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  logsPurgedAt: ts('logs_purged_at'),                           // 日志被保留策略清理的时间
}, (t) => [
  index('ix_runs_workspace_seq').on(t.workerId, t.workspaceId, t.workspaceSeq),
  index('ix_runs_verification').on(t.verificationStatus).where(isNotNull(t.verificationStatus)),
  uniqueIndex('ux_runs_task_seq').on(t.taskId, t.runSeq),
  index('ix_runs_worker_status').on(t.workerId, t.status),     // 对账/槽位统计
  index('ix_runs_status').on(t.status),
  index('ix_runs_finished').on(t.finishedAt),                  // 保留策略
  index('ix_runs_pending_purge').on(t.finishedAt).where(isNull(t.logsPurgedAt)),
])

// ───────────────────────────── task_logs ─────────────────────────────
export const taskLogs = sqliteTable('task_logs', {
  id: integer('id').primaryKey(),                               // rowid 别名，追加最快
  runId: text('run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ts: ts('ts').notNull(),                                       // Worker 事件时间（展示用）
  kind: text('kind', { enum: ['started', 'log', 'agent', 'session', 'progress', 'input_request',
    'dropped', 'gap', 'finished', 'system', 'harness', 'workspace', 'verify', 'visual'] }).notNull(),
  stream: text('stream', { enum: ['stdout', 'stderr', 'system'] }),
  text: text('text'),                                           // log 文本（已脱敏，≤16 KiB）
  dataJson: text('data_json', { mode: 'json' }),                // 结构化负载
  bytes: integer('bytes').notNull(),                            // text + data 的字节数，用于配额统计
}, (t) => [
  // 核心查询：WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?  —— 唯一索引同时保证幂等（重复 seq 插入失败）
  uniqueIndex('ux_logs_run_seq').on(t.runId, t.seq),
])

// ───────────────────────────── workers ─────────────────────────────
export const workers = sqliteTable('workers', {
  id: text('id').primaryKey(),                                  // 'win-desktop'
  displayName: text('display_name').notNull(),
  publicKey: text('public_key').notNull(),                      // Ed25519 SPKI DER base64
  keyFingerprint: text('key_fingerprint').notNull(),
  status: text('status', { enum: ['active', 'revoked'] }).notNull().default('active'),
  drain: bool('drain').notNull().default(false),
  drainSource: text('drain_source', { enum: ['hub', 'worker'] }),
  connection: text('connection', { enum: ['online', 'suspect', 'offline'] }).notNull().default('offline'),
  connectionEpoch: integer('connection_epoch').notNull().default(0),
  hostname: text('hostname'),
  os: text('os'),
  arch: text('arch'),
  agentVersion: text('agent_version'),
  maxConcurrency: integer('max_concurrency').notNull().default(1),
  protocolCapsJson: text('protocol_caps_json', { mode: 'json' }).$type<string[]>(),
  capabilitiesJson: text('capabilities_json', { mode: 'json' }),     // AdapterCapability[]（最近一次 hello/心跳）
  workspacesJson: text('workspaces_json', { mode: 'json' }),         // WorkspaceDecl[]
  lastIp: text('last_ip'),
  lastSeenAt: ts('last_seen_at'),
  connectedAt: ts('connected_at'),
  disconnectedAt: ts('disconnected_at'),
  lastDispatchAt: ts('last_dispatch_at'),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  revokedAt: ts('revoked_at'),
})

// ───────────────────────────── input_requests ─────────────────────────────
export const inputRequests = sqliteTable('input_requests', {
  id: text('id').primaryKey(),                                  // Worker 生成的 requestId
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  optionsJson: text('options_json', { mode: 'json' }),
  status: text('status', { enum: ['open', 'answered', 'delivered', 'expired', 'cancelled'] }).notNull(),
  answer: text('answer'),
  answeredBy: text('answered_by'),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  answeredAt: ts('answered_at'),
  deliveredAt: ts('delivered_at'),                              // 收到 run.input 的 cmd.ack
}, (t) => [index('ix_inputs_task').on(t.taskId), index('ix_inputs_run').on(t.runId), index('ix_inputs_status').on(t.status, t.expiresAt)])

// ───────────────────────────── feishu_messages ─────────────────────────────
export const feishuMessages = sqliteTable('feishu_messages', {
  messageId: text('message_id').primaryKey(),                   // om_xxx
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['request', 'progress_card', 'approval_card', 'review_card', 'result_text', 'input_prompt', 'reply'] }).notNull(),
  chatId: text('chat_id').notNull(),
  chatType: text('chat_type', { enum: ['p2p', 'group'] }).notNull(),
  audience: text('audience', { enum: ['owner', 'requester'] }),
  senderOpenId: text('sender_open_id'),                         // role=request 时为用户
  resultKey: text('result_key'), // deterministic send UUID for a terminal result part
  cardHash: text('card_hash'),                                  // 最近一次成功推送的渲染哈希
  cardTaskVersion: integer('card_task_version'),
  dead: bool('dead').notNull().default(false),                  // 不可再 patch
  createdAt: ts('created_at').notNull(),
  lastPatchedAt: ts('last_patched_at'),
}, (t) => [index('ix_fsmsg_task').on(t.taskId, t.role), uniqueIndex('ux_fsmsg_result_key').on(t.resultKey).where(isNotNull(t.resultKey))])

export const feishuEventDedupe = sqliteTable('feishu_event_dedupe', {
  key: text('key').primaryKey(),                                // 'evt:<event_id>' | 'msg:<message_id>' | 'act:<event_id>'
  receivedAt: ts('received_at').notNull(),
}, (t) => [index('ix_fsdedupe_time').on(t.receivedAt)])

// ───────────────────────────── audit_logs ─────────────────────────────
export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey(),
  ts: ts('ts').notNull(),
  actorType: text('actor_type', { enum: ['owner', 'requester', 'system', 'worker'] }).notNull(),
  actorId: text('actor_id').notNull(),
  channel: text('channel', { enum: ['feishu', 'dashboard', 'api', 'system'] }).notNull(),
  action: text('action').notNull(),                             // 'task.submit' | 'task.transition' | 'task.noop' | 'worker.drain' | 'config.applied' | ...
  targetType: text('target_type', { enum: ['task', 'run', 'worker', 'policy', 'config', 'session', 'token', 'method'] }).notNull(),
  targetId: text('target_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  detailJson: text('detail_json', { mode: 'json' }),            // 不含密钥；prompt 改写时含新旧摘要
  requestId: text('request_id'),
}, (t) => [
  index('ix_audit_target').on(t.targetType, t.targetId, t.ts),
  index('ix_audit_ts').on(t.ts),
  index('ix_audit_actor').on(t.actorId, t.ts),
])

// ───────────────────────────── policy_rules ─────────────────────────────
export const policyRules = sqliteTable('policy_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  priority: integer('priority').notNull(),
  enabled: bool('enabled').notNull().default(true),
  matchJson: text('match_json', { mode: 'json' }).notNull(),
  effectJson: text('effect_json', { mode: 'json' }).notNull(),
  updatedAt: ts('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
}, (t) => [index('ix_policy_priority').on(t.priority)])

// ───────────────────────────── 鉴权相关 ─────────────────────────────
export const dashboardSessions = sqliteTable('dashboard_sessions', {
  id: text('id').primaryKey(),                                  // 会话 ULID
  tokenHash: text('token_hash').notNull(),                      // sha256(cookie 值)
  csrfToken: text('csrf_token').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  revokedAt: ts('revoked_at'),
}, (t) => [uniqueIndex('ux_sessions_hash').on(t.tokenHash), index('ix_sessions_expires').on(t.expiresAt)])

export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  scopesJson: text('scopes_json', { mode: 'json' }).notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at'),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
}, (t) => [uniqueIndex('ux_api_tokens_hash').on(t.tokenHash)])

export const enrollTokens = sqliteTable('enroll_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  suggestedWorkerId: text('suggested_worker_id'),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  usedByWorkerId: text('used_by_worker_id'),
}, (t) => [index('ix_enroll_expires').on(t.expiresAt)])

export const idempotencyKeys = sqliteTable('idempotency_keys', {
  scope: text('scope').notNull(),                               // 'POST /tasks' | 'feishu:message' ...
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  responseJson: text('response_json', { mode: 'json' }).notNull(),
  createdAt: ts('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.scope, t.key] }), index('ix_idem_created').on(t.createdAt)])

export const runBoardSnapshots = sqliteTable('run_board_snapshots', {
  runId: text('run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  phase: text('phase', { enum: ['pre', 'post'] }).notNull(),
  round: integer('round').notNull().default(0),                          // post 行保存最新轮次
  capturedAt: ts('captured_at').notNull(),
  snapshotJson: text('snapshot_json', { mode: 'json' }).notNull(),       // BoardSnapshot（content 已二次脱敏；容量 critical 时剥离）
  contentBytes: integer('content_bytes').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.phase] })])

export const workspacePointers = sqliteTable('workspace_pointers', {
  workerId: text('worker_id').notNull().references(() => workers.id),
  workspaceId: text('workspace_id').notNull(),
  attemptCounter: integer('attempt_counter').notNull().default(0),
  lastAttemptRunId: text('last_attempt_run_id'), lastAttemptSeq: integer('last_attempt_seq'),
  lastAcceptedRunId: text('last_accepted_run_id'), lastAcceptedSeq: integer('last_accepted_seq'),
  acceptedBy: text('accepted_by'),                                       // 'auto' | Owner actor.id
  acceptedAt: ts('accepted_at'),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.workerId, t.workspaceId] })])

export const feishuChatState = sqliteTable('feishu_chat_state', {
  chatId: text('chat_id').notNull(),
  threadId: text('thread_id').notNull().default(''),
  workspaceId: text('workspace_id'),
  subdir: text('subdir'),
  adapter: text('adapter'),
  profile: text('profile'),
  lastTaskId: text('last_task_id'),
  lastMessageId: text('last_message_id'),
  updatedAt: ts('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.chatId, t.threadId] })])

export const feishuProposals = sqliteTable('feishu_proposals', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id'),
  actorOpenId: text('actor_open_id').notNull(),
  payloadJson: text('payload_json').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
}, (t) => [index('ix_proposals_chat').on(t.chatId, t.status, t.expiresAt)])

export const runArtifacts = sqliteTable('run_artifacts', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  runId: text('run_id').references(() => taskRuns.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['visual_before', 'visual_after', 'inbound_image', 'inbound_audio', 'inbound_file'] }).notNull(),
  label: text('label').notNull(),
  mimeType: text('mime_type').notNull(),
  bytes: integer('bytes').notNull(),
  sha256: text('sha256').notNull(),
  storageRelPath: text('storage_rel_path').notNull(),
  metaJson: text('meta_json'),
  createdAt: ts('created_at').notNull(),
}, (t) => [index('ix_artifacts_task').on(t.taskId, t.createdAt), index('ix_artifacts_run').on(t.runId, t.kind)])

export const projectBriefings = sqliteTable('project_briefings', {
  id: text('id').primaryKey(),
  workerId: text('worker_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  subdir: text('subdir').notNull().default(''),
  kind: text('kind').notNull(),
  health: text('health').notNull(),
  summary: text('summary').notNull(),
  findingsJson: text('findings_json').notNull(),
  actionsJson: text('actions_json').notNull(),
  deliveredChatIdsJson: text('delivered_chat_ids_json'),
  createdAt: ts('created_at').notNull(),
}, (t) => [index('ix_briefings_project').on(t.workspaceId, t.subdir, t.createdAt)])
