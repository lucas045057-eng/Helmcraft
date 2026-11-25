CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_api_tokens_hash` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`channel` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`detail_json` text,
	`request_id` text
);
--> statement-breakpoint
CREATE INDEX `ix_audit_target` ON `audit_logs` (`target_type`,`target_id`,`ts`);--> statement-breakpoint
CREATE INDEX `ix_audit_ts` ON `audit_logs` (`ts`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor` ON `audit_logs` (`actor_id`,`ts`);--> statement-breakpoint
CREATE TABLE `dashboard_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_sessions_hash` ON `dashboard_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ix_sessions_expires` ON `dashboard_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `enroll_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`suggested_worker_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_worker_id` text
);
--> statement-breakpoint
CREATE TABLE `feishu_event_dedupe` (
	`key` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_fsdedupe_time` ON `feishu_event_dedupe` (`received_at`);--> statement-breakpoint
CREATE TABLE `feishu_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`role` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`audience` text,
	`sender_open_id` text,
	`card_hash` text,
	`card_task_version` integer,
	`dead` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_patched_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_fsmsg_task` ON `feishu_messages` (`task_id`,`role`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `ix_idem_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `input_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`question` text NOT NULL,
	`options_json` text,
	`status` text NOT NULL,
	`answer` text,
	`answered_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`answered_at` integer,
	`delivered_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_inputs_task` ON `input_requests` (`task_id`);--> statement-breakpoint
CREATE INDEX `ix_inputs_status` ON `input_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`match_json` text NOT NULL,
	`effect_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_policy_priority` ON `policy_rules` (`priority`);--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` integer PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`stream` text,
	`text` text,
	`data_json` text,
	`bytes` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_logs_run_seq` ON `task_logs` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_seq` integer NOT NULL,
	`attempt` integer NOT NULL,
	`worker_id` text NOT NULL,
	`adapter` text NOT NULL,
	`workspace_id` text NOT NULL,
	`profile` text NOT NULL,
	`status` text NOT NULL,
	`dispatch_count` integer DEFAULT 1 NOT NULL,
	`not_after` integer NOT NULL,
	`connection_epoch` integer,
	`pid` integer,
	`cli_version` text,
	`cli_session_id` text,
	`command_summary` text,
	`exit_code` integer,
	`signal` text,
	`error_code` text,
	`error_message` text,
	`summary` text,
	`usage_json` text,
	`files_changed_json` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`log_bytes` integer DEFAULT 0 NOT NULL,
	`log_dropped_bytes` integer DEFAULT 0 NOT NULL,
	`log_truncated` integer DEFAULT false NOT NULL,
	`cancel_requested_at` integer,
	`cancel_reason` text,
	`dispatched_at` integer NOT NULL,
	`acked_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`logs_purged_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_runs_task_seq` ON `task_runs` (`task_id`,`run_seq`);--> statement-breakpoint
CREATE INDEX `ix_runs_worker_status` ON `task_runs` (`worker_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_runs_status` ON `task_runs` (`status`);--> statement-breakpoint
CREATE INDEX `ix_runs_finished` ON `task_runs` (`finished_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_no` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`parent_task_id` text,
	`root_task_id` text,
	`source` text NOT NULL,
	`origin_json` text NOT NULL,
	`requester_type` text NOT NULL,
	`requester_id` text NOT NULL,
	`requester_name` text,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`adapter` text,
	`adapter_prefs_json` text,
	`workspace_id` text NOT NULL,
	`subdir` text,
	`profile` text NOT NULL,
	`model` text,
	`required_worker_id` text,
	`preferred_worker_id` text,
	`resume_session_id` text,
	`timeout_ms` integer NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_seq` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`current_run_id` text,
	`policy_decision_json` text NOT NULL,
	`approval_deadline_at` integer,
	`decided_by` text,
	`decided_at` integer,
	`reject_reason` text,
	`result_summary` text,
	`result_delivery_status` text DEFAULT 'not_required' NOT NULL,
	`result_delivered_at` integer,
	`cli_session_id` text,
	`error_code` text,
	`error_message` text,
	`last_progress` text,
	`schedule_hint` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`queued_at` integer,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_tasks_task_no` ON `tasks` (`task_no`);--> statement-breakpoint
CREATE INDEX `ix_tasks_sched` ON `tasks` (`status`,`priority`,`queued_at`);--> statement-breakpoint
CREATE INDEX `ix_tasks_created` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `ix_tasks_requester` ON `tasks` (`requester_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `ix_tasks_root` ON `tasks` (`root_task_id`);--> statement-breakpoint
CREATE INDEX `ix_tasks_finished` ON `tasks` (`finished_at`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`public_key` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`drain` integer DEFAULT false NOT NULL,
	`drain_source` text,
	`connection` text DEFAULT 'offline' NOT NULL,
	`connection_epoch` integer DEFAULT 0 NOT NULL,
	`hostname` text,
	`os` text,
	`arch` text,
	`agent_version` text,
	`max_concurrency` integer DEFAULT 1 NOT NULL,
	`capabilities_json` text,
	`workspaces_json` text,
	`last_ip` text,
	`last_seen_at` integer,
	`connected_at` integer,
	`disconnected_at` integer,
	`last_dispatch_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer
);
