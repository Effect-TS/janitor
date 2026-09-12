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

Repository sync eligibility requires connection membership. Migration `0020` replaces the original retention behavior with deletion on explicit disconnection.

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

## Failed AI evaluations

`0014_failed_evaluations.sql` adds `failed` to stored per-rule evaluation results.
Label-write status remains separate. Historical results are unchanged; the classifier
uses a new decision cache key so earlier low-confidence `unknown` decisions are not
reused under the new non-match behavior.

## Label ownership

`0016_label_ownership.sql` checks existing rules, including disabled rules, for
multiple owners of the same repository, label, and current published target. It
aborts with every conflicting repository, label, target, and rule ID. It does not
change rule configuration or GitHub labels. Resolve conflicts by editing or
deleting the named rules and retry the migration. Disabling does not release
ownership.

Stop old workers before applying this migration and start the new release only
after it passes. Rule creates and edits, policy draft saves, and policy publication
check ownership inside `withRepositoryMutation`, which serializes requests with a
PostgreSQL repository-row lock. Ownership follows the published target until a
replacement is published. Publication rechecks ownership because a label may
have been claimed since the draft was saved. Direct SQL writers must use the same
lock and checks; the lookup index is not a uniqueness constraint.

## Labeling groups

`0017_labeling_groups.sql` checks mixed published targets and duplicate priorities
within each repository's named group, including disabled rules. It aborts with
repository, group, rule IDs, targets, and priorities. Resolve these conflicts using
the previous release, splitting mixed-target groups and choosing unique priorities.
The old release still gives smaller numbers precedence during resolution.

Stop old workers before applying the migration. It converts grouped priorities
using `-priority - 1`, preserving the old winner order across the full PostgreSQL
integer range. Ungrouped priorities stay unchanged. Grouped rule versions advance
so stale editor saves fail. Each affected repository receives a new configuration
revision with the converted priorities and disabled members, fencing pending
legacy evaluations. Existing fact preparation carries forward. Historical
configurations, recorded decisions, and GitHub labels remain unchanged. Start the
new release after migration succeeds; this does not schedule labeling runs.

Groups are identified by repository and name. Their members' current published
targets must agree. Removing the last member releases the name and target.
Rule writes and policy target changes check membership and priority under
`withRepositoryMutation`. Reordering sends every member's ID, observed version,
and final priority to `POST /repositories/:repositoryId/rules/reorder`. The server
rejects changed membership or versions with 409 and duplicate priorities with 422,
then applies accepted changes with one audit per member and one new revision.
Direct SQL writers must follow the same lock and validation protocol.

## Repository pause

`0018_repository_pause.sql` replaces the two repository controls with `enabled`.
`sync_enabled` remains a generated, read-only compatibility column. A paused
repository retains configuration, facts and labels. Installation discovery keeps
running so operators can manage access.

Stop old workers before applying the migration. It reports every connected
repository whose old `enabled` and `sync_enabled` values disagree, then stops
without choosing a setting. For each reported repository, an operator must choose
running or paused and set both old flags to that value before retrying. Disconnected
repositories retain their automation flag. Start the new release after migration
succeeds. The retired PUT sync-settings endpoint returns 409 with the replacement
connection endpoint.

Pause holds the repository row lock until earlier fact publications, webhook
storage and GitHub label-write attempts finish. It then invalidates pending sync
and evaluation generations. Sync publication and label writes acquire this lock
before sync-target locks. Future repository automations must use the same fence
and hold it through external writes. Pause takes effect when its transaction
commits and the API acknowledges it. Resume requests fresh synchronization;
webhooks received before resumption cannot replay into facts or automation.

Local fixtures use the installation sync setting to stay offline. Their repository
pause setting still controls both automation and synchronization.

## Automation readiness

`0019_automation_readiness.sql` starts connected repositories awaiting fresh
synchronization. The repair planner schedules the three repository tracks even
when their usual refresh interval has not elapsed. Connection, resumption and
restored access reset this requirement. Pause remains a separate operator choice.

Any failed repository or entity synchronization clears readiness under the same
repository lock used by label writes. Recovery requires all failed and unfinished
work to complete, and initial synchronization requires all three repository
tracks. Automatic retries continue while blocked. Manual retry also requests
failed entity targets.

An entity refresh carries labeling eligibility only when a webhook received after
readiness requested it. Manual sync and scans cannot grant that eligibility.
Snapshot publication, evaluation retries and external writes check the current
readiness boundary and entity generation. Closed issues and closed or merged pull
requests are ineligible. Recovery does not replay blocked events or label existing
items. Future repository automations must check repository readiness and retain
an event's admission boundary through their external-write fence.

## Repository disconnection

`0020_repository_disconnection.sql` adds repository attribution for webhook
payloads and AI claims, and the deletion function used by explicit disconnection.
It removes repository configuration, policy versions and drafts, labeling groups,
facts, evaluations, caches, event history, pending notifications and outbox work.
The repository identity, access information and a generation counter remain.
Reconnection requests all three synchronization tracks with generations above
the deleted work and becomes ready only after synchronization succeeds.

Stop old workers before applying this migration. Drain the legacy webhook queue
into the journal and remove its consumed R2 payloads before enabling disconnection
in the new release. Clear retained legacy workflow activity results during this
development deployment, since the previous workflows stored fetched GitHub pages,
evaluation traces and label plans outside Postgres. New workflows keep these only
in memory and deletable repository tables or HTTP cache entries. Replayed workflows
may refetch GitHub pages; they recheck their generation before publishing facts.
The migration does not disconnect existing repositories or delete their
configuration. Transient AI claims are reset.

New repository webhook requests journal ciphertext directly within the repository
lock. Their outbox payloads contain delivery IDs only; queue and R2 storage remain
for installation discovery. The legacy queue consumer attributes decrypted
repository payloads before journaling and discards deliveries older than the
repository's admission cutoff, including after reconnection. Disconnection
decrypts unattributed legacy journal entries to identify the repository before
deletion. If a required encryption key is unavailable, disconnection fails and
rolls back instead of leaving unidentifiable ciphertext behind.

GitHub label writes share the repository lock with disconnection. AI cache writes
recheck the connection generation under that lock. Reconnection never restores
configuration, AI consent or old facts, and does not trigger catch-up labeling.

## Teammates

`0022_teammates.sql` adds the stable teammate identity behind Access sign-in,
verified Slack and GitHub links, single-use link attempts and an administrative
audit. A teammate is keyed by the verified Access issuer and subject; email is
display only. Links are never deleted: `active` may direct Janitor, `disconnected`
was released by the teammate, `disabled` was switched off by removal and still
owns the account, and `replaced` gave way to a newer proof in the same workspace.
Partial unique indexes keep one owner per platform account and one current link
per teammate and workspace.

Role and status changes serialize on the `teammate-roles` advisory lock and the
target's row lock, so the last-admin check and the write are one step. Input
acceptance must call `Teammates.authorize` inside its own transaction: it takes
a share lock on the link and teammate rows, so removal waits for the acceptance
to commit and a later evaluation sees the removal. The migration creates no
rows; the first admin is admitted from `JANITOR_INITIAL_ADMIN_SUBJECT` on sign-in.

## Agent sessions

`0023_agent_sessions.sql` adds agent session identity, accepted inputs in one
per-session acceptance order, the durable runner handoff state, per-consumer
event cursors, persisted catch-up obligations, and the rebuildable session
projection and responses. The runner Worker (`runner/`) owns the native
conversation; these tables hold only what Janitor needs to accept inputs,
deliver them in order with stable runner message ids, and project runner
events. Existing tables are unchanged.
