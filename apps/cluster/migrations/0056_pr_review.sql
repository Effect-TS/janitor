-- PR review: a per-repository enable flag and a read-only record of every run
-- and its findings. A run's working state lives in its run entity; these rows
-- are for the web app and audits, and are kept indefinitely.

-- Off by default and stored apart from every other repository setting.
CREATE TABLE pr_review_repository (
  repository_id TEXT PRIMARY KEY REFERENCES github_repository (repository_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

-- One row per run: written as `running` when the run starts, as `skipped` for
-- oversized and run-cap skips, and upserted with the final record at the end.
CREATE TABLE pr_review_runs (
  run_id UUID PRIMARY KEY,
  repository_id TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  pull_request_title TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'rerun', 'forced')),
  invoker_login TEXT,
  invoker_comment_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'approved', 'changes_requested', 'commented',
    'partial', 'failed', 'cancelled', 'skipped')),
  verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'comment')),
  skip_reason TEXT CHECK (skip_reason IN ('oversized', 'run_cap')),
  failed_gates JSONB NOT NULL DEFAULT '[]',
  -- The review standards sources that applied (EFF-1647); stored, not shown in v1.
  standards_sources JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0),
  error_category TEXT,
  review_id TEXT,
  review_url TEXT,
  check_run_id TEXT,
  check_run_url TEXT,
  CHECK ((trigger = 'automatic') = (invoker_login IS NULL AND invoker_comment_id IS NULL)),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK ((review_id IS NULL) = (review_url IS NULL)),
  CHECK ((check_run_id IS NULL) = (check_run_url IS NULL))
);

-- A repository's runs, newest first; the run id breaks ties for the cursor.
CREATE INDEX pr_review_runs_repository_idx ON pr_review_runs (repository_id, started_at DESC, run_id DESC);
CREATE INDEX pr_review_runs_running_idx ON pr_review_runs (repository_id) WHERE status = 'running';

-- One row per finding a run reported or judged. Janitor never resolves review
-- threads, so an earlier finding that no longer applies is `addressed`.
CREATE TABLE pr_review_findings (
  finding_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES pr_review_runs (run_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'nit')),
  comment TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('new', 'carried_over', 'addressed', 'withdrawn'))
);

CREATE INDEX pr_review_findings_run_idx ON pr_review_findings (run_id, finding_id);

-- Disconnection clears the enable flag, so a reconnected repository starts with
-- PR review off. Run records are kept.
CREATE OR REPLACE FUNCTION delete_repository_data(target_repository_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE github_repository SET generation_floor = GREATEST(generation_floor + 1,
    COALESCE((SELECT MAX(requested_generation) FROM sync_target WHERE scope->>'repositoryId' = target_repository_id), 0))
    WHERE repository_id = target_repository_id;
  DELETE FROM workflow_outbox WHERE payload->>'repositoryId' = target_repository_id OR payload->'scope'->>'repositoryId' = target_repository_id
    OR payload->>'deliveryId' IN (SELECT delivery_id FROM github_webhook_delivery WHERE repository_id = target_repository_id);
  DELETE FROM github_webhook_delivery WHERE repository_id = target_repository_id;
  DELETE FROM sync_target WHERE scope->>'repositoryId' = target_repository_id;
  DELETE FROM labeling_rule_test WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_claim WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_decision WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_lease WHERE repository_id = target_repository_id;
  DELETE FROM labeling_ai_consent WHERE repository_id = target_repository_id;
  DELETE FROM labeling_reconciliation WHERE repository_id = target_repository_id;
  DELETE FROM labeling_audit WHERE repository_id = target_repository_id;
  DELETE FROM labeling_repository_rules WHERE repository_id = target_repository_id;
  DELETE FROM labeling_configuration WHERE repository_id = target_repository_id;
  DELETE FROM labeling_rule WHERE repository_id = target_repository_id;
  DELETE FROM labeling_policy_dependency WHERE version_id IN
    (SELECT version_id FROM labeling_policy_version WHERE repository_id = target_repository_id);
  DELETE FROM labeling_policy WHERE repository_id = target_repository_id;
  DELETE FROM github_entity WHERE repository_id = target_repository_id;
  DELETE FROM github_label WHERE repository_id = target_repository_id;
  DELETE FROM github_http_cache WHERE repository_id = target_repository_id;
  DELETE FROM repository_connection_audit WHERE repository_id = target_repository_id;
  DELETE FROM content_purge WHERE subject_kind = 'repository' AND subject_id = target_repository_id;
  UPDATE github_repository SET content_purged_at = NULL WHERE repository_id = target_repository_id;
  DELETE FROM live_notification WHERE repository_id = target_repository_id;
  DELETE FROM pr_review_repository WHERE repository_id = target_repository_id;
END $$;
