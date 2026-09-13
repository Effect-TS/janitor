-- Repository access lifecycle for agent sessions.
--
-- Pause and access loss fence new repository operations with a concrete
-- reason while session data and workspaces stay. Explicit disconnection ends
-- the repository's sessions: their remote identities are persisted as cleanup
-- tombstones before the session rows go, so the runner's native session,
-- workspace and checkpoints are removed even when the disconnecting request
-- dies. A tombstone is deleted only once the runner confirms cleanup.

-- The one reason agent work on a repository is blocked, or NULL when the
-- repository is ready. Deliberate pause outranks synchronization state:
-- restoring access leaves a paused repository paused.
CREATE FUNCTION repository_block_reason(id TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM github_repository WHERE repository_id = id)
    THEN 'This repository is not connected to Janitor.'
  ELSE (
    SELECT CASE
      WHEN NOT r.connected THEN 'This repository is disconnected from Janitor.'
      WHEN NOT repository_access_available(r.repository_id) THEN
        'GitHub access to this repository is unavailable. Restore access on GitHub; work resumes after synchronization succeeds.'
      WHEN NOT r.enabled THEN 'This repository is paused in Janitor. Resume it to continue.'
      WHEN EXISTS (SELECT 1 FROM sync_target t WHERE t.scope->>'repositoryId' = r.repository_id
        AND (t.last_error IS NOT NULL OR t.health = 'blocked')) THEN
        'Repository synchronization failed. Work resumes after synchronization succeeds.'
      WHEN r.automation_ready_at IS NULL THEN
        'Repository synchronization is in progress. Work resumes when it completes.'
      ELSE NULL END
    FROM github_repository r WHERE r.repository_id = id
  ) END
$$;

-- Cleanup tombstones: what Janitor still owes the runner for an ended session.
-- The row is the durable queue entry and the fence that excludes stale work;
-- it disappears when the runner confirms the native session is gone.
CREATE TABLE agent_session_cleanup (
  session_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  native_session_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_until TIMESTAMPTZ
);
CREATE INDEX agent_session_cleanup_due_idx ON agent_session_cleanup (due_at);
CREATE INDEX agent_session_cleanup_repository_idx ON agent_session_cleanup (repository_id);

-- Disconnection ends agent sessions before the rest of the repository data
-- goes. Tombstones persist first; then home threads, sessions and their
-- cascaded inputs, projections, cursors, catch-up obligations, responses,
-- feedback and pending outputs are deleted, together with handoff requests
-- still in the outbox. Slack receipts and contributions are transport
-- records keyed by thread, not session data, and stay so a redelivered
-- start cannot revive the ended session.
CREATE OR REPLACE FUNCTION delete_repository_data(target_repository_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_session_cleanup (session_id, repository_id, generation, native_session_id)
    SELECT session_id, repository_id, generation, native_session_id FROM agent_session
    WHERE repository_id = target_repository_id
    ON CONFLICT (session_id) DO NOTHING;
  DELETE FROM workflow_outbox WHERE payload->>'sessionId' IN
    (SELECT session_id FROM agent_session WHERE repository_id = target_repository_id);
  DELETE FROM slack_thread WHERE repository_id = target_repository_id
    OR session_id IN (SELECT session_id FROM agent_session WHERE repository_id = target_repository_id);
  DELETE FROM agent_session WHERE repository_id = target_repository_id;
  DELETE FROM github_recovery_attempt WHERE repository_id = target_repository_id;
  UPDATE github_repository SET generation_floor = GREATEST(generation_floor + 1,
    COALESCE((SELECT MAX(requested_generation) FROM sync_target WHERE scope->>'repositoryId' = target_repository_id), 0))
    WHERE repository_id = target_repository_id;
  DELETE FROM workflow_outbox WHERE payload->>'repositoryId' = target_repository_id OR payload->'scope'->>'repositoryId' = target_repository_id
    OR payload->>'deliveryId' IN (SELECT delivery_id FROM github_webhook_delivery WHERE repository_id = target_repository_id);
  DELETE FROM github_webhook_delivery WHERE repository_id = target_repository_id;
  DELETE FROM sync_target WHERE scope->>'repositoryId' = target_repository_id;
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
