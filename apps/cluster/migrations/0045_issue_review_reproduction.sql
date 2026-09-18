-- Saved outside the guest before a tool returns, including incomplete attempts.
ALTER TABLE issue_review_run ADD COLUMN reproduction JSONB NOT NULL
  DEFAULT '{"patch":null,"attempts":[],"assessment":null}'::jsonb;
