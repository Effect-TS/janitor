-- Maintenance barrier for controlled runner upgrades.
--
-- An operator establishes one durable barrier before any affected session is
-- enumerated, so sessions started and inputs accepted afterwards cannot escape
-- it: intake keeps accepting authorized inputs in order while the handoff
-- withholds dispatch to the runner. Each session's hold is then requested from
-- its runner and its acknowledgement recorded; a runner that cannot be
-- reached is never counted as quiescent. Release verifies the deployed runner
-- first and then releases each matching hold, keeping any session whose own
-- checks fail held for repair.

CREATE TABLE agent_maintenance (
  epoch BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  state TEXT NOT NULL CHECK (state IN ('holding', 'held', 'releasing', 'released')),
  reason TEXT NOT NULL,
  -- The runner release identity expected once the rollout is complete, when known.
  expected_release TEXT,
  -- What the release verified about the deployed runner, for the record.
  verified_release TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  released_at TIMESTAMPTZ
);
-- At most one barrier is active; dispatch checks for its existence.
CREATE UNIQUE INDEX agent_maintenance_active_idx ON agent_maintenance ((TRUE))
  WHERE state <> 'released';

-- One row per session and barrier: the hold request, its acknowledgement and
-- the outcome of its release. Disconnection deletes the session row and with
-- it the hold record; that fence outranks any release.
CREATE TABLE agent_session_maintenance (
  session_id TEXT NOT NULL REFERENCES agent_session (session_id) ON DELETE CASCADE,
  epoch BIGINT NOT NULL REFERENCES agent_maintenance (epoch),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'held', 'quiescent', 'released', 'refused')),
  -- The runner reported an operation whose outcome it cannot know; recovery stays blocked.
  uncertain BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- The checks the runner reported on its last release attempt.
  checks JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (session_id, epoch)
);
CREATE INDEX agent_session_maintenance_epoch_idx ON agent_session_maintenance (epoch, state);
