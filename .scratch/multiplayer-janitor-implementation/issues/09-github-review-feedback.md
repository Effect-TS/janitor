# 09: Address GitHub review feedback automatically

**What to build:** Authorized GitHub review feedback steers the same agent session, which implements changes and replies on GitHub without another Slack prompt.

**Blocked by:** 08: Collaborate on an existing pull request.

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Extend verified webhook intake for submitted reviews, inline comments/replies and PR conversation comments. Authenticate delivery and resolve numeric reviewer identity through the enabled Janitor link.
- [ ] Route only associated PRs. Authorized reviews/inline replies are automatic inputs; top-level PR conversation comments require a Janitor mention. Outside feedback remains context until authorized direction; bot output is excluded.
- [ ] Group body/inline membership by review ID and hydrate paginated comments without timing debounce. Deduplicate overlapping envelopes/comment IDs in either arrival order; standalone feedback and later replies remain distinct contributions.
- [ ] Freeze first-captured feedback and retain incomplete/unclassified hydration visibly pending. Ignore empty state-only reviews, preserve accepted payloads through edit/delete and account-removal retries.
- [ ] Admit feedback into the same durable per-session order as Slack and implement it on the associated PR branch.
- [ ] Reply inline when possible or in the PR conversation for overall results. Persist marker-based output intent and reconcile ambiguous sends. Deleted targets produce explicit delivery problems without Slack redirection or completion notification.
- [ ] Test pending-review replies, later replies, paginated mutation, duplicates, bot events, body-only reviews, authorization races and response loss. Run bounded live review fixtures and clean their branches/PRs.
