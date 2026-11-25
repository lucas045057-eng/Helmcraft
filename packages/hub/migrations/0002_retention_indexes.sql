CREATE INDEX `ix_enroll_expires` ON `enroll_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_inputs_run` ON `input_requests` (`run_id`);--> statement-breakpoint
CREATE INDEX `ix_runs_pending_purge` ON `task_runs` (`finished_at`) WHERE "task_runs"."logs_purged_at" is null;