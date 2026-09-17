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

`0026_github_feedback.sql` adds review membership, frozen authorization decisions,
and GitHub reply intents for ongoing agent sessions. The accepted collaboration
contract preserves agent inputs through readiness holds; labeling's event
invalidation rule does not discard accepted agent work. Repository operations
require current readiness, and reply publication holds the repository fence
through authorization and the complete external write attempt.

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
projection and responses. The runner Worker (`apps/runner/`) owns the native
conversation; these tables hold only what Janitor needs to accept inputs,
deliver them in order with stable runner message ids, and project runner
events. Existing tables are unchanged.

`0025_agent_repository.sql` adds the selected repository identity to an agent
session. The identity stays available for external cleanup after repository
removal. Session creation rejects a retry that changes the selection. Repository
execution checks readiness through Janitor before cloning or dispatching tools.

## Session observation

`0028_session_observation.sql` adds the team-wide `sessions` live channel. It
is keyed like a repository in `live_notification` but is not one: the
dispatcher never marks it disconnected, and its `membership` topic carries the
removed teammates whose open subscriptions must close. Triggers on the session
projection, session identity, home-thread associations, delivery health and the
catch-up obligation's last read commit invalidation intent with the change that
caused it; catch-up reads and delivery cron wakes then forward it. The
projection's own `freshness_at` heartbeat, thread cursors and leases are
bookkeeping and do not notify. No data changes; existing sessions appear on the dashboard
once their next projection read commits.

## Recovery observation

`0029_recovery_observation.sql` puts recovery health on the `sessions` live
channel. The dashboard states when each platform's recovery scan last
completed, whether it is overdue or incomplete, what it is retrying past and
what it can never bring back. Triggers on the GitHub scan record, retained
delivery attempts, the thread's Slack scan columns and feedback hydration fire
only when a health column actually changes, because the scans rewrite those
columns together with cursors, due times and leases on every page. Lateness
that comes from time alone has no trigger; the browser's fallback refresh
picks it up. No data changes. `0033` and `0034` later remove both scans and
their triggers; the feedback triggers remain.

## Repository access lifecycle

`0030_repository_access_lifecycle.sql` adds `repository_block_reason`, the one
concrete reason agent work on a repository is fenced: disconnected, GitHub access
unavailable, paused, synchronization failed or synchronization in progress. The
repository credential authority refuses with that reason, the runner reports it
in its blocked error, and the dashboard shows sessions of a fenced repository
as blocked with it. Pause and access loss retain session data and workspaces;
restoring access leaves a deliberately paused repository paused, and resumption
needs fresh synchronization before work continues.

The migration also adds `agent_session_cleanup` and replaces
`delete_repository_data` so explicit disconnection ends the repository's agent
sessions. Cleanup tombstones (session identity, generation and native session
id) are inserted first, then home threads, sessions and everything cascading
from them (inputs, projections, cursors, catch-up obligations, responses,
feedback and pending outputs) are deleted together with their handoff requests
in the outbox. Slack receipts
and contributions are keyed by thread and stay, so a redelivered start cannot
revive an ended session; a thread started again derives a fresh session
identity from its new start message. The agent catch-up cron asks the runner to
remove each tombstoned session's native conversation, workspace and checkpoints,
retrying with backoff while the runner is unreachable, and deletes the tombstone
only once the runner confirms. Session start refuses an identity that still has
a tombstone and a repository that is not connected. No data changes; existing
sessions are unaffected until their repository is disconnected.

## Maintenance barrier

`0031_maintenance_barrier.sql` adds `agent_maintenance`, the durable barrier an
operator establishes before a runner release that changes session storage or
execution, and `agent_session_maintenance`, one row per session and barrier
recording the hold request, the runner's acknowledgement (held, quiescent,
uncertain), its release or refusal with the runner's checks, and the last
error. A partial unique index allows one barrier that is not released; the
handoff withholds every dispatch to the runner while it exists, so sessions
started and inputs accepted after the barrier cannot escape it, while intake
keeps accepting inputs in order. The session observation query names the
barrier's reason ahead of repository fences and runner state. Hold rows are
deleted with their session, so disconnection during a hold outranks release.
No data changes.

## Remove the GitHub recovery scan

`0033_remove_github_recovery_scan.sql` drops `platform_recovery`,
`github_recovery_attempt` and their live triggers, and replaces
`delete_repository_data` without the retained-attempt deletion. GitHub feedback
arrives by webhook only; a delivery GitHub fails to make is not recovered.
Feedback hydration and its triggers are unchanged. The GitHub scan's single row
and any pending attempts are discarded.

## Remove the Slack thread scan

`0034_remove_slack_thread_scan.sql` drops the `slack_thread` scan columns
(`recovery_cursor`, `recovery_oldest`, `recovery_highwater`, `recovery_due_at`,
`recovery_completed_at`, `recovery_lease_until`, `recovery_lease_token`,
`recovery_warning`) and the `live_session_thread_recovery` trigger. Slack
messages arrive by event only and Slack retries failed deliveries itself; a
message whose event never arrives is not recovered. `delivery_warning` stays
with Slack delivery. Scan progress on existing threads is discarded.

## Streamed turn text

`0035_slack_streamed_attempt.sql` adds `slack_thread.streamed_attempt`, the
input and attempt whose assistant text blocks were already posted to the thread
as `turn.message` events arrived. The attempt's `turn.completed` then only marks
the progress message done instead of posting the same text again. No data
changes.

`0036_slack_startup.sql` adds revision-fenced Slack startup phases, cached repository
inference, and retry eligibility. Existing initialization and buffered inputs get
workflow outbox requests without resetting their thread context or leases. Idle
threads stop polling Slack. Repository readiness changes wake waiting threads;
synchronization completion submits their processing requests immediately.

## Legacy runner retirement

`0037_retire_legacy_runner.sql` removes the former runner's session, Slack delivery,
GitHub feedback and cleanup tables. It removes their pending workflow requests,
session notifications, and triggers on repositories and teammates. It replaces
`delete_repository_data` with the repository-only cleanup while preserving
`repository_block_reason`, account linking, synchronization and labeling state.

This migration deletes historical runner conversations and delivery records.
Current Slack conversations live in Durable Object storage and are unaffected.
Cloudflare resources owned by the former runner require a separate cutover.
Earlier migrations remain in order so both fresh databases and existing
deployments reach the same schema. The populated-upgrade test covers retirement
and repository operations after migration.

## Repository eligibility

`0038_repository_eligibility.sql` separates repository eligibility from the
synchronization cache, as ADR 0006 requires. `repository_access_current` is
the repository's access record and its installation's verified state without
the installation sync setting. `repository_block_reason` now names only
disconnection, a never-connected repository, unavailable GitHub access or a
pause; synchronization progress or failure is no longer a block reason. Slack
repository listing, selection and credentials, and the connection inventory's
`blockReason`, use it. Legacy labeling keeps `repository_access_available`,
`repository_automation_ready` and `entity_automation_eligible` unchanged until
it reads GitHub directly.

`github_repository.eligibility_generation` advances on every connection, pause,
access or installation change, and when the installation's status or access
error changes. `RepositoryEligibility.run` holds the repository row lock through
an operation, so a pause or disconnection waits for in-flight work, and refuses
work that recorded an earlier generation even after restoration. Slack agent
turns pin the generation first observed in the turn. The existing pause and
access triggers still discard pending outbox work. No data changes.

## Direct issue labeling

`0039_direct_issue_labeling.sql` moves issue labeling to direct GitHub reads
(ADR 0006). `labeling_reconciliation.source` says whether a row evaluated a
synchronized snapshot (`sync`, the legacy path pull requests still use) or
current GitHub facts (`github`). Direct rows keep the shared ledger: the
observation generation in `snapshot_generation` is the admitting webhook's
journal sequence, raised past any earlier generation of the same issue so later
events always order after earlier ones.

At cutover, pending legacy issue jobs are removed from the outbox and their
pending rows close as `superseded`; an accepted legacy job that finds an issue
refuses it. Pull request jobs are untouched. An installation's sync setting is
a cache-only change: `reset_installation_automation_readiness` marks it for the
transaction and `fence_repository_access` then neither discards direct issue
work nor moves `webhooks_after`, so events received before the toggle are still
admitted. Installation status and access-error changes, and every repository
connection, pause, access or installation change, still fence both, and the
pinned eligibility generation refuses work accepted before them.

## Webhook payload pruning

`0040_webhook_payload_pruning.sql` indexes terminal deliveries whose payloads
have not been purged. The existing minute cron clears up to 1,000 payloads per
wake, with no age delay after projection reaches `projected`, `unsupported`, or
`failed`. Pending deliveries retain their payloads for processing. Terminal
deliveries retain their IDs, sequence numbers, hashes, statuses, and error
details for deduplication and inspection, but cannot be replayed from their raw
payloads after pruning. The projector returns terminal statuses before decryption.

The migration only adds the index; maintenance drains the existing backlog in
batches. Pruning relies on PostgreSQL vacuuming to reclaim obsolete payload
storage. A database already at its size cap may need space freed before applying
the migration or running cleanup.

## Direct pull request labeling

`0041_direct_pull_request_labeling.sql` moves pull request labeling to direct
GitHub reads (ADR 0006), completing the labeling migration. One workflow,
`Janitor/LabelItemV1`, evaluates issues and pull requests; the pull request
record and the collections the configured revision reads (changed files,
check runs, reviews) are fetched from GitHub, paginated, as one observation of
the same head. `labeling_reconciliation.source` now defaults to `github`, and
`sync` only describes historical rows.

Stop old workers before applying this migration. Pending legacy pull request
jobs are removed from the outbox and their pending rows close as `superseded`;
the legacy workflow is no longer registered, so a job the engine already
accepted cannot resume. Pending direct issue work is renamed to the new tag
and key and runs unchanged; direct issue work the engine had already accepted
under the old tag is closed as `superseded` with its planned actions settled
as `failed`, so a write attempt still running elsewhere finds nothing to
write. The access fence's cache-only exemption follows the renamed tag. Legacy readiness predicates and `withRepositoryActivity`
remained for the ingress until migration `0042` retired them.

## Cache-only synchronization

`0042_cache_only_synchronization.sql` completes the migration ADR 0006
describes: synchronization is a UI cache and nothing else reads its state.
`repository_block_reason` and `repository_access_current` are the only
eligibility predicates; the webhook admission boundary, cache writes and
automation admission all use them. `repository_access_available`,
`repository_automation_ready`, `entity_automation_eligible`, the readiness
triggers, `github_repository.automation_ready_at`,
`synchronization_required_after`, the generated `sync_enabled` column and
`sync_target.automation_event_at` are dropped.

`fence_repository_work` is the one fence for access and installation changes:
it supersedes in-flight cache runs, asks every track for a full refresh once
the cache may run again, retries failed items, and discards pending outbox
work. The repository access trigger and the new installation trigger (status
or verified access) call it and move `webhooks_after`; the pause trigger is
unchanged. An installation's `sync_enabled` is a cache control with no other
effect: `sync_scope_enabled` stops cache runs while it is off. The connection
inventory derives cache health from `sync_target` alone. No data changes.
