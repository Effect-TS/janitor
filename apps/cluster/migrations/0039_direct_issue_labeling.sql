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
-- changes (an installation's sync setting, for example). That is a cache
-- lifecycle event and must not discard direct issue work; connection, pause
-- and access changes still do, and the eligibility generation refuses work
-- accepted before them.
CREATE OR REPLACE FUNCTION fence_repository_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.access IS DISTINCT FROM NEW.access OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.synchronization_required_after IS DISTINCT FROM NEW.synchronization_required_after THEN
    NEW.automation_ready_at := NULL;
    NEW.synchronization_required_after := CLOCK_TIMESTAMP();
    NEW.webhooks_after := CLOCK_TIMESTAMP();
    UPDATE sync_target SET requested_generation = requested_generation + 1,
      completed_generation = requested_generation + 1, dispatched_generation = requested_generation + 1,
      execution_generation = NULL, active_generation = NULL, active_sequence = NULL,
      active_full = FALSE,
      retry_at = CASE WHEN last_error IS NOT NULL OR health = 'blocked' THEN CLOCK_TIMESTAMP() ELSE NULL END,
      automation_event_at = NULL
      WHERE scope->>'repositoryId' = NEW.repository_id;
    DELETE FROM workflow_outbox WHERE accepted_at IS NULL AND
      COALESCE(payload->'scope'->>'repositoryId', payload->>'repositoryId') = NEW.repository_id
      AND (workflow_tag <> 'Janitor/LabelIssueV1'
        OR OLD.access IS DISTINCT FROM NEW.access
        OR OLD.installation_id IS DISTINCT FROM NEW.installation_id);
  END IF;
  RETURN NEW;
END $$;
