ALTER TABLE issue_review_draft_owner ADD COLUMN issue_number INTEGER;
ALTER TABLE issue_review_draft_owner ADD COLUMN default_branch TEXT;
UPDATE issue_review_draft_owner AS owner SET
  issue_number = run.issue_number,
  default_branch = run.default_branch
FROM issue_review_run AS run WHERE run.run_id::text = owner.run_id;
CREATE INDEX issue_review_draft_owner_issue ON issue_review_draft_owner (repository_id, issue_number);
