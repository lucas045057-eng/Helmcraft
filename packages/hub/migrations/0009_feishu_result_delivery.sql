ALTER TABLE tasks ADD COLUMN feishu_result_version INTEGER;
ALTER TABLE feishu_messages ADD COLUMN result_key TEXT;
CREATE UNIQUE INDEX ux_fsmsg_result_key ON feishu_messages(result_key) WHERE result_key IS NOT NULL;
