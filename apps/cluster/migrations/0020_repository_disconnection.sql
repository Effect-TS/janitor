-- Keep a fencing counter with repository identity so deleted target generations
-- cannot be reused by a fresh connection.
ALTER TABLE github_repository ADD COLUMN generation_floor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE github_webhook_delivery ADD COLUMN repository_id TEXT;
CREATE INDEX github_webhook_delivery_repository_idx ON github_webhook_delivery(repository_id);
ALTER TABLE labeling_ai_claim ADD COLUMN repository_id TEXT;
-- Claims are transient; old workers must be stopped before migration.
DELETE FROM labeling_ai_claim;

CREATE FUNCTION delete_repository_data(target_repository_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
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
