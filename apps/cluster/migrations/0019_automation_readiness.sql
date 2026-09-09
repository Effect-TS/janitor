ALTER TABLE github_repository ADD COLUMN automation_ready_at TIMESTAMPTZ;
ALTER TABLE github_repository ADD COLUMN synchronization_required_after TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP();
ALTER TABLE sync_target ADD COLUMN automation_event_at TIMESTAMPTZ;

-- Connection, resumption and restored access require a new complete synchronization.
CREATE FUNCTION reset_automation_readiness() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.connected IS DISTINCT FROM NEW.connected
    OR OLD.access IS DISTINCT FROM NEW.access THEN
    NEW.automation_ready_at := NULL;
    NEW.synchronization_required_after := CLOCK_TIMESTAMP();
    IF NEW.enabled AND NEW.connected AND NEW.access = 'accessible' THEN
      UPDATE sync_target SET retry_at = CLOCK_TIMESTAMP()
        WHERE scope->>'repositoryId' = NEW.repository_id AND (last_error IS NOT NULL OR health = 'blocked');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repository_automation_readiness BEFORE UPDATE OF enabled, connected, access
ON github_repository FOR EACH ROW EXECUTE FUNCTION reset_automation_readiness();

-- Eligibility belongs to an event admitted after readiness, never to synchronization itself.
CREATE FUNCTION repository_automation_ready(id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT COALESCE((SELECT r.connected AND r.enabled AND r.access = 'accessible'
    AND r.automation_ready_at IS NOT NULL AND i.status = 'active' AND i.sync_enabled
    FROM github_repository r JOIN github_installation i USING (installation_id)
    WHERE r.repository_id = id), FALSE)
$$;

CREATE FUNCTION entity_automation_eligible(id TEXT, item INTEGER, generation BIGINT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT repository_automation_ready(id) AND EXISTS (
    SELECT 1 FROM sync_target t JOIN github_repository r ON r.repository_id = id
    JOIN github_entity e ON e.repository_id = id AND e.number = item
    WHERE t.scope->>'repositoryId' = id AND t.scope->>'_tag' = 'Entity'
      AND (t.scope->>'number')::int = item AND t.requested_generation = generation
      AND t.verified_generation = generation AND t.automation_event_at > r.automation_ready_at
      AND e.state = 'open' AND NOT EXISTS (SELECT 1 FROM github_pull_request p
        WHERE p.repository_id = id AND p.number = item AND p.merged))
$$;

CREATE FUNCTION reset_installation_automation_readiness() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.sync_enabled IS DISTINCT FROM NEW.sync_enabled THEN
    UPDATE github_repository SET automation_ready_at = NULL,
      synchronization_required_after = CLOCK_TIMESTAMP() WHERE installation_id = NEW.installation_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_automation_readiness AFTER UPDATE OF status, sync_enabled
ON github_installation FOR EACH ROW EXECUTE FUNCTION reset_installation_automation_readiness();
