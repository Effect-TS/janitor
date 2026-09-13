# 04: Observe sessions and recorded usage in Janitor

**What to build:** Teammates browse ongoing sessions and open their home threads while seeing accurate execution status, delivery health and recorded token usage.

**Blocked by:** 03: Collaborate with Janitor in a private Slack thread.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Provide paginated session list/detail with title, repository when known, home-thread and PR associations, meaningful activity, execution reason, usage, delivery warnings and freshness.
- [x] Gate HTTP reads and live subscriptions on valid browser Access and active Janitor membership. Admin/member visibility is equivalent and independent of Slack channel membership; removal prevents continued subscription access.
- [x] Project working/idle/blocked/failed from durable facts, independently of delivery health and projection staleness. Completed turns return to idle; historical failures do not override newer outcomes.
- [x] Apply cumulative usage snapshots and exclusive cursor advancement atomically by replacement. Display input plus cache read/write and output plus reasoning; distinguish unavailable totals and explain omitted/unreported usage.
- [x] Order working sessions first then meaningful activity with stable pagination. Heartbeats, usage-only changes and delivery retry bookkeeping do not reorder activity.
- [x] Commit invalidation intent with projection updates and reuse HTTP refresh/live invalidation/reconnect/fallback behavior. Preserve last known data with a stale/reconnecting indication.
- [x] Test replay, sequence gaps, missing invalidations, late updates, reconnects, removed viewers and successful work with pending delivery. Do not add logs, conversation history, spending or team totals.

## Comments

2026-09-13: Implemented for maintainer review. Migration `0028_session_observation.sql` adds the team-wide `sessions` live channel with invalidation triggers on the session projection, session identity, home-thread associations, delivery health and membership. `SessionObservation` composes one read model from Janitor's session identity and associations, the runner-projected execution facts and usage, and the delivery records: paginated list ordered working first, then meaningful activity, then session ID, plus compact detail with pending inputs, latest error, pending delivery and recovery status. Cumulative usage is replaced under cursor protection and displayed as input plus cache read/write and output plus reasoning, unavailable until the first snapshot. Accepted input is meaningful activity and moves an idle or failed session to working; runner holds are blocked with their reason; delivery warnings and projection freshness stay independent of execution state.

Routes under `/api/v1/sessions` sit behind Access and active membership; the live channel rechecks membership at the boundary and removal closes open subscriptions through the membership topic. The web dashboard at `/sessions` reuses the repository live pattern (socket, reconnect refresh, fallback timer), coalesces invalidations during a read, and keeps last known data with a stale or reconnecting indication when a refresh fails. No conversation history, logs, spending or team totals are exposed.

Tests cover ordering and stable pages under usage-only changes, unavailable versus normalized-zero usage and out-of-order snapshot rejection, execution/delivery/freshness independence, turn completion returning to idle, new input superseding a historical failure, pending threads and hidden disconnected sessions, invalidation intent rolling back with the projection, membership revocation, route authorization and the browser refresh/stale/denied behaviour.

Validation: `vp check` passed with warnings and no errors; the full suite passed (backend and web) with the runner-backed suites skipped as before. The review found no documented-standard breaches and one P1 specification issue (a terminally rejected admission left the session working), fixed with a regression test, plus four P2 findings (freshness read failures not invalidating, invalidation refreshes dropping loaded pages, stale rejection errors on idle sessions, untested reconnect and fallback paths) and the platform-recovery scope creep, all resolved. See [the review record](../review-04.md).
