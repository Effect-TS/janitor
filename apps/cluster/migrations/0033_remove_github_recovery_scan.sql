-- Remove the GitHub recovery scan.
--
-- GitHub feedback arrives by webhook only. The scan that paged the App's
-- retained delivery history to backfill missed deliveries is gone, together
-- with its scan record, retained attempts and live triggers. The Slack thread
-- scan and feedback hydration keep their tables and triggers. Repository
-- deletion no longer clears retained attempts.
DROP TRIGGER IF EXISTS live_session_recovery ON platform_recovery;
DROP TRIGGER IF EXISTS live_session_recovery_attempt ON github_recovery_attempt;
DROP TRIGGER IF EXISTS live_session_recovery_attempt_state ON github_recovery_attempt;
DROP TABLE IF EXISTS github_recovery_attempt;
DROP TABLE IF EXISTS platform_recovery;
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
