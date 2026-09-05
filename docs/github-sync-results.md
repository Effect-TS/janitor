# GitHub sync measurements

September 5, 2026. Baseline commit: `6e34a44`.

## What changed

- Credentials resolve before reserving GitHub concurrency. Each authenticated attempt has a separate lease; a 401 releases its lease before the single credential refresh. Authentication, budget acquisition, HTTP/body reading, accounting, and cleanup have separate deadlines and stage diagnostics.
- Rate-budget acquisition runs atomically in PostgreSQL instead of holding a row lock across several Worker/database round trips. Successful accounting and lease release share one statement. Background jobs leave two of the existing eight concurrency slots for foreground operations.
- Issue pages bulk-write entities, accepted labels, and associations. Rejected stale observations cannot replace labels. PR pages can establish new entity rows without confusing PR IDs with issue IDs, avoiding targeted fetches caused only by scan ordering.
- Dispatch claims four jobs at a time and submits them concurrently. Submissions and acknowledgements have bounded lifetimes below the claim lease. One failed or slow job does not interrupt unrelated submissions. Deterministic execution IDs and lease-token checks remain in place.
- Outbox producers register one wake per execution scope, after their transactions close. Background dispatch handles the five-second debounce; cron remains the recovery path for lost wakes and longer scheduled backoffs.
- Transient read failures get at most three durable retries with exponential backoff and stable jitter. Access and decoding failures are not blindly retried. Completed page activities survive replay.
- Committed page progress is independent of recovery inspection. Counters do not double-count page replay or include rolled-back writes. Recovery resumes evicted executions, preserves durable sleeps, and interrupts a confirmed stall before checking for terminal state and allowing replacement.
- The sync tooltip shows queued/running counts, processed items in active scans, stalled work, and failures alongside ongoing sync. Repository connection and configuration operations remain independent of content sync.

No new queue or workflow engine was introduced. Both migrations are additive. Hyperdrive query caching remains disabled.

## Production observations

The incident baseline at 20:24 UTC had seven unfinished targets and rate-budget lease timeout errors. After the first deployment, all sampled unfinished targets completed. This is an incident recovery observation, not a controlled before/after import benchmark.

| Measurement                                 | Earlier instrumented deployment | After database and dispatch changes |
| ------------------------------------------- | ------------------------------- | ----------------------------------- |
| Budget acquisition plus response accounting | 2.85–3.07 seconds, 2 requests   | 0.49–0.74 seconds, 6 requests       |
| Entire authenticated request                | 3.69–4.23 seconds               | 1.51–2.68 seconds                   |
| HTTP response/body time                     | 0.44–0.62 seconds               | 0.42–1.85 seconds                   |

A forced full open-entity scan of `Effect-TS/effect`, requested at 20:48:21 UTC, verified at 20:48:44 UTC. Its PR-details scan also verified successfully. The mirror contained 268 entities and no pending targets after both scans. Neither scan created missing-identity refreshes.

After the final backend deployment, a second full scan completed on September 5 at 21:05 UTC. It processed **261 open entities across three pages in 18.33 seconds** and **94 PRs in 9.73 seconds**, measured from workflow acceptance to target verification. Both scans ran concurrently. The earlier enqueue time includes a deliberate cron-fallback wait from the diagnostic helper. All requested generations completed, all target errors were clear, and no GitHub cooldown was recorded. Committed progress counters matched the page totals.

For normal production producers after the second deployment, three webhook projection jobs had dispatch p95 of 1.07 seconds and three entity refreshes had p95 of 1.32 seconds. This is a small sample, not a sustained-load SLA. Dispatch is measured from `due_at` to `accepted_at`, excluding intentional debounce.

The two manually enqueued benchmark tracks used a local diagnostic helper without the Worker's wake service. Their maximum dispatch delay was 28.64 seconds. This exercised the cron fallback; it is not evidence about normal producer wake latency.

## Reproducible local projection benchmark

Run with Docker available:

```sh
vp run benchmark:sync
```

For this workstation's Podman setup:

```sh
DOCKER_HOST=unix:///run/user/1000/podman/podman.sock \
TESTCONTAINERS_RYUK_DISABLED=true vp run benchmark:sync
```

The command creates and destroys a disposable PostgreSQL container. It never reads production credentials. Fixtures contain three labels per entity and roughly 1 KB bodies. Both paths use 100-item page transactions. SQL counts exclude transaction control and count `sql.execute` spans.

The reference uses the current single-entity projection method once per item. It is a conservative comparison of batching, not an exact replay of the old commit. It excludes GitHub HTTP, workflow persistence, rule enrichment, and production network latency.

| Entities | Single-record path | Bulk path | Speedup | SQL statements, single → bulk |
| -------- | ------------------ | --------- | ------- | ----------------------------- |
| 100      | 0.701 s            | 0.051 s   | 13.7×   | 400 → 4                       |
| 1,000    | 4.671 s            | 0.487 s   | 9.6×    | 4,000 → 40                    |
| 10,000   | 35.164 s           | 6.524 s   | 5.4×    | 40,000 → 400                  |

All sizes reduced projection statements by 99%. The production page transaction additionally performs generation/access checks, progress updates, and any required follow-up work.

## Recovery and rollout limits

A stall requires repeated missing workflow results for at least two minutes and no committed progress for five minutes. Recovery calls `interruptUnsafe`, waits for it, and confirms a terminal result before replacing the target. A failed or timed-out interruption never authorizes another writer. Suspended executions keep their durable clocks. Terminal failures remain visible and enter the existing five-minute repair schedule.

Tests cover page rollback/replay, stale labels, PR-first identity, concurrent budget acquisition, response-body timeout, non-overlapping 401 attempts, bounded durable retries, partial scans, slow dispatch isolation, post-transaction wakes, progress counters, and recovery state handling. The memory workflow engine reports hard interrupts differently from Cloudflare; the recovery test explicitly adapts that result contract. This is not a live production fault-injection test of a hung Durable Object.

The measured bottlenecks did not require an adaptive batch-size setting, a second priority queue, or a new per-repository scheduler. Pages remain bounded at GitHub's 100-item limit; API concurrency was not increased. Very large issue bodies, sustained multi-repository load, and real isolate eviction fault injection remain useful longer-running coverage. Rate-limit waits and rule-required enrichment can still make a complete sync take longer than a core scan.

Validation before the third rollout: all 387 tests passed across 63 files. The web build and Worker bundle check passed. Existing build chunk-size and lint warnings are unrelated to this change.

A final Website-only deployment keeps polling active at one-minute intervals when an automatic retry is scheduled. Its 13 focused frontend tests passed, including the added retry-polling case.
