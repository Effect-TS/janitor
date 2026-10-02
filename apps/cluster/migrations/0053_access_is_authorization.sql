-- Cloudflare Access alone decides who may use Janitor: anyone who signs in is
-- a teammate with every permission. Roles, removal and restoration are gone.
-- Teammate rows remain the identity that links, inputs and audit rows cite.

-- Links that removal disabled are released rather than revived: their owner
-- may have lost Access, and nothing else would stop them directing Janitor
-- through Slack. They can relink after signing in again.
UPDATE teammate_link SET status = 'disconnected', ended_at = COALESCE(ended_at, now())
WHERE status = 'disabled';

DROP INDEX teammate_link_owner;
DROP INDEX teammate_link_current;
CREATE UNIQUE INDEX teammate_link_owner ON teammate_link (platform, workspace_id, account_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX teammate_link_current ON teammate_link (teammate_id, platform, workspace_id)
  WHERE status = 'active';

ALTER TABLE teammate_link DROP CONSTRAINT teammate_link_status_check;
ALTER TABLE teammate_link ADD CONSTRAINT teammate_link_status_check
  CHECK (status IN ('active', 'disconnected', 'replaced'));

ALTER TABLE teammate
  DROP COLUMN role,
  DROP COLUMN status,
  DROP COLUMN removed_at;
