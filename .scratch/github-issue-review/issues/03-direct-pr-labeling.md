# 03: Evaluate PR labeling directly against GitHub

**What to build:** PR labeling and its previews use the established direct-GitHub evaluation path, including PR-specific facts, while preserving the existing labeling contract.

**Blocked by:** 02: Evaluate issue labeling directly against GitHub.

**Status:** ready-for-agent

**Completion:** complete. Reconciled on 2026-09-18. See [completion review](../completion-review.md).

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Obtain all supported PR facts required by policies and AI inputs directly from GitHub, including paginated collections where relevant; never fall back to synchronized facts as automation input.
- [x] Automatic PR evaluations and previews work during incomplete or failed synchronization, using the shared direct-evaluation contract.
- [x] Preserve PR policy, grouping, label ownership, unknown/failed evaluation, and retry semantics. Closed or merged PRs remain outside labeling scope.
- [x] Revalidate relevant PR state, rule configuration, and repository authority at each actual label-write attempt; newer work supersedes obsolete work without depending on cache generations.
- [x] Fence or retire pending legacy PR labeling jobs at cutover so old synchronized plans cannot publish afterward.
- [x] Frontend previews continue to expose evidence and proposed label effects without applying them.
- [x] Verify PR-specific conditions and pagination, changed remote state, access loss, stale cached data, and synchronization failure; retain green issue-labeling coverage.

## Comments

2026-09-17: Implemented on this branch. Migration `0041_direct_pull_request_labeling.sql` retires pending legacy pull request jobs, closes their pending rows as superseded, renames pending direct issue work to the shared `Janitor/LabelItemV1` tag, and moves the access fence's cache-only exemption to that tag. `apps/cluster/src/Labeling/DirectLabeling.ts` (formerly `IssueLabeling.ts`) is the one direct path for issues and pull requests: `pull_request` deliveries are admitted through the new `AutomationIntegration.pullRequestEvent` hook, closed or merged pull requests are refused at admission, at run and at each write attempt, and the workflow reads the issue, the pull request record and the collections the configured revision needs (`GitHubPullRequest.ts`: changed files bounded at 3000, check runs and reviews paginated, the pull request reread afterwards and the whole read repeated once when it changed meanwhile). An unreconcilable or bounded file listing leaves `changedFiles` unavailable, so the rule evaluates unknown and keeps its label. `Facts.ts` builds the evaluator's snapshot and the admission fingerprint for both kinds. `ReconcileEntity`, `SnapshotHandoff` and the sync hook's `entityVerified` are gone; `LabelingSyncIntegrationLayer` only tells the UI cache which collections to mirror. The test bench reads pull requests and the collections its subject needs from GitHub, so previews no longer depend on the cache. The legacy readiness predicates and `withRepositoryActivity` stay for the ingress until ticket 04.

Applied after review: the cutover migration also closes direct issue work the engine had accepted under the old tag and settles its planned actions as failed, so a write attempt still running elsewhere finds nothing to write; the changed-file, check-run and review folding rules moved to `packages/domain/src/GitHub/PullRequestCollections.ts` and the cache refresh shares them; `snapshotFacts` accepts partial collections; one `isOpenPullRequest` predicate replaces the repeated closed-or-merged checks; the glossary gains **Item**.

Recorded, not changed here: the admission fingerprint still describes the webhook payload rather than the evaluated facts. A pull request whose head keeps changing across two full reads records a `failed` outcome and waits for the next event. A check-run or review listing past 200 pages, or one GitHub refuses, fails the evaluation rather than leaving the fact unknown; a bounded changed-file listing leaves the fact unknown. A write attempt rereads the item's state and labels but not its draft or base branch; the event GitHub sends for such a change admits a newer observation that supersedes the pending write. The bench lists open pull requests with one pull request read each, bounded by the 25-item limit. Legacy accepted `ReconcileEntityV1` jobs are fenced only by stopping old workers before the migration, as the README states.

2026-09-18 completion review: implementation commit `c0864f0` and current code/test coverage support completion of this ticket. Earlier comments describe each slice at implementation time; later tickets supersede their temporary limitations. Live deployment verification remains separate, as recorded in [the completion review](../completion-review.md).
