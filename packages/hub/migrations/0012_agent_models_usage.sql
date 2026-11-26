-- 每个 Run 实际使用的模型（来自 CLI 的 init 事件）
ALTER TABLE task_runs ADD COLUMN model_used TEXT;

-- 面板上为每个 Agent 设置的默认模型；任务没指定模型时使用
CREATE TABLE adapter_settings (
  adapter TEXT PRIMARY KEY,
  default_model TEXT,
  updated_at INTEGER NOT NULL
);

-- CLI 上报的订阅额度（如 Claude 的 5 小时 / 7 天窗口），每个 Worker × Agent 保留最新一份
CREATE TABLE adapter_quota (
  worker_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  quota_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (worker_id, adapter)
);
