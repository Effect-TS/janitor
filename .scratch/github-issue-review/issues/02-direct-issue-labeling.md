# 02: Evaluate issue labeling directly against GitHub

**What to build:** Incoming issue activity and issue-labeling previews evaluate current GitHub facts without waiting for synchronization. Preserve existing policy and label behavior while establishing the direct evaluation path that PR labeling can extend.

**Blocked by:** 01: Separate repository eligibility from synchronization.

**Status:** in-review

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Automatic issue labeling and issue-labeling previews acquire the required facts directly from GitHub; cache freshness, synchronization generations, and synchronization success do not admit or block them.
- [ ] Preserve policy references, gate policies, AI inputs/cache rules, grouping, priority, label ownership, and unknown/failed evaluation behavior. Closed issues remain outside labeling scope.
- [ ] Replace synchronization-derived admission and stale-work qualification with automation-owned identities and current repository/configuration checks for the migrated issue path.
- [ ] Each actual label-write attempt obtains the needed current remote state and checks repository authority and current rule configuration. A cached authorization result cannot authorize a later write.
- [ ] Respect GitHub throttling and existing bounded retry behavior; unavailable facts or operational failure must not masquerade as a non-match.
- [ ] Labeling previews show current evidence, result, and proposed effect without label writes or dependence on cache readiness.
- [ ] Retire or fence pending legacy issue jobs during cutover while leaving PR labeling on its existing safe path until ticket 03. New sync lifecycle events cannot erase or improperly release direct issue work.
- [ ] Verify equivalent supported issue-policy outcomes plus stale UI data, sync failure, out-of-order events, rule changes, and pause/access races.

## Comments

2026-09-17: Implemented on this branch. Migration `0039_direct_issue_labeling.sql` adds `labeling_reconciliation.source`, retires pending legacy issue jobs, and stops cache-only lifecycle changes from discarding direct work or moving the webhook admission boundary. `apps/cluster/src/Labeling/IssueLabeling.ts` is the direct path: `issues` deliveries are admitted through the new `AutomationIntegration` hook inside the projection transaction, keyed by repository, issue, an observation generation derived from the journal sequence, the configured rules revision, and the pinned eligibility generation. The `Janitor/LabelIssueV1` workflow requalifies against `RepositoryEligibility`, reads the issue from GitHub with durable rate-limit waits, evaluates the configured revision with the existing evaluator, records to the shared ledger (`Ledger.ts`, also used by `ReconcileEntity`), and applies the recorded plan inside `RepositoryEligibility.run` with a fresh issue and label-catalog read per attempt. Closed issues and pull requests are refused at admission, at run and at write. `SnapshotHandoff` and `ReconcileEntity` refuse issues, so pull requests alone stay on the synchronized path. The test bench reads issues from GitHub and reports label names and the evidence source; pull requests keep cached facts until ticket 03.

Recorded after review, not changed here: the admission fingerprint is computed from the webhook payload while the evaluation reads GitHub, so on the direct path it no longer describes the evaluated facts. Write-side 5xx responses settle the action as failed without a retry, matching the legacy path. The legacy `withRepositoryActivity` fence still gates admission and stays until ticket 04.
