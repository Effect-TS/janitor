ALTER TABLE issue_review_run ADD COLUMN publication JSONB NOT NULL DEFAULT
  '{"status":"none","body":null,"commentId":null,"url":null,"reason":null}'::jsonb;
ALTER TABLE issue_review_issue ADD COLUMN summary_comment_id TEXT;
ALTER TABLE issue_review_issue ADD COLUMN summary_hash TEXT;
-- Survives detailed run retention. An uncertain send blocks later writes on the issue.
ALTER TABLE issue_review_issue ADD COLUMN publication_unresolved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE issue_review_action DROP CONSTRAINT issue_review_action_kind_check;
ALTER TABLE issue_review_action ADD CHECK (kind IN ('prepare', 'model', 'publish'));

-- Enabling dry-run is sticky for existing work, even if disabled again before it finishes.
CREATE FUNCTION fence_review_dry_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.dry_run AND NOT OLD.dry_run THEN
    UPDATE issue_review_run SET dry_run = TRUE
      WHERE repository_id = NEW.repository_id AND status IN ('queued', 'running');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER review_dry_run_fence AFTER UPDATE ON issue_review_setting
FOR EACH ROW EXECUTE FUNCTION fence_review_dry_run();
