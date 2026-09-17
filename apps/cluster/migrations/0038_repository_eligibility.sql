-- Repository eligibility is connection, pause and current GitHub access.
-- Synchronization is a UI cache: its progress or failure never blocks work.
-- Legacy labeling keeps repository_access_available and
-- repository_automation_ready until it reads GitHub directly.

-- Current access is the repository's access record and its installation's
-- verified state. The installation sync setting only controls the cache.
CREATE FUNCTION repository_access_current(id TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT COALESCE((SELECT r.access = 'accessible' AND i.status = 'active' AND i.access_error IS NULL
    FROM github_repository r JOIN github_installation i USING (installation_id)
    WHERE r.repository_id = id), FALSE)
$$;

-- The one concrete reason repository work is refused, or NULL when eligible.
-- Lost access is named ahead of a pause because it needs action on GitHub;
-- restored access leaves a deliberately paused repository paused.
CREATE OR REPLACE FUNCTION repository_block_reason(id TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM github_repository WHERE repository_id = id)
    THEN 'This repository is not connected to Janitor.'
  ELSE (
    SELECT CASE
      WHEN NOT r.connected AND r.disconnected_at IS NULL THEN 'This repository is not connected to Janitor.'
      WHEN NOT r.connected THEN 'This repository is disconnected from Janitor.'
      WHEN NOT repository_access_current(r.repository_id) THEN
        'GitHub access to this repository is unavailable. Restore access on GitHub.'
      WHEN NOT r.enabled THEN 'This repository is paused in Janitor. Resume it to continue.'
      ELSE NULL END
    FROM github_repository r WHERE r.repository_id = id
  ) END
$$;

-- Every connection, pause, access or installation change starts a new
-- eligibility generation. Work accepted under an earlier generation stays
-- fenced after restoration; the pause and access triggers already discard
-- pending outbox work.
ALTER TABLE github_repository ADD COLUMN eligibility_generation BIGINT NOT NULL DEFAULT 0;

CREATE FUNCTION advance_repository_eligibility() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connected IS DISTINCT FROM NEW.connected OR OLD.enabled IS DISTINCT FROM NEW.enabled
    OR OLD.access IS DISTINCT FROM NEW.access
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id THEN
    NEW.eligibility_generation := OLD.eligibility_generation + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER repository_eligibility BEFORE UPDATE OF connected, enabled, access, installation_id
ON github_repository FOR EACH ROW EXECUTE FUNCTION advance_repository_eligibility();

CREATE FUNCTION advance_installation_eligibility() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status OR OLD.access_error IS DISTINCT FROM NEW.access_error THEN
    UPDATE github_repository SET eligibility_generation = eligibility_generation + 1
      WHERE installation_id = NEW.installation_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER installation_eligibility AFTER UPDATE OF status, access_error
ON github_installation FOR EACH ROW EXECUTE FUNCTION advance_installation_eligibility();
