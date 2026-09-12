-- Teammates are the stable identity behind Access sign-in. The verified
-- issuer/subject pair is the only ownership proof; email is display only.
CREATE TABLE teammate (
  teammate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  -- Advances on every role, status or link change so later readers can tell
  -- which authorization state an accepted input was evaluated against.
  identity_revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  UNIQUE (issuer, subject)
);

-- A verified platform account. Rows are never deleted: accepted work keeps
-- pointing at the link that authorized it.
--   active        may direct Janitor
--   disconnected  the teammate let it go; the account is free to relink
--   disabled      removal disabled it; the teammate still owns the account
--   replaced      the teammate proved a different account for this workspace
CREATE TABLE teammate_link (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id UUID NOT NULL REFERENCES teammate(teammate_id),
  platform TEXT NOT NULL CHECK (platform IN ('slack', 'github')),
  workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disconnected', 'disabled', 'replaced')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
-- Each workspace/account pair belongs to one teammate at a time. A disabled
-- link keeps the ownership so a removed teammate's account cannot be claimed.
CREATE UNIQUE INDEX teammate_link_owner ON teammate_link (platform, workspace_id, account_id)
  WHERE status IN ('active', 'disabled');
-- One link per teammate and workspace; replacement retires the older row.
CREATE UNIQUE INDEX teammate_link_current ON teammate_link (teammate_id, platform, workspace_id)
  WHERE status IN ('active', 'disabled');
CREATE INDEX teammate_link_teammate ON teammate_link (teammate_id);

-- Bound single-use state and nonce for an OAuth/OIDC round trip.
CREATE TABLE teammate_link_attempt (
  state UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id UUID NOT NULL REFERENCES teammate(teammate_id),
  platform TEXT NOT NULL CHECK (platform IN ('slack', 'github')),
  nonce UUID NOT NULL DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '20 minutes'
);

CREATE TABLE teammate_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_teammate_id UUID REFERENCES teammate(teammate_id),
  subject_teammate_id UUID NOT NULL REFERENCES teammate(teammate_id),
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
