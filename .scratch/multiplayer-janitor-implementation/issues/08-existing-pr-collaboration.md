# 08: Collaborate on an existing pull request

**What to build:** Teammates start Janitor from an existing PR and collaborate on its branch through one home thread instead of opening companion PRs.

**Blocked by:** 07: Publish new work as a pull request.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Resolve an existing PR to its connected repository and existing head/base identities, adopt its branch in the isolated workspace and retain the same PR as the review destination.
- [ ] Enforce unique PR/session routing transactionally. Concurrent starts or a mention from another thread direct teammates to the established home thread rather than allocate a competing workspace.
- [ ] Update the existing branch using the publication controls already implemented; preserve human commits and surface semantic conflicts on the PR.
- [ ] If the branch is unavailable for writing, preserve edits and explain on the PR when possible. A separate proposal requires explicit teammate direction.
- [ ] Propagate PR associations through events and existing observation/output contracts without changing the ongoing-session model.
- [ ] Demonstrate the blog-post collaboration scenario with two teammates, simultaneous thread starts, a human commit during agent work and unavailable branch access. No automatic merge or GitHub-to-Slack completion feature is introduced.
