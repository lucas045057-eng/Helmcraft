ALTER TABLE `tasks` ADD `handoff_from_run_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `harness_request_json` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `harness_json` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `workspace_seq` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `verification_status` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `verification_json` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `protocol_caps_json` text;--> statement-breakpoint
CREATE TABLE `run_board_snapshots` (
	`run_id` text NOT NULL,
	`phase` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`captured_at` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`content_bytes` integer NOT NULL,
	PRIMARY KEY(`run_id`, `phase`),
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workspace_pointers` (
	`worker_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`attempt_counter` integer DEFAULT 0 NOT NULL,
	`last_attempt_run_id` text,
	`last_attempt_seq` integer,
	`last_accepted_run_id` text,
	`last_accepted_seq` integer,
	`accepted_by` text,
	`accepted_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`worker_id`, `workspace_id`),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ix_runs_workspace_seq` ON `task_runs` (`worker_id`,`workspace_id`,`workspace_seq`);--> statement-breakpoint
CREATE INDEX `ix_runs_verification` ON `task_runs` (`verification_status`) WHERE "task_runs"."verification_status" is not null;--> statement-breakpoint
CREATE INDEX `ix_tasks_handoff_from` ON `tasks` (`handoff_from_run_id`);
