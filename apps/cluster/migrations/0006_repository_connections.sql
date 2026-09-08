-- Preserve every existing workspace row, including paused repositories.
-- Discovery explicitly inserts disconnected rows; direct operator/seed inserts retain
-- the legacy connected default for compatibility.
ALTER TABLE github_repository ADD COLUMN connected BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE github_repository ADD COLUMN disconnected_at TIMESTAMPTZ;
CREATE TABLE repository_connection_audit (
  id BIGSERIAL PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES github_repository(repository_id),
  action TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE repository_connection_attempt (
  state UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '20 minutes'
);
CREATE OR REPLACE FUNCTION sync_scope_enabled(target JSONB) RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT CASE target->>'_tag'
    WHEN 'AppInventory' THEN TRUE
    WHEN 'InstallationInventory' THEN COALESCE((
      SELECT sync_enabled FROM github_installation
      WHERE installation_id = target->>'installationId'
    ), TRUE)
    ELSE COALESCE((
      SELECT r.connected AND r.sync_enabled AND COALESCE(i.sync_enabled, TRUE)
      FROM github_repository r LEFT JOIN github_installation i USING (installation_id)
      WHERE r.repository_id = target->>'repositoryId'
    ), TRUE)
  END
$$;
