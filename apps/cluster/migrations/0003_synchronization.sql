-- Shared GitHub API budget: observed limits and cooldowns per credential and
-- resource bucket, bounded leases for in-flight requests, and an encrypted
-- cache of representations for conditional requests.
CREATE TABLE github_rate_budget (
  scope_key TEXT NOT NULL,
  resource TEXT NOT NULL,
  rate_limit INTEGER,
  remaining INTEGER,
  used INTEGER,
  reset_at TIMESTAMPTZ,
  retry_after_until TIMESTAMPTZ,
  secondary_cooldown_until TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  secondary_strikes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_key, resource)
);

CREATE TABLE github_rate_lease (
  lease_token TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  resource TEXT NOT NULL,
  priority TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX github_rate_lease_scope_idx ON github_rate_lease (scope_key, resource, expires_at);

CREATE TABLE github_http_cache (
  scope_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  repository_id TEXT,
  etag TEXT NOT NULL,
  next_url TEXT,
  encryption_key_id TEXT NOT NULL,
  encryption_iv BYTEA NOT NULL,
  body BYTEA NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (scope_key, request_key)
);

CREATE INDEX github_http_cache_repository_idx ON github_http_cache (repository_id);

-- One row per synchronization scope. Generation counters coalesce
-- invalidations; verified columns back the freshness contract; the planner
-- records when it last created repair generations.
CREATE TABLE sync_target (
  scope_key TEXT PRIMARY KEY,
  scope JSONB NOT NULL,
  requested_generation BIGINT NOT NULL DEFAULT 0,
  dispatched_generation BIGINT NOT NULL DEFAULT 0,
  completed_generation BIGINT NOT NULL DEFAULT 0,
  verified_generation BIGINT NOT NULL DEFAULT 0,
  requested_sequence BIGINT,
  verified_sequence BIGINT,
  verified_at TIMESTAMPTZ,
  scan_watermark TIMESTAMPTZ,
  full_requested BOOLEAN NOT NULL DEFAULT FALSE,
  health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'blocked')),
  blocked_reason TEXT,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  execution_generation BIGINT,
  active_generation BIGINT,
  active_sequence BIGINT,
  active_full BOOLEAN NOT NULL DEFAULT FALSE,
  last_full_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ
);

CREATE INDEX sync_target_pending_idx
  ON sync_target (updated_at)
  WHERE requested_generation > completed_generation;

CREATE INDEX sync_target_retry_idx ON sync_target (retry_at) WHERE retry_at IS NOT NULL;

CREATE TABLE sync_repair_state (
  name TEXT PRIMARY KEY,
  last_planned_at TIMESTAMPTZ NOT NULL,
  generations_created INTEGER NOT NULL DEFAULT 0
);

-- Scheduled deletion of private content after uninstall or confirmed access
-- loss, with a grace period during which restored access cancels it.
CREATE TABLE content_purge (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('installation', 'repository')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (subject_kind, subject_id)
);

CREATE INDEX content_purge_due_idx ON content_purge (due_at) WHERE completed_at IS NULL;
