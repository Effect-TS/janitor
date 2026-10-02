-- Issue review and the Slack integration are removed. Their tables, fences,
-- queued work and links go with them; labeling and sync are unchanged.

DROP TRIGGER issue_review_fence ON github_repository;
DROP TRIGGER remove_review_ownership ON github_repository;

DROP TABLE issue_review_action, issue_review_message, issue_review_draft_owner,
  issue_review_workspace_cleanup, issue_review_run, issue_review_receipt,
  issue_review_issue, issue_review_setting CASCADE;

DROP FUNCTION fence_issue_review();
DROP FUNCTION fence_review_dry_run();
DROP FUNCTION remove_review_run_artifacts();
DROP FUNCTION expire_review_history();
DROP FUNCTION fence_expired_review_write();
DROP FUNCTION fence_review_detail_write();
DROP FUNCTION remove_review_ownership();
DROP FUNCTION fence_review_admission_insert();

DELETE FROM workflow_outbox WHERE workflow_tag IN ('Janitor/AdmitReviewV1', 'Janitor/ReviewActionV1');
DELETE FROM live_notification WHERE topic = 'review';

CREATE OR REPLACE FUNCTION delete_repository_data(target_repository_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
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

-- Only GitHub accounts can be linked now.
DELETE FROM teammate_link_attempt WHERE platform = 'slack';
DELETE FROM teammate_link WHERE platform = 'slack';
ALTER TABLE teammate_link DROP CONSTRAINT teammate_link_platform_check;
ALTER TABLE teammate_link ADD CONSTRAINT teammate_link_platform_check CHECK (platform = 'github');
ALTER TABLE teammate_link_attempt DROP CONSTRAINT teammate_link_attempt_platform_check;
ALTER TABLE teammate_link_attempt ADD CONSTRAINT teammate_link_attempt_platform_check
  CHECK (platform = 'github');
