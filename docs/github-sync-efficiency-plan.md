# GitHub sync performance and reliability plan

Status: implemented across production rollouts on September 5, 2026. Baseline commit: `6e34a44`. See [measurements and rollout notes](github-sync-results.md) for measured results and limits.

## Outcome

Make initial imports and incremental updates fast, recoverable, and measurable. Repository discovery, connection, disconnection, and editing configuration must continue to finish independently of content sync.

Keep the existing PostgreSQL outbox, generation fencing, Cloudflare workflows, and webhook journal. Improve their implementation before introducing another queue, scheduler, database, or API architecture.

## Evidence and open questions

The September 5 production investigation found jobs pending despite available GitHub capacity. The last sampled installation budget had 4,964 requests remaining and no recorded cooldown. Four targets reported `GitHub request exceeded its rate-budget lease`. These are historical observations, not a claim about current production state.

| Finding                                                    | Evidence in the code                                                                                                                                                           | Consequence                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The timeout covers more than GitHub HTTP                   | `GitHub/Transport.ts` puts token acquisition, response reading, rate-budget writes, and the recursive 401 retry inside a 25-second timeout. The budget lease lasts 30 seconds. | The error does not identify whether GitHub, authentication, or PostgreSQL caused the delay.                                                       |
| Page application performs sequential writes                | `GitHub/ReadModel.ts` writes each entity, each label, and entity-label associations separately. `SyncRepositoryTrack.ts` applies a page inside `SyncTargets.withRun`.          | Many database round trips and a transaction that remains open throughout page application.                                                        |
| Scans can create redundant targeted work                   | PR details return `Missing` when the entity scan has not created the identity row yet. The PR scan then invalidates an entity target.                                          | Scheduling order can cause extra fetches rather than just completing the two scans.                                                               |
| Dispatch can outlive its claimed leases                    | `WorkflowDispatcher.ts` claims up to 100 rows with a 60-second lease, then submits and acknowledges them sequentially.                                                         | Slow submissions can leave later rows with expired leases. Whether this contributed to the incident needs measurement.                            |
| Immediate eligibility does not guarantee an immediate wake | `SyncTargets.invalidate` sets a due time and writes the outbox. Producer call sites determine whether a dispatcher is actually woken. Cron runs every minute.                  | An un-woken follow-up waits for cron even when its due time is now. Audit every producer rather than assuming the dispatcher comment is accurate. |
| Recovery checks are not evidence of progress               | `SyncRecovery.ts` updates `updated_at` after polling. Missing results now trigger resume, but the engine can also have a live attempt with no saved result.                    | Polling can make a stalled target look recently active.                                                                                           |
| Background work can use foreground capacity                | `RefreshEntity.ts` always requests foreground priority, including targets created by scans.                                                                                    | Bulk imports can compete with interactive verification.                                                                                           |

Measure HTTP latency, token latency, database acquisition and lock waits, workflow execution, and dispatch delay separately. Do not attribute all elapsed time to GitHub or assume increasing timeouts fixes the cause.

## 1. Establish a baseline and fix request lifecycle failures

Files: `GitHub/Transport.ts`, `GitHub/AppAuth.ts`, `GitHub/RateBudget.ts`, and their tests.

- Add timings and structured failure stages for budget acquisition, token acquisition, HTTP headers/body, budget recording, and lease release. Record endpoint categories, request IDs, attempts, and durations without tokens or issue bodies.
- Compare cold and warm requests through the actual Cloudflare/Hyperdrive path. Local database timings alone will miss production network costs and request-lifetime problems.
- Give every HTTP attempt its own lease and deadline. Resolve credentials outside that attempt's concurrency lease, with a separate bounded token-acquisition deadline. Keep the authenticated request and body read within the lease's lifetime, allowing time for cancellation and cleanup.
- Replace recursive 401 retry inside an existing lease with an explicit, single credential-refresh retry. Finish the first attempt and release its lease before starting the next.
- Bound database bookkeeping and cleanup. Preserve conservative rate accounting if recording fails; do not silently turn an accounting failure into unlimited capacity or discard the original failure behind a cleanup error.
- Classify transient network/database failures, GitHub rate limits, authentication/access failures, and decode errors. Retry transient failures durably with bounded exponential backoff and jitter. Respect GitHub's retry/reset times. Do not repeatedly retry permanent access failures or ambiguous label writes as if they were reads.

Acceptance: injected slow authentication, body reads, lock contention, interrupted requests, and 401s produce distinct failures; live requests never outlast their leases; released or expired leases cannot authorize overlapping attempts beyond the configured limit.

## 2. Batch database writes and remove redundant fetches

Files: `GitHub/ReadModel.ts`, `GitHub/SyncRepositoryTrack.ts`, `GitHub/RefreshEntity.ts`, `SyncTargets.ts`.

- Add bulk operations for entity rows, deduplicated labels, label associations, and PR details. Use a small fixed number of SQL statements per bounded batch rather than statements per record.
- Fetch and decode GitHub pages before opening the apply transaction. Keep generation/access checks and all related writes atomic inside a short transaction. Make batch size configurable by row count and payload size.
- Use the set of entity rows accepted by the version checks to determine which label associations can be replaced. A stale observation must not change labels after its entity update was rejected.
- Preserve webhook sequence and GitHub update-time ordering, deterministic label conflict resolution, and replay idempotency. Advance watermarks only after the complete scan succeeds.
- Let a PR list observation atomically establish the canonical entity identity and PR details where its fields are authoritative. Share this implementation with existing projection code. Stop creating targeted fetches solely because the entity scan has not reached that PR yet.
- Preserve demand-based files/checks/reviews fetching, which already exists. Coalesce repeated requests for the same entity and only fetch those collections when required by active rules or an explicit test.

Acceptance: applying a 100-item fixture uses a fixed, documented number of statements, provisionally at most 12 excluding transaction control and explicitly required downstream work. PR-first and issue-first scans converge to the same state without missing-identity refetches. Concurrent webhooks, disconnects, and replay cannot overwrite newer data or resurrect access.

## 3. Make dispatch prompt, fair, and lease-safe

Files: `WorkflowDispatcher.ts`, `WorkflowOutbox.ts`, `WorkflowOutboxCron.ts`, `Worker.ts`, and all outbox producers.

- Wake the existing dispatcher after successful commits from connection changes, manual refresh, webhook projection, scan follow-ups, and retry scheduling. Use the existing durable wake mechanism; the user request must not await completion of content jobs.
- Retain cron as recovery for a lost wake. For future-due jobs, arrange a durable wake at their due time using the existing alarm facilities where possible.
- Claim only the work that can be submitted within a lease. Start with smaller claims and bounded concurrent workflow submissions, with per-submission deadlines. Add renewal only if measurement demonstrates it is necessary.
- Keep lease-token checks on acknowledgement and release. A crash between workflow submission and acknowledgement must remain safe through the existing deterministic execution ID.
- Separate interactive work from import/repair priority. Carry priority through coalescing, allowing an explicit test to promote already queued work. Prevent one repository from monopolizing an installation's budget or the global dispatcher.
- Keep GitHub requests paced per installation. Improve SQL batching and workflow submission throughput first; do not raise GitHub concurrency as the first optimization.

Acceptance: no healthy due job waits for cron after its producer commits; duplicate dispatch and lease expiry do not duplicate logical work; one slow submission does not stall every other repository; interactive requests remain responsive during a bulk import.

## 4. Make progress and recovery truthful

Files: `SyncRecovery.ts`, `SyncStatus.ts`, `SyncTargets.ts`, domain sync schemas, and the sync UI. Inspect the vendored Cloudflare workflow runtime where application recovery is insufficient.

- Track actual progress separately from recovery inspection: stage, pages/items applied, last successful progress time, retry due time, and failure category. Update progress with batch commits, not per item.
- Show queued, running, waiting for GitHub, retrying, blocked, failed, and completed states. Show known counts rather than inventing a percentage when the total is unknown. Report partial failures alongside ongoing work.
- Distinguish an evicted execution from an active attempt and a legitimate durable sleep. Define a bounded activity lifetime and resumable checkpoint contract. A stale timestamp alone must not launch another writer.
- Test the engine's handling of a hung in-memory attempt: repeated `resume` calls must not leave it permanently stuck. Any takeover must interrupt or fence the previous attempt before replay; extend the existing runtime contract only where needed.
- Recover transient page failures from durable completed activities, with an attempt budget and an eventual visible failure. Keep rate-limit sleeps intact. Ensure completed activities remain compatible across deployments, or explicitly version changed workflows and drain old executions.
- Continue incremental scans and periodic reconciliation for missed events. Preserve overlap windows, open-item disappearance checks, conditional-request pagination semantics, and invalidations arriving during a scan.

Acceptance: crash after fetch, crash after SQL commit before activity acknowledgement, deployment during a page, and lost wake all converge without lost updates. Durable waits are not restarted early. Every nonterminal job has either demonstrable progress, a future wake, or a visible failure requiring action.

## Validation and rollout

Use representative fixtures of 100, 1,000, and 10,000 open entities with realistic label counts and PR payload sizes. Cover first import, unchanged incremental sync, a burst of webhooks, and simultaneous repositories. Record SQL statements, database time, GitHub calls, duplicate fetches, dispatch delay, import duration, retries, and interactive latency before and after each phase.

Proposed acceptance targets, to confirm against the phase 1 baseline:

| Measure                                     | Target                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| Database statements for a 100-item batch    | At least 80% fewer than baseline                                                    |
| Due-job dispatch latency under healthy load | p95 below 5 seconds                                                                 |
| Initial import of 1,000 fixture entities    | At least 3x faster with equivalent correctness and no increased rate-limit failures |
| Ordinary connection-state visibility        | Visible on the first read after the mutation response                               |
| Recovery after an eviction or lost wake     | Within two one-minute recovery cycles when no legitimate future wait applies        |
| Silent indefinite work                      | None in injected failure/redeployment tests                                         |

These are engineering targets, not measured production guarantees. Measure core import and rule-required enrichment separately so optional work cannot hide a regression.

Deliver the numbered phases as separate reviewable changes. Run `vp check`, `vp test`, dependency and worker-bundle checks, and the web build when changing UI. Add meaningful database integration, fake-clock, and actual Cloudflare recovery tests; mocks alone cannot validate request lifetime or eviction.

Use local fixtures and a disposable repository in production. There is no staging environment. Use additive schema changes, conservative concurrency defaults, and a configuration switch for the new bulk path while comparing results. Roll back code or reduce concurrency without deleting the journal/outbox or resetting generations. Pause the rollout on state divergence, increased rate-limit errors, or worse interactive latency.

Keep Hyperdrive query caching disabled for operational state. Cloudflare documents that writes do not invalidate cached query results. [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

GitHub recommends avoiding concurrent API requests, using webhooks and conditional requests, and backing off when rate limited. Those constraints favor reducing duplicate calls and database overhead before adding API parallelism. [GitHub REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

Defer GraphQL migration, a replacement workflow engine, extra caching layers, and historical closed-item imports until the baseline demonstrates a need. The first implementation should be phase 1, followed by bulk page application.
