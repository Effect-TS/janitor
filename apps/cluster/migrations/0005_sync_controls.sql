-- Keep local data and labeling configuration while pausing GitHub polling.
ALTER TABLE github_repository ADD COLUMN sync_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE github_installation ADD COLUMN sync_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- One eligibility check for requests, retries, execution claims, and status.
-- Unknown scopes may be requested before webhook projection creates their rows.
CREATE FUNCTION sync_scope_enabled(target JSONB) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT CASE target->>'_tag'
    WHEN 'AppInventory' THEN TRUE
    WHEN 'InstallationInventory' THEN COALESCE((
      SELECT sync_enabled FROM github_installation
      WHERE installation_id = target->>'installationId'
    ), TRUE)
    ELSE COALESCE((
      SELECT r.sync_enabled AND COALESCE(i.sync_enabled, TRUE)
      FROM github_repository r
      LEFT JOIN github_installation i USING (installation_id)
      WHERE r.repository_id = target->>'repositoryId'
    ), TRUE)
  END
$$;
