# 04: Observe sessions and recorded usage in Janitor

**What to build:** Teammates browse ongoing sessions and open their home threads while seeing accurate execution status, delivery health and recorded token usage.

**Blocked by:** 03: Collaborate with Janitor in a private Slack thread.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Provide paginated session list/detail with title, repository when known, home-thread and PR associations, meaningful activity, execution reason, usage, delivery warnings and freshness.
- [ ] Gate HTTP reads and live subscriptions on valid browser Access and active Janitor membership. Admin/member visibility is equivalent and independent of Slack channel membership; removal prevents continued subscription access.
- [ ] Project working/idle/blocked/failed from durable facts, independently of delivery health and projection staleness. Completed turns return to idle; historical failures do not override newer outcomes.
- [ ] Apply cumulative usage snapshots and exclusive cursor advancement atomically by replacement. Display input plus cache read/write and output plus reasoning; distinguish unavailable totals and explain omitted/unreported usage.
- [ ] Order working sessions first then meaningful activity with stable pagination. Heartbeats, usage-only changes and delivery retry bookkeeping do not reorder activity.
- [ ] Commit invalidation intent with projection updates and reuse HTTP refresh/live invalidation/reconnect/fallback behavior. Preserve last known data with a stale/reconnecting indication.
- [ ] Test replay, sequence gaps, missing invalidations, late updates, reconnects, removed viewers and successful work with pending delivery. Do not add logs, conversation history, spending or team totals.
