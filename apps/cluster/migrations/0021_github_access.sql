-- Unknown permissions fail closed until installation discovery verifies them.
ALTER TABLE github_installation ADD COLUMN access_error TEXT DEFAULT
  'GitHub permissions have not been verified. Refresh repositories to verify access.';

CREATE FUNCTION repository_access_available(id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT COALESCE((SELECT r.access = 'accessible' AND i.status = 'active'
    AND i.access_error IS NULL AND i.sync_enabled
    FROM github_repository r JOIN github_installation i USING (installation_id)
    WHERE r.repository_id = id), FALSE)
$$;

CREATE OR REPLACE FUNCTION sync_scope_enabled(target JSONB) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT CASE target->>'_tag'
    WHEN 'AppInventory' THEN TRUE
    WHEN 'InstallationInventory' THEN COALESCE((
      SELECT sync_enabled FROM github_installation WHERE installation_id = target->>'installationId'
    ), TRUE)
    ELSE COALESCE((SELECT r.connected AND r.enabled AND repository_access_available(r.repository_id)
      FROM github_repository r WHERE r.repository_id = target->>'repositoryId'), FALSE)
  END
$$;

CREATE OR REPLACE FUNCTION repository_automation_ready(id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT COALESCE((SELECT r.connected AND r.enabled AND r.automation_ready_at IS NOT NULL
    AND repository_access_available(id) FROM github_repository r WHERE r.repository_id = id), FALSE)
$$;

-- Serialize access changes with repository work and discard every old generation.
CREATE FUNCTION fence_repository_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
      COALESCE(payload->'scope'->>'repositoryId', payload->>'repositoryId') = NEW.repository_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER z_repository_access_fence BEFORE UPDATE OF access, installation_id, synchronization_required_after
ON github_repository FOR EACH ROW EXECUTE FUNCTION fence_repository_access();

CREATE OR REPLACE FUNCTION reset_installation_automation_readiness() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.sync_enabled IS DISTINCT FROM NEW.sync_enabled
    OR OLD.access_error IS DISTINCT FROM NEW.access_error THEN
    UPDATE github_repository SET automation_ready_at = NULL,
      synchronization_required_after = CLOCK_TIMESTAMP() WHERE installation_id = NEW.installation_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER installation_automation_readiness ON github_installation;
CREATE TRIGGER installation_automation_readiness AFTER UPDATE OF status, sync_enabled, access_error
ON github_installation FOR EACH ROW EXECUTE FUNCTION reset_installation_automation_readiness();

UPDATE github_repository SET synchronization_required_after = CLOCK_TIMESTAMP();
-- Access loss retains stored data, including purges scheduled by older releases.
DELETE FROM content_purge WHERE completed_at IS NULL
  AND reason IN ('installation-deleted', 'repository-removed');
