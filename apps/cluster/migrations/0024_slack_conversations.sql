-- Transport receipts and logical contributions have distinct identities.
CREATE TABLE slack_receipt (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  channel_id TEXT,
  thread_ts TEXT,
  body JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  retry_number TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (workspace_id, event_id)
);
CREATE TABLE slack_thread (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  boundary_ts TEXT NOT NULL,
  repository_id TEXT REFERENCES github_repository(repository_id),
  pr_number TEXT,
  context JSONB,
  context_cursor TEXT NOT NULL DEFAULT '',
  context_pages JSONB NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'initializing' CHECK (state IN ('initializing','ready','redirected')),
  warning TEXT,
  progress_ts TEXT,
  next_output BIGINT NOT NULL DEFAULT 1,
  publication_cursor BIGINT NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  UNIQUE (workspace_id, channel_id, thread_ts)
);
CREATE UNIQUE INDEX slack_pr_home ON slack_thread(repository_id, pr_number) WHERE pr_number IS NOT NULL AND state <> 'redirected';
CREATE TABLE slack_contribution (
  sequence BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author JSONB NOT NULL,
  text TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
  forwarded BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_pending BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (workspace_id, channel_id, message_ts)
);
CREATE TABLE slack_output (
  output_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES slack_thread(session_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress','response','error','question')),
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uncertain','sent')),
  message_ts TEXT,
  error TEXT,
  UNIQUE(session_id, sequence)
);
CREATE TABLE slack_channel_delivery (
  workspace_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY(workspace_id, channel_id)
);
CREATE INDEX slack_thread_due ON slack_thread(due_at);
CREATE INDEX slack_output_pending ON slack_output(session_id, sequence) WHERE state <> 'sent';
ALTER TABLE slack_thread ADD COLUMN publication_due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP();
ALTER TABLE slack_output ADD COLUMN reconcile_cursor TEXT NOT NULL DEFAULT '';
