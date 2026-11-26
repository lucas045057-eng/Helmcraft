CREATE TABLE feishu_chat_state (
  chat_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT,
  subdir TEXT,
  adapter TEXT,
  profile TEXT,
  last_task_id TEXT,
  last_message_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, thread_id)
);

CREATE TABLE feishu_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  actor_open_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX ix_proposals_chat ON feishu_proposals(chat_id, status, expires_at);

CREATE TABLE run_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_rel_path TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX ix_artifacts_task ON run_artifacts(task_id, created_at);
CREATE INDEX ix_artifacts_run ON run_artifacts(run_id, kind);

CREATE TABLE project_briefings (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subdir TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  health TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  delivered_chat_ids_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX ix_briefings_project ON project_briefings(workspace_id, subdir, created_at);

ALTER TABLE personal_projects ADD COLUMN subdir TEXT;
ALTER TABLE personal_projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'strict';
ALTER TABLE personal_projects ADD COLUMN options_json TEXT;
ALTER TABLE personal_projects ADD COLUMN resume_phase TEXT;
