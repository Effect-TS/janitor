-- Policies have immutable published versions and one draft. Repository
-- configurations snapshot the enabled rules and the versions they bind.

-- Qualified snapshot handoff. One row per
-- reconciliation identity; the outbox row for the reconcile workflow is
-- written in the same transaction. Outcomes land on the same row.
CREATE TABLE labeling_reconciliation (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  snapshot_generation BIGINT NOT NULL,
  rules_revision BIGINT NOT NULL,
  covered_sequence BIGINT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  outcome TEXT CHECK (outcome IN ('evaluated', 'superseded', 'not-qualified', 'failed')),
  detail TEXT,
  completed_at TIMESTAMPTZ,
  plan JSONB,
  PRIMARY KEY (repository_id, number, snapshot_generation, rules_revision)
);

CREATE INDEX labeling_reconciliation_recent_idx
  ON labeling_reconciliation (repository_id, created_at DESC);

CREATE TABLE labeling_policy (
  policy_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  target TEXT NOT NULL CHECK (target IN ('issue', 'pull_request')),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  published_version_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  UNIQUE (repository_id, policy_id)
);
CREATE UNIQUE INDEX labeling_policy_name_idx ON labeling_policy (repository_id, lower(name));

CREATE TABLE labeling_policy_version (
  version_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES labeling_policy (policy_id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  program JSONB NOT NULL,
  manifest JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  UNIQUE (policy_id, revision),
  UNIQUE (policy_id, content_hash)
);

ALTER TABLE labeling_policy
  ADD FOREIGN KEY (published_version_id) REFERENCES labeling_policy_version (version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE labeling_policy_draft (
  policy_id TEXT PRIMARY KEY REFERENCES labeling_policy (policy_id) ON DELETE CASCADE,
  program JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- Which published versions a version's program references, so a
-- referenced policy cannot be deleted from under a publisher.
CREATE TABLE labeling_policy_dependency (
  version_id TEXT NOT NULL REFERENCES labeling_policy_version (version_id) ON DELETE CASCADE,
  dependency_policy_id TEXT NOT NULL REFERENCES labeling_policy (policy_id) ON DELETE RESTRICT,
  PRIMARY KEY (version_id, dependency_policy_id)
);

CREATE TABLE labeling_rule (
  rule_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES labeling_policy (policy_id) ON DELETE RESTRICT,
  on_no_match TEXT NOT NULL CHECK (on_no_match IN ('ensure-absent', 'preserve')),
  rule_group TEXT CHECK (rule_group IS NULL OR length(rule_group) BETWEEN 1 AND 100),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  label_status TEXT NOT NULL DEFAULT 'valid' CHECK (label_status IN ('valid', 'missing')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
CREATE INDEX labeling_rule_repository_idx ON labeling_rule (repository_id, created_at);

-- One row per revision: the enabled rules with the versions they bound,
-- and the track generations activation waits for.
CREATE TABLE labeling_configuration (
  repository_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  rules JSONB NOT NULL,
  version_ids JSONB NOT NULL,
  required_tracks JSONB NOT NULL,
  preparation JSONB NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, revision)
);

CREATE TABLE labeling_repository_rules (
  repository_id TEXT PRIMARY KEY,
  configured_revision BIGINT NOT NULL,
  active_revision BIGINT,
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  FOREIGN KEY (repository_id, configured_revision)
    REFERENCES labeling_configuration (repository_id, revision),
  FOREIGN KEY (repository_id, active_revision)
    REFERENCES labeling_configuration (repository_id, revision)
);

CREATE TABLE labeling_audit (
  audit_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('policy', 'rule')),
  subject_id TEXT NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'publish', 'delete')),
  before JSONB,
  after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);
CREATE INDEX labeling_audit_repository_idx ON labeling_audit (repository_id, created_at DESC);

-- Per-rule outcomes and per-label actions for one reconciliation identity.
CREATE TABLE labeling_rule_evaluation (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  snapshot_generation BIGINT NOT NULL,
  rules_revision BIGINT NOT NULL,
  rule_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('match', 'no-match', 'unknown', 'not-applicable')),
  selected BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  trace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, number, snapshot_generation, rules_revision, rule_id),
  FOREIGN KEY (repository_id, number, snapshot_generation, rules_revision)
    REFERENCES labeling_reconciliation (repository_id, number, snapshot_generation, rules_revision)
    ON DELETE CASCADE
);
CREATE INDEX labeling_rule_evaluation_rule_idx ON labeling_rule_evaluation (rule_id, created_at DESC);

CREATE TABLE labeling_label_action (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  snapshot_generation BIGINT NOT NULL,
  rules_revision BIGINT NOT NULL,
  label_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  rule_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'failed')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (repository_id, number, snapshot_generation, rules_revision, label_id),
  FOREIGN KEY (repository_id, number, snapshot_generation, rules_revision)
    REFERENCES labeling_reconciliation (repository_id, number, snapshot_generation, rules_revision)
    ON DELETE CASCADE
);

-- Classifier evaluation. Consent is per
-- repository and names the provider and model it covers. Leases bound
-- in-flight provider calls so revocation can drain them. Decisions are
-- cached by policy version and evidence so a repeated snapshot does not
-- repeat the call.
CREATE TABLE labeling_ai_consent (
  repository_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('enabled', 'draining', 'disabled')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  actor_issuer TEXT NOT NULL,
  actor_subject TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE TABLE labeling_ai_lease (
  lease_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);
CREATE INDEX labeling_ai_lease_active_idx ON labeling_ai_lease (repository_id, released_at, expires_at);

CREATE TABLE labeling_ai_decision (
  repository_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('match', 'no-match', 'unknown')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, policy_version_id, number, evidence_hash)
);
