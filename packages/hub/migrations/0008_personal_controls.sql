ALTER TABLE personal_projects ADD COLUMN control TEXT NOT NULL DEFAULT 'running';
ALTER TABLE personal_projects ADD COLUMN closed_reports TEXT;
