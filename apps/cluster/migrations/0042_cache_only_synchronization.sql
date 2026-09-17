-- Synchronization is solely a UI cache (ADR 0006). Repository eligibility
-- alone decides admission, access checks and the webhook admission boundary;
-- the cache's readiness, its health and the installation sync setting no
-- longer appear in them. Labeling reads GitHub directly, so the readiness
-- bookkeeping the synchronized path needed goes.

-- Access and installation changes fence through one function: supersede
-- in-flight cache runs, ask each track for a full refresh once the cache may
-- run again, retry failed items, and discard pending outbox work. The
-- eligibility generation already refuses work accepted before the change;
-- the pause trigger keeps fencing pause and disconnection.
CREATE FUNCTION fence_repository_work(id TEXT) RETURNS VOID LANGUAGE SQL AS $$
  UPDATE sync_target SET requested_generation = requested_generation + 1,
    completed_generation = requested_generation + 1, dispatched_generation = requested_generation + 1,
    execution_generation = NULL, active_generation = NULL, active_sequence = NULL, active_full = FALSE,
    full_requested = full_requested OR scope->>'_tag' = 'RepositoryTrack',
    retry_at = CASE WHEN scope->>'_tag' = 'RepositoryTrack' OR last_error IS NOT NULL OR health = 'blocked'
      THEN CLOCK_TIMESTAMP() ELSE NULL END
    WHERE scope->>'repositoryId' = id;
  DELETE FROM workflow_outbox WHERE accepted_at IS NULL AND
    COALESCE(payload->'scope'->>'repositoryId', payload->>'repositoryId') = id;
$$;

DROP TRIGGER z_repository_access_fence ON github_repository;
CREATE OR REPLACE FUNCTION fence_repository_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.access IS DISTINCT FROM NEW.access
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id THEN
    NEW.webhooks_after := CLOCK_TIMESTAMP();
    PERFORM fence_repository_work(NEW.repository_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER z_repository_access_fence BEFORE UPDATE OF access, installation_id
ON github_repository FOR EACH ROW EXECUTE FUNCTION fence_repository_access();

-- An installation's status and verified access fence every repository it
-- holds. Its sync setting is a cache control: sync_scope_enabled stops cache
-- runs, and nothing else changes.
DROP TRIGGER installation_automation_readiness ON github_installation;
DROP FUNCTION reset_installation_automation_readiness();
CREATE FUNCTION fence_installation_access() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.access_error IS DISTINCT FROM NEW.access_error THEN
    UPDATE github_repository SET webhooks_after = CLOCK_TIMESTAMP()
      WHERE installation_id = NEW.installation_id;
    PERFORM fence_repository_work(repository_id) FROM github_repository
      WHERE installation_id = NEW.installation_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER installation_access_fence AFTER UPDATE OF status, access_error
ON github_installation FOR EACH ROW EXECUTE FUNCTION fence_installation_access();

-- The cache refreshes connected, unpaused repositories with current access
-- whose installation sync setting is on.
CREATE OR REPLACE FUNCTION sync_scope_enabled(target JSONB) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT CASE target->>'_tag'
    WHEN 'AppInventory' THEN TRUE
    WHEN 'InstallationInventory' THEN COALESCE((
      SELECT sync_enabled FROM github_installation WHERE installation_id = target->>'installationId'
    ), TRUE)
    ELSE COALESCE((SELECT r.connected AND r.enabled AND i.sync_enabled
        AND repository_access_current(r.repository_id)
      FROM github_repository r JOIN github_installation i USING (installation_id)
      WHERE r.repository_id = target->>'repositoryId'), FALSE)
  END
$$;

-- Legacy readiness: the synchronized labeling path was its last reader.
DROP TRIGGER repository_automation_readiness ON github_repository;
DROP FUNCTION reset_automation_readiness();
DROP FUNCTION entity_automation_eligible(TEXT, INTEGER, BIGINT);
DROP FUNCTION repository_automation_ready(TEXT);
DROP FUNCTION repository_access_available(TEXT);
ALTER TABLE github_repository
  DROP COLUMN automation_ready_at,
  DROP COLUMN synchronization_required_after,
  DROP COLUMN sync_enabled;
ALTER TABLE sync_target DROP COLUMN automation_event_at;
