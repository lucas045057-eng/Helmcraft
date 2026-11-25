ALTER TABLE personal_projects ADD COLUMN current_item TEXT;
ALTER TABLE personal_projects ADD COLUMN last_commit TEXT;
ALTER TABLE personal_projects ADD COLUMN plan_finished INTEGER NOT NULL DEFAULT 0;
UPDATE personal_projects SET plan_finished=1 WHERE plan_run_id IS NOT NULL;
ALTER TABLE personal_items ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE personal_steps (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  run_id TEXT,
  result_json TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id,item_id,kind,ordinal),
  FOREIGN KEY(project_id,item_id) REFERENCES personal_items(project_id,item_id)
);
