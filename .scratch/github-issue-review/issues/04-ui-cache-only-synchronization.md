# 04: Complete the synchronization-as-cache migration

**What to build:** Synchronization becomes solely a frontend cache optimization across Janitor. Operators can distinguish cache health from automation eligibility, and existing automation stays usable when cache refresh fails.

**Blocked by:** 03: Evaluate PR labeling directly against GitHub.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Remove remaining synchronization-readiness and synchronization-health dependencies from automation admission, facts, repository access checks, and publication qualification after all consumers have migrated.
- [ ] Separate installation access/availability from inventory or synchronization controls. Audit lifecycle triggers and pending-work cleanup so cache changes cannot cancel or release automation incorrectly.
- [ ] Retain actual connection, pause, access, stale-work, and configuration safeguards while deleting obsolete compatibility paths introduced for the migration.
- [ ] Frontend repository status reports cache refresh health separately from why automation or repository operations are permitted or refused.
- [ ] Synchronization and webhook projections may update the UI cache but cannot trigger catch-up labeling or authorize issue review; preserve the accepted event-driven labeling semantics.
- [ ] Verify initial connection, failed/manual sync, pause/resume, access restoration, rename/transfer, and disconnect/reconnect across issue labeling, PR labeling, and Slack repository access.
- [ ] Provide evidence that automation uses direct GitHub reads even when cached records are stale or absent. Complete this migration before production issue-review enablement.
