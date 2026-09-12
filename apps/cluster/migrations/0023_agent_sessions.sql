-- Agent sessions and their runner handoff. Janitor owns session identity,
-- accepted inputs in one per-session acceptance order, the durable handoff
-- state until the runner confirms native admission, consumer cursors and
-- rebuildable projections. The runner owns the native conversation.
CREATE TABLE agent_session (
  session_id TEXT PRIMARY KEY CHECK (session_id ~ '^[A-Za-z0-9_-]{1,120}$'),
  generation BIGINT NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  native_session_id TEXT,
  model_configuration_id TEXT,
  -- creating: native conversation not yet confirmed; ready: admissions flow;
  -- blocked: the runner refuses work for a recorded reason; disconnected: fenced.
  runner_state TEXT NOT NULL DEFAULT 'creating'
    CHECK (runner_state IN ('creating', 'ready', 'blocked', 'disconnected')),
  runner_error TEXT,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  -- One delivery loop per session at a time; a lost holder expires.
  handoff_lease_token TEXT,
  handoff_lease_until TIMESTAMPTZ
);

-- Accepted inputs. Frozen content and attribution never change after
-- acceptance; the runner message id is the stable identity retried after a
-- lost receipt. Handoff state tracks the inter-service handoff, not execution.
CREATE TABLE agent_input (
  input_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_session (session_id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  contribution_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('slack', 'github', 'driver')),
  author JSONB NOT NULL,
  text TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  runner_message_id TEXT NOT NULL UNIQUE CHECK (runner_message_id ~ '^msg_[A-Za-z0-9_-]{1,120}$'),
  -- pending: never sent; uncertain: a request was sent and no receipt is held;
  -- admitted: durable runner receipt held; rejected: terminal runner refusal.
  handoff_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (handoff_state IN ('pending', 'uncertain', 'admitted', 'rejected')),
  handoff_attempts INTEGER NOT NULL DEFAULT 0,
  handoff_error TEXT,
  receipt JSONB,
  admitted_at TIMESTAMPTZ,
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, contribution_key)
);

CREATE INDEX agent_input_unsettled_idx
  ON agent_input (session_id, sequence)
  WHERE handoff_state IN ('pending', 'uncertain');

-- Exclusive durable event cursor per consumer. Advanced atomically with the
-- consumer's projection so replay is harmless.
CREATE TABLE agent_event_cursor (
  session_id TEXT NOT NULL REFERENCES agent_session (session_id) ON DELETE CASCADE,
  consumer TEXT NOT NULL,
  cursor BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, consumer)
);

-- The persisted catch-up obligation. Every retained session always has one;
-- the next due time is written before the current read releases its lease.
CREATE TABLE agent_catchup (
  session_id TEXT PRIMARY KEY REFERENCES agent_session (session_id) ON DELETE CASCADE,
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  cadence TEXT NOT NULL DEFAULT 'active' CHECK (cadence IN ('active', 'idle')),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  last_read_at TIMESTAMPTZ,
  last_error TEXT
);

CREATE INDEX agent_catchup_due_idx ON agent_catchup (due_at);

-- Rebuildable per-session projection: execution state, cumulative usage
-- replaced under cursor protection, and freshness.
CREATE TABLE agent_session_projection (
  session_id TEXT PRIMARY KEY REFERENCES agent_session (session_id) ON DELETE CASCADE,
  execution TEXT NOT NULL DEFAULT 'idle' CHECK (execution IN ('working', 'idle', 'blocked', 'failed')),
  reason TEXT,
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  usage_seq BIGINT,
  usage_input BIGINT,
  usage_output BIGINT,
  usage_reasoning BIGINT,
  usage_cache_read BIGINT,
  usage_cache_write BIGINT,
  activity_at TIMESTAMPTZ,
  freshness_at TIMESTAMPTZ
);

-- Assistant responses keyed by their durable event sequence; replay is a no-op.
CREATE TABLE agent_response (
  session_id TEXT NOT NULL REFERENCES agent_session (session_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, seq)
);
