ALTER TABLE issue_review_run ADD COLUMN draft_publication JSONB;
ALTER TABLE issue_review_action DROP CONSTRAINT issue_review_action_kind_check;
ALTER TABLE issue_review_action ADD CHECK (kind IN ('prepare', 'model', 'publish', 'publish_branch', 'publish_pr'));

-- Minimal ownership survives deletion of detailed run history. A reservation
-- alone is not ownership: an attempted write and its exact content must match.
CREATE TABLE issue_review_draft_owner (
  repository_id TEXT NOT NULL REFERENCES github_repository(repository_id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  run_id TEXT NOT NULL,
  commit_sha TEXT,
  pr_number INTEGER,
  pr_hash TEXT,
  PRIMARY KEY (repository_id, branch)
);
