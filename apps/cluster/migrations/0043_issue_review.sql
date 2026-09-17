-- GitHub-invoked issue review (ADR 0007, ADR 0012): per-repository opt-in,
-- invocation receipts, review runs with their persisted agent state and
-- messages, and the per-issue scheduling record.

-- Review is off until a teammate enables it. `admit_after` moves on every
-- enable or disable, so a comment received while review was off can never
-- be admitted once it is switched back on.
CREATE TABLE issue_review_setting (
  repository_id TEXT PRIMARY KEY REFERENCES github_repository(repository_id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  admit_after TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- One receipt per invoking comment. Delivery replay finds the receipt and
-- creates nothing; a separately posted comment has its own identity even
-- when its text is identical. The webhook snapshot of the comment is kept so
-- admission can tell an edited comment from the one that was posted.
CREATE TABLE issue_review_receipt (
  repository_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_login TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  eligibility_generation BIGINT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'admitted', 'denied')),
  reason TEXT,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  decided_at TIMESTAMPTZ,
  PRIMARY KEY (repository_id, comment_id)
);

-- A review run: the immutable invocation snapshot, its lifecycle, and the
-- agent Entity's explicitly persisted state. `queued` and `running` are the
-- only live states; a run never leaves a terminal state.
CREATE TABLE issue_review_run (
  run_id UUID PRIMARY KEY,
  repository_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  invoker_id TEXT NOT NULL,
  invoker_login TEXT NOT NULL,
  instructions TEXT NOT NULL,
  comment_created_at TIMESTAMPTZ NOT NULL,
  eligibility_generation BIGINT NOT NULL,
  dry_run BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'interrupted', 'failed')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  started_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancel_reason TEXT,
  cancelled_by TEXT,
  agent_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (repository_id, comment_id)
);
CREATE INDEX issue_review_run_issue ON issue_review_run (repository_id, issue_number, accepted_at);

-- Every message the agent Entity received, keyed by the message identity
-- the sender chose, so a redelivered message is applied once.
CREATE TABLE issue_review_message (
  run_id UUID NOT NULL REFERENCES issue_review_run(run_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  applied BOOLEAN NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (run_id, message_id)
);

-- The per-issue scheduling record: one active run per issue, later runs
-- wait in acceptance order. Different issues run independently.
CREATE TABLE issue_review_issue (
  repository_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  active_run_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, issue_number)
);

-- Pause, disconnection, access loss and installation changes advance the
-- eligibility generation. Every live run of the repository ends there, with
-- the concrete block reason, and restoration never revives it. The
-- comparison is explicit because a BEFORE trigger sets the column.
CREATE FUNCTION fence_issue_review() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.eligibility_generation IS DISTINCT FROM NEW.eligibility_generation THEN
    UPDATE issue_review_run SET status = 'cancelled', finished_at = CLOCK_TIMESTAMP(),
      cancel_reason = COALESCE(repository_block_reason(NEW.repository_id),
        'This repository''s connection, pause or GitHub access changed. Post a new invocation.')
      WHERE repository_id = NEW.repository_id AND status IN ('queued', 'running');
    UPDATE issue_review_issue SET active_run_id = NULL, updated_at = CLOCK_TIMESTAMP()
      WHERE repository_id = NEW.repository_id AND active_run_id IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER issue_review_fence AFTER UPDATE ON github_repository
FOR EACH ROW EXECUTE FUNCTION fence_issue_review();

CREATE TRIGGER live_review_setting AFTER INSERT OR UPDATE OR DELETE ON issue_review_setting
FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('review');
CREATE TRIGGER live_review_run AFTER INSERT OR UPDATE OR DELETE ON issue_review_run
FOR EACH ROW EXECUTE FUNCTION enqueue_live_notification('review');

-- Disconnection removes review settings, receipts and runs with the rest of
-- the repository's data; a reconnection starts without them, and the webhook
-- admission boundary keeps earlier deliveries out.
CREATE OR REPLACE FUNCTION delete_repository_data(target_repository_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE github_repository SET generation_floor = GREATEST(generation_floor + 1,
    COALESCE((SELECT MAX(requested_generation) FROM sync_target WHERE scope->>'repositoryId' = target_repository_id), 0))
    WHERE repository_id = target_repository_id;
  DELETE FROM workflow_outbox WHERE payload->>'repositoryId' = target_repository_id OR payload->'scope'->>'repositoryId' = target_repository_id
    OR payload->>'deliveryId' IN (SELECT delivery_id FROM github_webhook_delivery WHERE repository_id = target_repository_id);
  DELETE FROM github_webhook_delivery WHERE repository_id = target_repository_id;
  DELETE FROM sync_target WHERE scope->>'repositoryId' = target_repository_id;
  DELETE FROM issue_review_run WHERE repository_id = target_repository_id;
  DELETE FROM issue_review_receipt WHERE repository_id = target_repository_id;
  DELETE FROM issue_review_issue WHERE repository_id = target_repository_id;
  DELETE FROM issue_review_setting WHERE repository_id = target_repository_id;
  DELETE FROM labeling_rule_test WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_claim WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_decision WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_lease WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_consent WHERE repository_id = target_repository_id;
  DELETE FROM labeling_reconciliation WHERE repository_id = target_repository_id;
  DELETE FROM labeling_audit WHERE repository_id = target_repository_id;
  DELETE FROM labeling_repository_rules WHERE repository_id = target_repository_id;
  DELETE FROM labeling_configuration WHERE repository_id = target_repository_id;
  DELETE FROM labeling_rule WHERE repository_id = target_repository_id;
  DELETE FROM labeling_policy_dependency WHERE version_id IN
    (SELECT version_id FROM labeling_policy_version WHERE repository_id = target_repository_id);
  DELETE FROM labeling_policy WHERE repository_id = target_repository_id;
  DELETE FROM github_entity WHERE repository_id = target_repository_id;
  DELETE FROM github_label WHERE repository_id = target_repository_id;
  DELETE FROM github_http_cache WHERE repository_id = target_repository_id;
  DELETE FROM repository_connection_audit WHERE repository_id = target_repository_id;
  DELETE FROM content_purge WHERE subject_kind = 'repository' AND subject_id = target_repository_id;
  UPDATE github_repository SET content_purged_at = NULL WHERE repository_id = target_repository_id;
  DELETE FROM live_notification WHERE repository_id = target_repository_id;
END $$;
