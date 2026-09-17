-- Pull request labeling evaluates current GitHub facts directly (ADR 0006),
-- through the same workflow as issues. Every new ledger row is a direct
-- evaluation; `source = 'sync'` only describes history.
ALTER TABLE labeling_reconciliation ALTER COLUMN source SET DEFAULT 'github';

-- Cutover: pending legacy pull request jobs never run and their rows close as
-- superseded so the activity page explains the gap. Nothing registers the
-- legacy workflow any more, so a job the engine already accepted cannot
-- resume; stop old workers before applying this migration so an in-flight
-- synchronized plan cannot publish afterwards.
DELETE FROM workflow_outbox
  WHERE workflow_tag = 'Janitor/ReconcileEntityV1' AND accepted_at IS NULL;
UPDATE labeling_reconciliation
  SET outcome = 'superseded', completed_at = CLOCK_TIMESTAMP(),
      detail = 'Pull request labeling moved to direct GitHub evaluation'
  WHERE outcome IS NULL AND source = 'sync';

-- The direct workflow now labels items of both kinds under one tag. Pending
-- issue work carries over unchanged; only its tag and key are renamed.
UPDATE workflow_outbox
  SET workflow_tag = 'Janitor/LabelItemV1',
      execution_key = 'label-item:' || substr(execution_key, length('label-issue:') + 1)
  WHERE workflow_tag = 'Janitor/LabelIssueV1' AND accepted_at IS NULL;

-- Direct issue work the engine had already accepted under the old tag cannot
-- resume, since nothing registers that workflow any more. Its rows close as
-- superseded and their planned actions settle as failed, so an attempt still
-- running on an old worker finds nothing left to write. The next issue event
-- evaluates afresh.
UPDATE labeling_label_action a
  SET status = 'failed', detail = 'Direct labeling restarted at cutover', completed_at = CLOCK_TIMESTAMP()
  FROM workflow_outbox o
  WHERE a.status = 'planned' AND o.workflow_tag = 'Janitor/LabelIssueV1' AND o.accepted_at IS NOT NULL
    AND a.repository_id = o.payload->>'repositoryId' AND a.number = (o.payload->>'number')::int
    AND a.snapshot_generation = (o.payload->>'snapshotGeneration')::bigint
    AND a.rules_revision = (o.payload->>'rulesRevision')::int;
UPDATE labeling_reconciliation r
  SET outcome = 'superseded', completed_at = CLOCK_TIMESTAMP(),
      detail = 'Direct labeling restarted at cutover'
  FROM workflow_outbox o
  WHERE r.outcome IS NULL AND o.workflow_tag = 'Janitor/LabelIssueV1' AND o.accepted_at IS NOT NULL
    AND r.repository_id = o.payload->>'repositoryId' AND r.number = (o.payload->>'number')::int
    AND r.snapshot_generation = (o.payload->>'snapshotGeneration')::bigint
    AND r.rules_revision = (o.payload->>'rulesRevision')::int;
DELETE FROM workflow_outbox WHERE workflow_tag = 'Janitor/LabelIssueV1';

-- The cache-only exemption of the access fence follows the renamed tag.
CREATE OR REPLACE FUNCTION fence_repository_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  cache_only BOOLEAN := COALESCE(current_setting('janitor.cache_only_change', TRUE), 'off') = 'on'
    AND OLD.access IS NOT DISTINCT FROM NEW.access
    AND OLD.installation_id IS NOT DISTINCT FROM NEW.installation_id;
BEGIN
  IF OLD.access IS DISTINCT FROM NEW.access OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.synchronization_required_after IS DISTINCT FROM NEW.synchronization_required_after THEN
    NEW.automation_ready_at := NULL;
    NEW.synchronization_required_after := CLOCK_TIMESTAMP();
    IF NOT cache_only THEN
      NEW.webhooks_after := CLOCK_TIMESTAMP();
    END IF;
    UPDATE sync_target SET requested_generation = requested_generation + 1,
      completed_generation = requested_generation + 1, dispatched_generation = requested_generation + 1,
      execution_generation = NULL, active_generation = NULL, active_sequence = NULL,
      active_full = FALSE,
      retry_at = CASE WHEN last_error IS NOT NULL OR health = 'blocked' THEN CLOCK_TIMESTAMP() ELSE NULL END,
      automation_event_at = NULL
      WHERE scope->>'repositoryId' = NEW.repository_id;
    DELETE FROM workflow_outbox WHERE accepted_at IS NULL AND
      COALESCE(payload->'scope'->>'repositoryId', payload->>'repositoryId') = NEW.repository_id
      AND (workflow_tag <> 'Janitor/LabelItemV1' OR NOT cache_only);
  END IF;
  RETURN NEW;
END $$;
