-- Owned classifiers reuse immutable policy versions and configuration snapshots.
-- Ownership survives rule deletion to keep retained history inaccessible as a reusable policy.
ALTER TABLE labeling_policy ADD COLUMN owner_rule_id text UNIQUE;
ALTER TABLE labeling_rule ADD COLUMN ai_definition jsonb;
ALTER TABLE labeling_rule ADD CONSTRAINT ai_preserve CHECK (ai_definition IS NULL OR on_no_match = 'preserve');
CREATE TABLE labeling_ai_claim (
  request_hash text PRIMARY KEY,
  owner text NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Track whether an empty collection was actually fetched.
ALTER TABLE github_pull_request_collections ADD COLUMN checks_complete boolean NOT NULL DEFAULT false;
ALTER TABLE github_pull_request_collections ADD COLUMN reviews_complete boolean NOT NULL DEFAULT false;
CREATE TABLE labeling_rule_test (
  test_id text PRIMARY KEY,
  repository_id text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  response jsonb,
  message text,
  created_at timestamptz NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  expires_at timestamptz NOT NULL DEFAULT CLOCK_TIMESTAMP() + INTERVAL '5 minutes'
);
CREATE INDEX labeling_rule_test_repository_idx ON labeling_rule_test(repository_id,created_at);
ALTER TABLE labeling_rule ADD COLUMN creation_key text;
CREATE UNIQUE INDEX labeling_rule_creation_key_idx ON labeling_rule(repository_id,creation_key) WHERE creation_key IS NOT NULL;
