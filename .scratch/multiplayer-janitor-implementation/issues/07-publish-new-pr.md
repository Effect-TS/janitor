# 07: Publish new work as a pull request

**What to build:** A teammate requests repository work in Slack and receives a reviewable GitHub PR on a designated branch, with durable workspace and publication state.

**Blocked by:** 03: Collaborate with Janitor in a private Slack thread; 06: Edit, test and recover repository work.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Connect Slack repository selection to the production execution adapter. The agent can edit/test and create the designated new-work branch and PR when appropriate; humans retain merge control.
- [ ] Mint installation/repository/permission-scoped tokens, cache by that complete identity and refresh before expiry. Deliver only short-lived credentials to controlled Git operations.
- [ ] Recheck repository readiness, session generation and intended repository/branch before publication. Record intended commit, branch and PR head/base identity before writes; token repository scope is not branch enforcement.
- [ ] Preserve concurrent human commits without force-overwriting them. Reconcile stale pushes against fetched history and ask about semantic conflicts rather than silently discarding edits.
- [ ] After lost write responses, inspect remote refs and matching PRs with stable operation identity; allow PR metadata to lag refs. Unknown outcomes block dependent work, not trigger new branches/PRs.
- [ ] Persist PR/session associations and deliver a substantive Slack result with the PR link. Unavailable writes preserve work and explain the limitation.
- [ ] Test scoped credential expiry/revocation, denied writes, concurrent pushes, actual or controlled lost responses, credential exclusion and duplicate PR prevention. Clean bounded live branches/PRs without merging.
