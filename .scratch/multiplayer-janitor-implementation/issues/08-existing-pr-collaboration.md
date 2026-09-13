# 08: Collaborate on an existing pull request

**What to build:** Teammates start Janitor from an existing PR and collaborate on its branch through one home thread instead of opening companion PRs.

**Blocked by:** 07: Publish new work as a pull request.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Resolve an existing PR to its connected repository and existing head/base identities, adopt its branch in the isolated workspace and retain the same PR as the review destination.
- [x] Enforce unique PR/session routing transactionally. Concurrent starts or a mention from another thread direct teammates to the established home thread rather than allocate a competing workspace.
- [x] Update the existing branch using the publication controls already implemented; preserve human commits and surface semantic conflicts on the PR.
- [x] If the branch is unavailable for writing, preserve edits and explain on the PR when possible. A separate proposal requires explicit teammate direction.
- [x] Propagate PR associations through events and existing observation/output contracts without changing the ongoing-session model.
- [x] Demonstrate the blog-post collaboration scenario with two teammates, simultaneous thread starts, a human commit during agent work and unavailable branch access. No automatic merge or GitHub-to-Slack completion feature is introduced.

## Comments

Implemented on 2026-09-12. Existing PR starts resolve their identities before repository tools run, adopt the existing branch and retain the original PR through later turns and restarts. Slack allocation serializes PR routing, normalizes numeric references and directs mentions from other active conversations to the established home. Session reads expose PR links, and publication events produce substantive home-thread output.

Controlled Git incorporates human commits without force pushing. Semantic conflicts and denied writes preserve edits and create a durable explanation on the original PR when access permits. Lost comment replies require marker, destination and GitHub App attribution before clearing the delivery hold. Fork PRs can be edited through the base repository's PR ref; publication to the fork is unavailable with the base-repository token. No companion PR is created.

Confirmed test seams were the existing Slack conversation integration tests, repository authority, native runner publication and real-Git bridge tests. Targeted checks cover simultaneous starts by two teammates, a mention from another active session, a human commit during agent work, semantic conflicts, later editing turns after restart, fork-ref checkout, denied writes, retained edits and ambiguous comment delivery with mismatched App attribution. These use local PostgreSQL, Workerd, R2 and Git with controlled GitHub responses. They do not establish live Slack/GitHub or deployed Cloudflare acceptance.

### Standards

Review found duplicated notice guards and a credential refresh after recording an uncertain comment intent. The guards now share one check, and comment sends reuse the authorized credential. The native regression reproduced the missed-send hold and passes after the fix. No remaining documented-standard or correctness findings.

### Spec

Review found that definite comment rejections could be treated as ambiguous and throttled retries lacked a durable deadline. Rejected sends now retain pending output, with the retry deadline committed in the same write. Native validation covers a 422 rejection, a 429 response and an immediate retry after runner restart. No remaining Spec findings.

Review totals: zero remaining Standards findings and zero remaining Spec findings.

### Validation

The full application suite passed 586 tests across 106 files. The full runner suite passed 30 tests across six files; its one opt-in live test was skipped. All nine real-Git/process bridge tests passed. After the review fixes, both native publication tests passed again. Runner typechecking and production build passed. Root `vp check` reported zero errors and 436 warnings. The rebuilt bridge image identity is recorded in `runner/bridge/release.json`.

No live Slack/GitHub messages, paid model calls, deployment or remote publication was performed for this ticket.
