# 02: Evaluate issue labeling directly against GitHub

**What to build:** Incoming issue activity and issue-labeling previews evaluate current GitHub facts without waiting for synchronization. Preserve existing policy and label behavior while establishing the direct evaluation path that PR labeling can extend.

**Blocked by:** 01: Separate repository eligibility from synchronization.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Automatic issue labeling and issue-labeling previews acquire the required facts directly from GitHub; cache freshness, synchronization generations, and synchronization success do not admit or block them.
- [ ] Preserve policy references, gate policies, AI inputs/cache rules, grouping, priority, label ownership, and unknown/failed evaluation behavior. Closed issues remain outside labeling scope.
- [ ] Replace synchronization-derived admission and stale-work qualification with automation-owned identities and current repository/configuration checks for the migrated issue path.
- [ ] Each actual label-write attempt obtains the needed current remote state and checks repository authority and current rule configuration. A cached authorization result cannot authorize a later write.
- [ ] Respect GitHub throttling and existing bounded retry behavior; unavailable facts or operational failure must not masquerade as a non-match.
- [ ] Labeling previews show current evidence, result, and proposed effect without label writes or dependence on cache readiness.
- [ ] Retire or fence pending legacy issue jobs during cutover while leaving PR labeling on its existing safe path until ticket 03. New sync lifecycle events cannot erase or improperly release direct issue work.
- [ ] Verify equivalent supported issue-policy outcomes plus stale UI data, sync failure, out-of-order events, rule changes, and pause/access races.
