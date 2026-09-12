# 07: Publish new work as a pull request

**What to build:** A teammate requests repository work in Slack and receives a reviewable GitHub PR on a designated branch, with durable workspace and publication state.

**Blocked by:** 03: Collaborate with Janitor in a private Slack thread; 06: Edit, test and recover repository work.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Connect Slack repository selection to the production execution adapter. The agent can edit/test and create the designated new-work branch and PR when appropriate; humans retain merge control.
- [x] Mint installation/repository/permission-scoped tokens, cache by that complete identity and refresh before expiry. Deliver only short-lived credentials to controlled Git operations.
- [x] Recheck repository readiness, session generation and intended repository/branch before publication. Record intended commit, branch and PR head/base identity before writes; token repository scope is not branch enforcement.
- [x] Preserve concurrent human commits without force-overwriting them. Reconcile stale pushes against fetched history and ask about semantic conflicts rather than silently discarding edits.
- [x] After lost write responses, inspect remote refs and matching PRs with stable operation identity; allow PR metadata to lag refs. Unknown outcomes block dependent work, not trigger new branches/PRs.
- [x] Persist PR/session associations and deliver a substantive Slack result with the PR link. Unavailable writes preserve work and explain the limitation.
- [x] Test scoped credential expiry/revocation, denied writes, concurrent pushes, actual or controlled lost responses, credential exclusion and duplicate PR prevention.
- [x] Clean bounded live branches/PRs without merging.

## Comments

Implemented on 2026-09-12. The existing Slack repository selection reaches a new native `publish` tool. Each session has one designated branch and a durable publication record. The tool requires committed work, fetches current history, incorporates clean human changes, checkpoints the resulting local branch, and records its commit/head/base before remote writes. Git credentials never reach the ordinary shell or workspace Git configuration. A private temporary repository excludes source hooks, config, alternates and replacement refs. Merges run in a private worktree compatible with Git 2.34 in the pinned image.

Installation, numeric repository and permission set determine credential cache identity. Tests cover refresh before expiry, rejected issuance, separate installations and repositories, readiness loss, stale generations and rejection of new-work publication for a Slack conversation already associated with a PR.

The native acceptance test runs Workerd, durable SQLite, R2 and the production bridge image with real local Git repositories. It loses preparation, push and PR responses, prevents dependent shell execution while publication is unresolved, recovers after restart and an interrupted checkpoint upload, and verifies denied/invalid PR writes, metadata lag, credential exclusion and duplicate prevention. The bridge test also covers concurrent pushes, semantic conflicts, a rejecting receive hook and hostile workspace credential/remote configuration. Local repositories and containers are removed after the tests.

### Standards review

Review found an unrecorded image digest, an additional test seam that had not been confirmed, and stale operational documentation. The image manifest and README are updated, and the extra test was removed. A phase-discriminated union for the publication record remains a nonblocking design suggestion. No remaining documented-standard or correctness blockers were found.

### Spec review

Review found that a lost preparation response could strand publication before any push. Preparation now has a durable, credential-free bridge receipt and a stable attempt identity. Native acceptance covers lost preparation responses and checkpoint interruption. Confirmed validation rejections also permit correction and retry. Follow-up review found no remaining specification defects in the implementation.

### Initial local evidence

Validation passed with 106 root test files and 585 tests, six runner test files and 29 tests, and seven bridge tests. That runner suite includes divergent commits on the pinned Git version. Runner typecheck and production build passed. Root `vp check` passed with zero errors and 435 warnings. The recorded image digest and embedded bridge source hashes match the tested image. At that point no live GitHub writes, messages to teammates, paid model calls or deployment had been performed, so the final checkbox remained open pending the live continuation below.

### Live acceptance continuation

The user authorized completing bounded live acceptance in this thread. The [recorded evidence](../evidence/07-publication-live.json) retains every attempt and cleanup result. The final live test passed on 2026-09-12 using local Workerd, durable SQLite/R2, the production bridge image and actual GitHub App installation tokens restricted to `Effect-TS/slopcop-sandbox`.

Live testing found a production credential defect. GitHub rejected PR creation with HTTP 422 and `not all refs are readable` when the PR token had only Pull requests write. Adding Contents read resolved the failure. The agreed repository credential API test failed before this fix and passed afterward. The live runner then created PRs [#10](https://github.com/Effect-TS/slopcop-sandbox/pull/10) and [#11](https://github.com/Effect-TS/slopcop-sandbox/pull/11), recovered after discarded successful push/PR responses and a runtime restart, and verified one push and one PR creation per successful session. Durable events and workspace checkpoints excluded the installation tokens; a revoked token was rejected.

Both PRs are closed without merging, all generated branches are absent, all minted tokens were revoked, and the default branch remains at `d20e1c6b5888a74f4abc24008e211feb00b11807`. An immediate deletion read on the first successful publication failed before a separate read confirmed absence. The driver now polls deletion visibility for up to 20 seconds; the final run passed automatic cleanup. Earlier rejected attempts were also cleaned and are retained in the evidence.

Standards and Spec reviews found cleanup races in the initial live driver. Write budgets and target checks now precede dispatch, closing fences are checked after request-body reads, and cleanup stops execution and waits for dispatched GitHub requests before removing remote work. Follow-up reviews found no remaining blockers. The permission documentation was corrected.

The designated private repository still returns HTTP 403 asking for a plan upgrade when its administrator reads branch protection. No protection configuration changed. Actual protected-branch rejection and deployed service bindings remain deployment/environment acceptance work. The live driver uses a scripted model and fixture authority; it does not establish deployed Slack delivery or production authority readiness behavior. No Slack messages, paid model calls or deployment occurred in this continuation.

Final validation after the permission fix passed: 106 root files with 585 tests, six runner files with 29 tests, and the separately authorized live test. The live test is skipped by default in the runner suite. Runner typecheck passed; root `vp check` reported zero errors and 435 warnings. A final read-only GitHub audit confirmed all six attempted branch names absent, both test PRs closed and unmerged, and the default head unchanged.
