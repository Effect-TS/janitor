# 10: Recover missed events and interrupted platform delivery

**What to build:** Janitor catches up on recoverable missed feedback and delivers retained replies after platform interruptions, while exposing gaps and uncertain outcomes honestly.

**Blocked by:** 04: Observe sessions and recorded usage in Janitor; 09: Address GitHub review feedback automatically.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Run five-minute rate-aware GitHub retained-delivery scans using App authentication, durable opaque cursors and per-page progress. Filter summaries before payload fetch; preserve exact large attempt IDs separately from delivery GUIDs.
- [x] Scan known Slack home threads with overlap after the initiating boundary. Deduplicate against accepted/rejected inputs and initial context; apply current authorization only to previously unseen contributions.
- [ ] Expose overdue scans, incomplete hydration and known unrecoverable gaps. Do not claim recovery of deleted uncaptured text, never-received starts or expired delivery history.
- [x] Persist Retry-After deadlines and output ordering through process restart. Preserve substantive/final/error output, coalesce pending progress, split valid Unicode within real platform limits and avoid channel-rate floods.
- [x] Reconcile ambiguous sends by positive marker/author/destination lookup across pages. Missing or deleted markers remain uncertain and cannot authorize reposting.
- [ ] Loss of home-thread access retains work/output with an independent dashboard delivery warning. Restore the same queued replies when access returns without moving conversation to a DM or another channel.
- [ ] Verify actual bot removal/reinvite and retained delivery in a private test channel, with a participant performing platform-only steps. Test redelivery GUID deduplication, expired history limits and local crash/throttle cases; record which are live versus simulated.

## Comments

2026-09-12: Backend recovery is implemented and committed. Session views expose overdue scans, pending capture, known gaps and independent delivery warnings. Browser visibility remains dependent on ticket 04, whose dashboard is absent in the starting tree. PostgreSQL tests verify retained replies through simulated membership loss and service restart, paginated positive reconciliation and missing/deleted-marker uncertainty. The live check ran last but Slack returned `account_inactive` before any writes. Removal/reinvite acceptance remains blocked on restoration of the fixture app/token. See [validation and evidence](../platform-recovery-validation.md).
