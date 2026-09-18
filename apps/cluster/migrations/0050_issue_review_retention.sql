-- Detailed history expires from acceptance, including runs that never finished.
CREATE INDEX issue_review_run_retention ON issue_review_run (accepted_at);
ALTER TABLE issue_review_receipt ADD COLUMN details_expired BOOLEAN NOT NULL DEFAULT FALSE;

-- Container destruction is retried independently of deleting database history.
CREATE TABLE issue_review_workspace_cleanup (
  run_id TEXT PRIMARY KEY
);

CREATE FUNCTION remove_review_run_artifacts() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO issue_review_workspace_cleanup VALUES (OLD.run_id::text) ON CONFLICT DO NOTHING;
  DELETE FROM workflow_outbox WHERE payload->>'runId' = OLD.run_id::text;
  UPDATE issue_review_issue SET active_run_id = NULL WHERE active_run_id = OLD.run_id;
  RETURN NULL;
END $$;
CREATE TRIGGER remove_review_run_artifacts AFTER DELETE ON issue_review_run
FOR EACH ROW EXECUTE FUNCTION remove_review_run_artifacts();

CREATE FUNCTION expire_review_history() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE target TEXT;
BEGIN
  FOR target IN SELECT DISTINCT repository_id FROM issue_review_run
    WHERE accepted_at <= CLOCK_TIMESTAMP() - INTERVAL '14 days' ORDER BY repository_id
  LOOP
    PERFORM 1 FROM github_repository WHERE repository_id = target FOR NO KEY UPDATE;
    PERFORM 1 FROM issue_review_issue WHERE repository_id = target ORDER BY issue_number FOR UPDATE;
    DELETE FROM issue_review_run WHERE repository_id = target
      AND accepted_at <= CLOCK_TIMESTAMP() - INTERVAL '14 days';
  END LOOP;
  UPDATE issue_review_receipt SET author_id = '', author_login = '', body = '', reason = NULL,
    outcome = CASE WHEN outcome = 'pending' THEN 'denied' ELSE outcome END,
    details_expired = TRUE
  WHERE NOT details_expired AND created_at <= CLOCK_TIMESTAMP() - INTERVAL '14 days'
    AND NOT EXISTS (SELECT 1 FROM issue_review_run r
      WHERE r.repository_id = issue_review_receipt.repository_id
        AND r.comment_id = issue_review_receipt.comment_id);
END $$;

-- A response arriving after expiry cannot restore details before the next sweep.
CREATE FUNCTION fence_expired_review_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at <= CLOCK_TIMESTAMP() - INTERVAL '14 days' THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_expired_review_write BEFORE UPDATE ON issue_review_run
FOR EACH ROW EXECUTE FUNCTION fence_expired_review_write();

CREATE FUNCTION fence_review_detail_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM issue_review_run WHERE run_id = NEW.run_id
    AND accepted_at > CLOCK_TIMESTAMP() - INTERVAL '14 days';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_review_action_write BEFORE INSERT OR UPDATE ON issue_review_action
FOR EACH ROW EXECUTE FUNCTION fence_review_detail_write();
CREATE TRIGGER fence_review_message_write BEFORE INSERT OR UPDATE ON issue_review_message
FOR EACH ROW EXECUTE FUNCTION fence_review_detail_write();

-- Disconnection keeps the repository discovery row, so its FK does not remove owners.
CREATE FUNCTION remove_review_ownership() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connected AND NOT NEW.connected THEN
    DELETE FROM issue_review_draft_owner WHERE repository_id = NEW.repository_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER remove_review_ownership AFTER UPDATE OF connected ON github_repository
FOR EACH ROW EXECUTE FUNCTION remove_review_ownership();
DELETE FROM issue_review_draft_owner o USING github_repository r
WHERE o.repository_id = r.repository_id AND NOT r.connected;

-- Incoming work must still belong to the connection that admitted it.
CREATE FUNCTION fence_review_admission_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM github_repository WHERE repository_id = NEW.repository_id
    AND connected AND eligibility_generation = NEW.eligibility_generation FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'issue_review_run' AND EXISTS (
    SELECT 1 FROM issue_review_receipt WHERE repository_id = NEW.repository_id
      AND comment_id = NEW.comment_id
      AND (details_expired OR created_at <= CLOCK_TIMESTAMP() - INTERVAL '14 days')
  ) THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_review_receipt_insert BEFORE INSERT ON issue_review_receipt
FOR EACH ROW EXECUTE FUNCTION fence_review_admission_insert();
CREATE TRIGGER fence_review_run_insert BEFORE INSERT ON issue_review_run
FOR EACH ROW EXECUTE FUNCTION fence_review_admission_insert();
