-- The chat sessions page's index (EFF-3021): one row per chat session, kept
-- up to date by the session's entity and deleted when the session expires or
-- is deleted. The transcript stays in the entity's own storage.
CREATE TABLE chat_sessions (
  session_id TEXT PRIMARY KEY,
  thread JSONB NOT NULL,
  started_by JSONB NOT NULL,
  turns INTEGER NOT NULL,
  status TEXT,
  last_activity_at TIMESTAMPTZ NOT NULL,
  usage JSONB
);

CREATE INDEX chat_sessions_last_activity ON chat_sessions (last_activity_at DESC, session_id);

-- The chat bot's kill switch (EFF-3012): a single row, every switch off until
-- someone turns it on.
CREATE TABLE chat_kill_switch (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  global BOOLEAN NOT NULL DEFAULT FALSE,
  slack BOOLEAN NOT NULL DEFAULT FALSE,
  discord BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
