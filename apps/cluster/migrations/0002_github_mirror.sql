-- Local mirror of GitHub state, keyed by stable GitHub IDs. Names and handles
-- are mutable attributes. projected_sequence and github_updated_at fence
-- writes so an older observation never overwrites a newer one.
CREATE TABLE github_installation (
  installation_id TEXT PRIMARY KEY,
  account_database_id TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('Enterprise', 'Organization', 'User')),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deleted')),
  html_url TEXT NOT NULL,
  projected_sequence BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP()
);

CREATE TABLE github_repository (
  repository_id TEXT PRIMARY KEY,
  node_id TEXT,
  installation_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  is_private BOOLEAN,
  access TEXT NOT NULL CHECK (access IN ('accessible', 'suspect', 'lost')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  projected_sequence BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  content_purged_at TIMESTAMPTZ
);

CREATE INDEX github_repository_installation_idx ON github_repository (installation_id);

CREATE TABLE github_label (
  repository_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  node_id TEXT,
  name TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'suspect', 'unavailable')),
  projected_sequence BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, label_id)
);

-- Issues and pull requests share this table, keyed by repository and number.
-- Issue-side IDs are canonical and bound by scans; pull request webhooks lack them.
CREATE TABLE github_entity (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
  issue_id TEXT,
  issue_node_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  author_login TEXT NOT NULL,
  author_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  github_updated_at TIMESTAMPTZ NOT NULL,
  projected_sequence BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, number)
);

CREATE UNIQUE INDEX github_entity_issue_id_idx ON github_entity (issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE github_pull_request (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number > 0),
  pull_request_id TEXT NOT NULL,
  pull_request_node_id TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  draft BOOLEAN NOT NULL,
  head_sha TEXT NOT NULL,
  merged BOOLEAN NOT NULL,
  github_updated_at TIMESTAMPTZ,
  projected_sequence BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (repository_id, number),
  FOREIGN KEY (repository_id, number) REFERENCES github_entity (repository_id, number) ON DELETE CASCADE
);

CREATE UNIQUE INDEX github_pull_request_id_idx ON github_pull_request (pull_request_id);

CREATE TABLE github_entity_label (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, label_id),
  FOREIGN KEY (repository_id, number) REFERENCES github_entity (repository_id, number) ON DELETE CASCADE
);

-- Collection facts for pull requests. Rows are
-- replaced wholesale by the entity refresh that fetched them, in the same
-- transaction as the entity, so they are never newer or older than it.
CREATE TABLE github_pull_request_collections (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- False when the file listing was cut off at the fetch limit.
  files_complete BOOLEAN NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  PRIMARY KEY (repository_id, number),
  FOREIGN KEY (repository_id, number) REFERENCES github_entity (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_pull_request_file (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, path),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_check_run (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, name),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);

CREATE TABLE github_pull_request_review (
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repository_id, number, reviewer),
  FOREIGN KEY (repository_id, number) REFERENCES github_pull_request_collections (repository_id, number) ON DELETE CASCADE
);
