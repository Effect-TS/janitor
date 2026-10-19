-- The block reason is a code; callers own its wording. Same precedence as
-- 0038: lost access is named ahead of a pause.
CREATE OR REPLACE FUNCTION repository_block_reason(id TEXT) RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM github_repository WHERE repository_id = id)
    THEN 'not-connected'
  ELSE (
    SELECT CASE
      WHEN NOT r.connected AND r.disconnected_at IS NULL THEN 'not-connected'
      WHEN NOT r.connected THEN 'disconnected'
      WHEN NOT repository_access_current(r.repository_id) THEN 'access-unavailable'
      WHEN NOT r.enabled THEN 'paused'
      ELSE NULL END
    FROM github_repository r WHERE r.repository_id = id
  ) END
$$;
