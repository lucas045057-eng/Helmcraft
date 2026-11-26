-- 个人方法库（docs/specs/10-method-library.md）
CREATE TABLE method_cards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'sop')),
  scenario TEXT NOT NULL DEFAULT '',
  avoid TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL,
  done TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'self_confirmed',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_method_cards_name ON method_cards(name);

CREATE TABLE method_examples (
  id TEXT PRIMARY KEY,
  method_id TEXT NOT NULL REFERENCES method_cards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  task_id TEXT,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ix_method_examples_method ON method_examples(method_id, created_at);

-- 飞书推荐确认：未确认前不创建任务
CREATE TABLE method_suggestions (
  id TEXT PRIMARY KEY,
  method_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

ALTER TABLE tasks ADD COLUMN method_json TEXT;
