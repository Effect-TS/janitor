# 01: Separate repository eligibility from synchronization

**What to build:** A connected repository remains usable for Slack repository operations while its UI cache is warming or has failed. Connection, pause, and valid GitHub access continue to control work. Expand the shared eligibility model first while keeping legacy labeling safeguards intact until the labeling migrations land.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Shared eligibility distinguishes connection, pause, current GitHub access, and workflow enablement from synchronization progress or failure; it does not consume synchronized issue/PR facts.
- [ ] Slack repository listing, selection, and subsequent repository operations use the new eligibility contract. UI status and refusal reasons distinguish access or pause from cache health.
- [ ] Repository operations reject missing or disconnected repositories and reject unavailable access. Installation discovery can still discover repositories before connection.
- [ ] Pause, disconnect, and access changes fence pending work; restoration does not revive work accepted under an obsolete connection or access generation.
- [ ] Stable repository identity survives rename or transfer, with current installation/access revalidation after transfer.
- [ ] Introduce the new contract alongside legacy labeling eligibility. Do not release old label jobs by removing their synchronization checks in this slice.
- [ ] Verify operations during initial sync, sync failure, pause, access loss/restoration, and disconnect/reconnect, including a local control change racing a repository operation.
