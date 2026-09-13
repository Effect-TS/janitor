CREATE TABLE github_feedback (
  session_id TEXT NOT NULL REFERENCES agent_session(session_id) ON DELETE CASCADE,
  contribution_key TEXT NOT NULL,
  review_id TEXT,
  reviewer_id TEXT NOT NULL,
  author JSONB NOT NULL,
  authorized BOOLEAN NOT NULL,
  body TEXT,
  submitted BOOLEAN NOT NULL DEFAULT FALSE,
  inline_target TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','context','empty')),
  cursor TEXT NOT NULL DEFAULT '',
  warning TEXT,
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (session_id, contribution_key)
);
CREATE TABLE github_feedback_comment (
  session_id TEXT NOT NULL,
  contribution_key TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_target TEXT NOT NULL,
  PRIMARY KEY(session_id, comment_id),
  FOREIGN KEY(session_id, contribution_key) REFERENCES github_feedback ON DELETE CASCADE
);
CREATE TABLE github_feedback_receipt (
  delivery_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_session(session_id) ON DELETE CASCADE
);
ALTER TABLE slack_thread ADD COLUMN active_contribution TEXT;
CREATE TABLE github_feedback_output (
  output_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES agent_session(session_id) ON DELETE CASCADE,
  sequence BIGSERIAL NOT NULL,
  inline_target TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uncertain','sent','problem')),
  platform_id TEXT,
  cursor TEXT NOT NULL DEFAULT '',
  error TEXT,
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  lease_until TIMESTAMPTZ
);
