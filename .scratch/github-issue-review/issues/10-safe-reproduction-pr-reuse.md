# 10: Handle subsequent reproductions without overwriting human work

**What to build:** Later authorized reviews improve an existing Janitor reproduction only when doing so preserves human work. The frontend explains blocked updates and retains proposed changes.

**Blocked by:** 09: Publish the first draft reproduction PR.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0007, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Reuse a PR only when it is open and draft, its branch is recorded as Janitor-owned, and branch head plus PR content match the last recorded publication.
- [ ] Compare expected state at the actual update attempt and reject intervening changes. Do not overwrite human branch commits, human PR text, or a PR someone marked ready.
- [ ] When reuse is blocked, leave GitHub artifacts unchanged and retain findings and proposed patch in the frontend with the reason.
- [ ] Closed or merged PRs are never reopened automatically. A new invocation may create a new owned draft when current evidence warrants it, without disturbing the old artifacts.
- [ ] Apply the same test-only validation, exact tested base, current authorization, dry-run, cancellation, and output restrictions used for first publication.
- [ ] Updates use action identities and persisted expected/new publication fingerprints. Repeated completion delivery or uncertain responses cannot repeat investigation or create another PR.
- [ ] Keep the single issue summary consistent with confirmed outcomes and explain partial or unresolved publication accurately.
- [ ] Verify unchanged-draft reuse, human changes before and during publication, ready/closed/merged states, missing branch, and lost update responses.
