CREATE TABLE platform_recovery (
  scan_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  completed_at TIMESTAMPTZ,
  warning TEXT,
  gap TEXT,
  lease_until TIMESTAMPTZ,
  lease_token TEXT
);
INSERT INTO platform_recovery (scan_id,gap) VALUES ('github',
  'Only retained GitHub deliveries can be recovered. Expired history and never-received starts are unavailable.');
CREATE TABLE github_recovery_attempt (
  attempt_id TEXT PRIMARY KEY,
  delivery_guid TEXT NOT NULL,
  event_name TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES github_repository(repository_id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','captured','unavailable')),
  warning TEXT
);
ALTER TABLE slack_thread ADD COLUMN recovery_cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE slack_thread ADD COLUMN recovery_oldest TEXT;
ALTER TABLE slack_thread ADD COLUMN recovery_highwater TEXT;
ALTER TABLE slack_thread ADD COLUMN recovery_due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP();
ALTER TABLE slack_thread ADD COLUMN recovery_completed_at TIMESTAMPTZ;
ALTER TABLE slack_thread ADD COLUMN recovery_lease_until TIMESTAMPTZ;
ALTER TABLE slack_thread ADD COLUMN recovery_lease_token TEXT;
ALTER TABLE slack_thread ADD COLUMN recovery_warning TEXT;
ALTER TABLE slack_thread ADD COLUMN delivery_warning TEXT;
