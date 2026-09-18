# 10: Handle subsequent reproductions without overwriting human work

**What to build:** Later authorized reviews improve an existing Janitor reproduction only when doing so preserves human work. The frontend explains blocked updates and retains proposed changes.

**Blocked by:** 09: Publish the first draft reproduction PR.

**Status:** ready-for-agent

**Completion:** complete. Reconciled on 2026-09-18. See [completion review](../completion-review.md).

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0007, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Reuse a PR only when it is open and draft, its branch is recorded as Janitor-owned, and branch head plus PR content match the last recorded publication.
- [x] Compare expected state at the actual update attempt and reject intervening changes. Do not overwrite human branch commits, human PR text, or a PR someone marked ready.
- [x] When reuse is blocked, leave GitHub artifacts unchanged and retain findings and proposed patch in the frontend with the reason.
- [x] Closed or merged PRs are never reopened automatically. A new invocation may create a new owned draft when current evidence warrants it, without disturbing the old artifacts.
- [x] Apply the same test-only validation, exact tested base, current authorization, dry-run, cancellation, and output restrictions used for first publication.
- [x] Updates use action identities and persisted expected/new publication fingerprints. Repeated completion delivery or uncertain responses cannot repeat investigation or create another PR.
- [x] Keep the single issue summary consistent with confirmed outcomes and explain partial or unresolved publication accurately.
- [x] Verify unchanged-draft reuse, human changes before and during publication, ready/closed/merged states, missing branch, and lost update responses.

## Comments

Implemented in `368ae13`. `Review/DraftPublication.ts` selects recorded owned drafts and compares branch head, PR title/body fingerprints, draft state, and base before updates. Separate durable branch and PR actions recheck authority, retain blocked proposals, and reconcile uncertain writes. Migration `0048_issue_review_draft_reuse.sql` retains issue and base-branch identity with ownership records. `Review/Investigation.test.ts` covers reuse, human edits before and between writes, ready/missing/closed/merged artifacts, lost responses, repeated completion, and reuse after history expiry.

2026-09-18 completion review: implementation commit `368ae13` and current code/test coverage support completion of this ticket. Earlier comments describe each slice at implementation time; later tickets supersede their temporary limitations. Live deployment verification remains separate, as recorded in [the completion review](../completion-review.md).
