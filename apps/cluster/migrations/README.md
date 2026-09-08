# Database migrations

The first four migrations are the pre-production baseline for a fresh PostgreSQL 18 database. They replace the original 14 development migrations. Subsequent files extend that baseline.

| File                       | Tables                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `0001_delivery.sql`        | Encrypted webhook journal and workflow outbox                                              |
| `0002_github_mirror.sql`   | Installations, repositories, labels, entities, pull requests, and their collections        |
| `0003_synchronization.sql` | API budgets, request leases, response cache, sync targets, repair state, and content purge |
| `0004_labeling.sql`        | Policies, configurations, rules, reconciliation, audit, and AI consent and decisions       |
| `0005_sync_controls.sql`   | Repository and installation sync settings and shared scope eligibility                     |

The baseline defines current columns directly. It omits the discarded ruleset schema, data backfills, and cache cleanup that only applied to older development databases. The policy's published-version foreign key still uses `ALTER TABLE` because policies and versions reference each other.

## Applying the baseline

All three database paths apply `.sql` files in filename order:

- Local development copies them into the PostgreSQL image's `/docker-entrypoint-initdb.d/` directory. The image tag hashes the SQL filenames and contents and the Dockerfile. On the next `vp run dev`, changes to those inputs replace the local container with a fresh database and rerun the seed. This discards local data, including when `JANITOR_SEED=false` skips seeding. Ordinary restarts retain data.
- Deployed databases use the migrations directory configured in `src/Database.ts`. Alchemy tracks applied migrations in `__alchemy_migrations`.
- Database tests start fresh PostgreSQL containers and apply the files through `test/support/Postgres.ts`.

An existing development database must be recreated before using this baseline. Both the local image tag and the container's logical resource ID include the schema hash. The new resource ID forces Alchemy to create a fresh container instead of updating the old one in place. PostgreSQL only applies image initialization scripts to an empty data directory, and running the seed task only replaces data. For a deployed development environment, provision a fresh database through the infrastructure configuration so Alchemy's migration history starts with this baseline. Do not apply these files over the old schema or edit migration bookkeeping to mark them as applied.

Stop old workers and discard their pending development workflow executions when replacing a database. Those executions refer to rows and generations in the old database. Start the current workers against the fresh database, then seed local fixtures or synchronize GitHub data.

## After production launch

Keep these baseline files unchanged once production has applied them. Add each subsequent schema change as the next numbered migration, starting with `0007_`. Production changes need forward migrations that preserve existing data; do not squash migrations already deployed to production.

Run `vp check` and `vp test run` from the workspace root. Database tests require a Docker-compatible runtime.

## Repository membership

`0006_repository_connections.sql` adds explicit connection membership, disconnect timestamps, operator audit records, and expiring GitHub setup attempts. Existing repository rows remain connected, including paused rows. Discovery explicitly inserts new repositories as disconnected; inventory refreshes never overwrite membership. Seeds and the operator enable command explicitly connect repositories.

Repository sync eligibility now requires connection membership. Disconnect retains policies, rules, mirror data, and history.

## GitHub label colors

`0009_label_colors.sql` adds the nullable GitHub label color. Existing labels keep
working and receive their colors on the next label sync or entity observation.

## AI rules

`0010_ai_rules.sql` adds rule-owned classifier policies, editable AI definitions,
retry-safe creation keys, expiring classifier claims, and asynchronous test jobs.
It also records whether check/review collections were actually fetched. Existing
collection rows default to incomplete and become usable after their next refresh.
Historical classifier versions remain after a rule is deleted. Existing policy
rules and shared classifier policies remain compatible.
