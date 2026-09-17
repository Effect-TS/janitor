# 03: Evaluate PR labeling directly against GitHub

**What to build:** PR labeling and its previews use the established direct-GitHub evaluation path, including PR-specific facts, while preserving the existing labeling contract.

**Blocked by:** 02: Evaluate issue labeling directly against GitHub.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Obtain all supported PR facts required by policies and AI inputs directly from GitHub, including paginated collections where relevant; never fall back to synchronized facts as automation input.
- [ ] Automatic PR evaluations and previews work during incomplete or failed synchronization, using the shared direct-evaluation contract.
- [ ] Preserve PR policy, grouping, label ownership, unknown/failed evaluation, and retry semantics. Closed or merged PRs remain outside labeling scope.
- [ ] Revalidate relevant PR state, rule configuration, and repository authority at each actual label-write attempt; newer work supersedes obsolete work without depending on cache generations.
- [ ] Fence or retire pending legacy PR labeling jobs at cutover so old synchronized plans cannot publish afterward.
- [ ] Frontend previews continue to expose evidence and proposed label effects without applying them.
- [ ] Verify PR-specific conditions and pagination, changed remote state, access loss, stale cached data, and synchronization failure; retain green issue-labeling coverage.
