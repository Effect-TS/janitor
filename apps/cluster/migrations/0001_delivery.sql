-- Durable record of every accepted GitHub webhook delivery. Payloads are
-- ciphertext; identifiers, digests, and audit columns outlive content purges.
CREATE TABLE github_webhook_delivery (
  delivery_id TEXT PRIMARY KEY,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_name TEXT NOT NULL,
  installation_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  journaled_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  encryption_algorithm TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_iv BYTEA NOT NULL,
  payload BYTEA NOT NULL,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending', 'projected', 'unsupported', 'failed')),
  projection_error TEXT,
  projected_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ
);

CREATE INDEX github_webhook_delivery_pending_idx
  ON github_webhook_delivery (sequence)
  WHERE projection_status = 'pending';

CREATE INDEX github_webhook_delivery_installation_idx
  ON github_webhook_delivery (installation_id)
  WHERE purged_at IS NULL;

-- Requests to submit workflow executions. Rows are claimed with a bounded
-- lease and fencing token so duplicate dispatchers cannot both complete one.
CREATE TABLE workflow_outbox (
  workflow_tag TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  due_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (workflow_tag, execution_key)
);

CREATE INDEX workflow_outbox_due_idx
  ON workflow_outbox (due_at)
  WHERE accepted_at IS NULL;
