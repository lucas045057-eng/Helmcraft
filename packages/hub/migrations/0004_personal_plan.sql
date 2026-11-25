CREATE TABLE personal_projects (
  id TEXT PRIMARY KEY NOT NULL,
  worker_id TEXT NOT NULL,
  root TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  plan_task_id TEXT NOT NULL UNIQUE,
  plan_run_id TEXT,
  phase TEXT NOT NULL DEFAULT 'planning',
  reason TEXT,
  plan_json TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX personal_project_active_root ON personal_projects(worker_id,root)
  WHERE phase NOT IN ('done','stopped');
CREATE TABLE personal_items (
  project_id TEXT NOT NULL REFERENCES personal_projects(id),
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(project_id,item_id),
  UNIQUE(project_id,ordinal)
);
