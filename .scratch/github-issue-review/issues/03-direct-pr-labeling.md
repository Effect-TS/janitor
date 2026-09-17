# 03: Evaluate PR labeling directly against GitHub

**What to build:** PR labeling and its previews use the established direct-GitHub evaluation path, including PR-specific facts, while preserving the existing labeling contract.

**Blocked by:** 02: Evaluate issue labeling directly against GitHub.

**Status:** in-review

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Obtain all supported PR facts required by policies and AI inputs directly from GitHub, including paginated collections where relevant; never fall back to synchronized facts as automation input.
- [ ] Automatic PR evaluations and previews work during incomplete or failed synchronization, using the shared direct-evaluation contract.
- [ ] Preserve PR policy, grouping, label ownership, unknown/failed evaluation, and retry semantics. Closed or merged PRs remain outside labeling scope.
- [ ] Revalidate relevant PR state, rule configuration, and repository authority at each actual label-write attempt; newer work supersedes obsolete work without depending on cache generations.
- [ ] Fence or retire pending legacy PR labeling jobs at cutover so old synchronized plans cannot publish afterward.
- [ ] Frontend previews continue to expose evidence and proposed label effects without applying them.
- [ ] Verify PR-specific conditions and pagination, changed remote state, access loss, stale cached data, and synchronization failure; retain green issue-labeling coverage.

## Comments

2026-09-17: Implemented on this branch. Migration `0040_direct_pull_request_labeling.sql` retires pending legacy pull request jobs, closes their pending rows as superseded, renames pending direct issue work to the shared `Janitor/LabelItemV1` tag, and moves the access fence's cache-only exemption to that tag. `apps/cluster/src/Labeling/DirectLabeling.ts` (formerly `IssueLabeling.ts`) is the one direct path for issues and pull requests: `pull_request` deliveries are admitted through the new `AutomationIntegration.pullRequestEvent` hook, closed or merged pull requests are refused at admission, at run and at each write attempt, and the workflow reads the issue, the pull request record and the collections the configured revision needs (`GitHubPullRequest.ts`: changed files bounded at 3000, check runs and reviews paginated, the pull request reread afterwards and the whole read repeated once when it changed meanwhile). An unreconcilable or bounded file listing leaves `changedFiles` unavailable, so the rule evaluates unknown and keeps its label. `Facts.ts` builds the evaluator's snapshot and the admission fingerprint for both kinds. `ReconcileEntity`, `SnapshotHandoff` and the sync hook's `entityVerified` are gone; `LabelingSyncIntegrationLayer` only tells the UI cache which collections to mirror. The test bench reads pull requests and the collections its subject needs from GitHub, so previews no longer depend on the cache. The legacy readiness predicates and `withRepositoryActivity` stay for the ingress until ticket 04.

Recorded, not changed here: the admission fingerprint still describes the webhook payload rather than the evaluated facts. A pull request whose head keeps changing across two full reads records a `failed` outcome and waits for the next event. The bench refuses a preview with a message when a pull request changes during its read.
