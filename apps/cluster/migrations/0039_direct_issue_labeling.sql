-- Issue labeling evaluates current GitHub facts directly (ADR 0006). Its
-- records share the reconciliation ledger with the legacy synchronized path;
-- `source` says which path produced a row. Pull requests stay on the
-- synchronized path until their own migration.
ALTER TABLE labeling_reconciliation
  ADD COLUMN source TEXT NOT NULL DEFAULT 'sync' CHECK (source IN ('sync', 'github'));

-- Cutover: pending legacy issue jobs never run. Their rows close as
-- superseded so the activity page explains the gap; a new issue event takes
-- the direct path. Jobs already accepted by the engine are refused by the
-- legacy workflow itself when it finds an issue.
DELETE FROM workflow_outbox o USING github_entity e
  WHERE o.workflow_tag = 'Janitor/ReconcileEntityV1' AND o.accepted_at IS NULL
    AND e.repository_id = o.payload->>'repositoryId'
    AND e.number = (o.payload->>'number')::int AND e.kind = 'issue';
UPDATE labeling_reconciliation r
  SET outcome = 'superseded', completed_at = CLOCK_TIMESTAMP(),
      detail = 'Issue labeling moved to direct GitHub evaluation'
  FROM github_entity e
  WHERE r.outcome IS NULL AND r.source = 'sync'
    AND e.repository_id = r.repository_id AND e.number = r.number AND e.kind = 'issue';

-- The access fence also fires when only the synchronization requirement
-- changes. An installation's sync setting is a cache-only change: it must
-- neither discard direct issue work nor move the webhook admission boundary
-- that would drop the events creating it. The installation trigger marks
-- such a change for the transaction; status and access-error changes, and
-- every repository connection, pause, access or installation change, still
-- fence both, and the pinned eligibility generation refuses work accepted
-- before them.
CREATE OR REPLACE FUNCTION reset_installation_automation_readiness() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.sync_enabled IS DISTINCT FROM NEW.sync_enabled
    OR OLD.access_error IS DISTINCT FROM NEW.access_error THEN
    PERFORM set_config('janitor.cache_only_change',
      CASE WHEN OLD.status IS NOT DISTINCT FROM NEW.status
        AND OLD.access_error IS NOT DISTINCT FROM NEW.access_error THEN 'on' ELSE 'off' END, TRUE);
    UPDATE github_repository SET automation_ready_at = NULL,
      synchronization_required_after = CLOCK_TIMESTAMP() WHERE installation_id = NEW.installation_id;
    PERFORM set_config('janitor.cache_only_change', 'off', TRUE);
  END IF;
  RETURN NEW;
END $$;

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
      AND (workflow_tag <> 'Janitor/LabelIssueV1' OR NOT cache_only);
  END IF;
  RETURN NEW;
END $$;
