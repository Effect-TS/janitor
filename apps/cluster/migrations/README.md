# Database migrations

These four migrations are the pre-production baseline for a fresh PostgreSQL 18 database. They replace the 14 development migrations and create the same final schema.

| File                       | Tables                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `0001_delivery.sql`        | Encrypted webhook journal and workflow outbox                                              |
| `0002_github_mirror.sql`   | Installations, repositories, labels, entities, pull requests, and their collections        |
| `0003_synchronization.sql` | API budgets, request leases, response cache, sync targets, repair state, and content purge |
| `0004_labeling.sql`        | Policies, configurations, rules, reconciliation, audit, and AI consent and decisions       |

The baseline defines current columns directly. It omits the discarded ruleset schema, data backfills, and cache cleanup that only applied to older development databases. The policy's published-version foreign key still uses `ALTER TABLE` because policies and versions reference each other.

## Applying the baseline

All three database paths apply `.sql` files in filename order:

- Local development copies them into the PostgreSQL image's `/docker-entrypoint-initdb.d/` directory. PostgreSQL runs these scripts only when initializing an empty data directory.
- Deployed databases use the migrations directory configured in `src/Database.ts`. Alchemy tracks applied migrations in `__alchemy_migrations`.
- Database tests start fresh PostgreSQL containers and apply the files through `test/support/Postgres.ts`.

An existing development database must be recreated before using this baseline. Rebuilding the image alone does not migrate an existing data directory, and running the seed task only replaces data. For a deployed development environment, provision a fresh database through the infrastructure configuration so Alchemy's migration history starts with this baseline. Do not apply these files over the old schema or edit migration bookkeeping to mark them as applied.

Stop old workers and discard their pending development workflow executions when replacing a database. Those executions refer to rows and generations in the old database. Start the current workers against the fresh database, then seed local fixtures or synchronize GitHub data.

## After production launch

Keep these baseline files unchanged once production has applied them. Add each subsequent schema change as the next numbered migration, starting with `0005_`. Production changes need forward migrations that preserve existing data; do not squash migrations already deployed to production.

Run `vp check` and `vp test run` from the workspace root. Database tests require a Docker-compatible runtime.
