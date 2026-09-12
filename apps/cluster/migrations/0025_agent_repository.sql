-- The selected numeric GitHub identity is immutable for a session. Keep the
-- identity after repository removal so cleanup can still fence remote work.
ALTER TABLE agent_session ADD COLUMN repository_id TEXT;
