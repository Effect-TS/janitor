# 04: Complete the synchronization-as-cache migration

**What to build:** Synchronization becomes solely a frontend cache optimization across Janitor. Operators can distinguish cache health from automation eligibility, and existing automation stays usable when cache refresh fails.

**Blocked by:** 03: Evaluate PR labeling directly against GitHub.

**Status:** ready-for-agent

**Completion:** complete. Reconciled on 2026-09-18. See [completion review](../completion-review.md).

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Remove remaining synchronization-readiness and synchronization-health dependencies from automation admission, facts, repository access checks, and publication qualification after all consumers have migrated.
- [x] Separate installation access/availability from inventory or synchronization controls. Audit lifecycle triggers and pending-work cleanup so cache changes cannot cancel or release automation incorrectly.
- [x] Retain actual connection, pause, access, stale-work, and configuration safeguards while deleting obsolete compatibility paths introduced for the migration.
- [x] Frontend repository status reports cache refresh health separately from why automation or repository operations are permitted or refused.
- [x] Synchronization and webhook projections may update the UI cache but cannot trigger catch-up labeling or authorize issue review; preserve the accepted event-driven labeling semantics.
- [x] Verify initial connection, failed/manual sync, pause/resume, access restoration, rename/transfer, and disconnect/reconnect across issue labeling, PR labeling, and Slack repository access.
- [x] Provide evidence that automation uses direct GitHub reads even when cached records are stale or absent. Complete this migration before production issue-review enablement.

## Comments

2026-09-17: Implemented on this branch. Migration `0042_cache_only_synchronization.sql` drops `repository_access_available`, `repository_automation_ready`, `entity_automation_eligible`, the readiness triggers, `automation_ready_at`, `synchronization_required_after`, the generated `sync_enabled` repository column and `sync_target.automation_event_at`. `repository_block_reason` and `repository_access_current` are the only eligibility predicates left: `RepositoryEligibility.admit` (the former `withRepositoryActivity`) fences webhook journaling and projection on them plus the `webhooks_after` boundary, and `SyncFence.withSyncScope` fences cache writes on `sync_scope_enabled`, which is where the installation sync setting now lives. One `fence_repository_work` function handles access and installation changes: it supersedes cache runs, requests a full refresh of each track once the cache may run again, and discards pending outbox work; the pause trigger is unchanged. An installation's sync toggle has no trigger effect at all. `SyncIntegration.trackVerified` and the `webhookReceivedAt` invalidation hint are gone, so a completed refresh cannot reach labeling. The connection inventory derives `syncState` from `sync_target` (`access-unavailable`, `paused`, `disabled`, `failed`, `syncing`, `ready`, now a domain literal) and the settings page copy says automation keeps working while the cache fails or is off. `Labeling/CacheIndependence.test.ts` labels issues and pull requests from GitHub while the cached record is stale, absent, failed or switched off, shows manual and verified refreshes leave the labeling queue unchanged, and shows an installation access change discards admitted work and refuses it after restoration; existing suites cover pause, rename, transfer, disconnect and Slack access.

Applied after review: the configuration view no longer reports `pendingTracks`, the last activation surface that read `sync_target` health (its preparation was always empty since activation became immediate); the repository page's "Retry sync" now posts to the repository sync endpoint instead of resuming the repository, so a cache retry is neither a control change nor an audited resumption; the evidence test also covers a transfer to another installation.

Recorded, not changed here: after an access restoration the cache's full refresh waits for the repair cron's retry pass rather than starting inside the restoring request. The `labeling_reconciliation.source` column stays because `sync` still describes historical rows.

2026-09-18 completion review: implementation commit `d65762c` and current code/test coverage support completion of this ticket. Earlier comments describe each slice at implementation time; later tickets supersede their temporary limitations. Live deployment verification remains separate, as recorded in [the completion review](../completion-review.md).
