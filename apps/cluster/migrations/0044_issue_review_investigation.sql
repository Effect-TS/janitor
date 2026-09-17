-- Evidence-based issue review (ADR 0007, ADR 0009, ADR 0012): the actions a
-- run's agent takes, each with a stable identity and a persisted result, and
-- the completed result the frontend shows.

-- What the run found. `classification` is the agent's call, `default_branch`
-- and `commit_sha` name the revision the evidence was read from, `evidence`
-- is the validated list of items the run actually observed, and
-- `limitation` explains what stopped a run short of a completed result.
ALTER TABLE issue_review_run
  ADD COLUMN classification TEXT
    CHECK (classification IN ('bug', 'enhancement', 'question', 'unclear')),
  ADD COLUMN default_branch TEXT,
  ADD COLUMN commit_sha TEXT,
  ADD COLUMN findings TEXT,
  ADD COLUMN uncertainty TEXT,
  ADD COLUMN evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN limitation TEXT;

-- One row per action of a run, in the order the agent scheduled them. The
-- agent inserts the pending row and the outbox request in one transaction;
-- the action workflow records the result once, and the agent applies the
-- completion once by its message identity. Completed results survive a
-- runner restart, so a resumed action never repeats a finished model call.
CREATE TABLE issue_review_action (
  run_id UUID NOT NULL REFERENCES issue_review_run(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prepare', 'model')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, sequence)
);
