-- Conflicting legacy controls need an operator decision before conversion.
DO $$
DECLARE conflicts TEXT;
BEGIN
  SELECT string_agg(format('%s (%s/%s): automation=%s, sync=%s',
    repository_id, owner, repo, enabled, sync_enabled), E'\n' ORDER BY repository_id)
  INTO conflicts FROM github_repository WHERE connected AND enabled <> sync_enabled;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION E'Ambiguous repository pause settings:\n%', conflicts
      USING HINT = 'Choose paused or running for each listed repository and set enabled and sync_enabled to the same value before retrying.';
  END IF;
END $$;

ALTER TABLE github_repository DROP COLUMN sync_enabled;
-- Compatibility for readers of the old overview. There is only one writable flag.
ALTER TABLE github_repository ADD COLUMN sync_enabled BOOLEAN GENERATED ALWAYS AS (enabled) STORED;
ALTER TABLE github_repository ADD COLUMN webhooks_after TIMESTAMPTZ;
UPDATE github_repository SET webhooks_after = CLOCK_TIMESTAMP() WHERE NOT enabled;

CREATE OR REPLACE FUNCTION sync_scope_enabled(target JSONB) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT CASE target->>'_tag'
    WHEN 'AppInventory' THEN TRUE
    WHEN 'InstallationInventory' THEN COALESCE((
      SELECT sync_enabled FROM github_installation WHERE installation_id = target->>'installationId'
    ), TRUE)
    ELSE COALESCE((
      SELECT r.connected AND r.enabled AND COALESCE(i.sync_enabled, TRUE)
      FROM github_repository r LEFT JOIN github_installation i USING (installation_id)
      WHERE r.repository_id = target->>'repositoryId'
    ), TRUE)
  END
$$;

-- The repository row is locked before sync targets and held through external writes.
-- Advancing generations prevents old work becoming eligible after a later resume.
CREATE FUNCTION fence_repository_pause() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enabled AND NOT NEW.enabled) OR (OLD.connected AND NOT NEW.connected) THEN
    NEW.webhooks_after := CLOCK_TIMESTAMP();
    UPDATE sync_target SET requested_generation = requested_generation + 1,
      completed_generation = requested_generation + 1,
      dispatched_generation = requested_generation + 1,
      execution_generation = NULL, active_generation = NULL, active_sequence = NULL,
      active_full = FALSE, retry_at = NULL
      WHERE scope->>'repositoryId' = NEW.repository_id;
    DELETE FROM workflow_outbox WHERE accepted_at IS NULL AND
      (payload->'scope'->>'repositoryId' = NEW.repository_id OR payload->>'repositoryId' = NEW.repository_id);
  END IF;
  IF NOT OLD.enabled AND NEW.enabled THEN
    NEW.webhooks_after := CLOCK_TIMESTAMP();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repository_pause BEFORE UPDATE OF enabled, connected ON github_repository
FOR EACH ROW EXECUTE FUNCTION fence_repository_pause();

-- Fence work that was already pending for legacy paused repositories at deployment.
UPDATE sync_target SET requested_generation = requested_generation + 1,
  completed_generation = requested_generation + 1,
  dispatched_generation = requested_generation + 1, execution_generation = NULL,
  active_generation = NULL, active_sequence = NULL, active_full = FALSE, retry_at = NULL
WHERE scope->>'repositoryId' IN (SELECT repository_id FROM github_repository WHERE NOT enabled);
DELETE FROM workflow_outbox WHERE accepted_at IS NULL AND
  COALESCE(payload->'scope'->>'repositoryId', payload->>'repositoryId') IN
    (SELECT repository_id FROM github_repository WHERE NOT enabled);
