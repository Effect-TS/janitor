# 09: Address GitHub review feedback automatically

**What to build:** Authorized GitHub review feedback steers the same agent session, which implements changes and replies on GitHub without another Slack prompt.

**Blocked by:** 08: Collaborate on an existing pull request.

**Status:** needs-triage

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [x] Extend verified webhook intake for submitted reviews, inline comments/replies and PR conversation comments. Authenticate delivery and resolve numeric reviewer identity through the enabled Janitor link.
- [x] Route only associated PRs. Authorized reviews/inline replies are automatic inputs; top-level PR conversation comments require a Janitor mention. Outside feedback remains context until authorized direction; bot output is excluded.
- [x] Group body/inline membership by review ID and hydrate paginated comments without timing debounce. Deduplicate overlapping envelopes/comment IDs in either arrival order; standalone feedback and later replies remain distinct contributions.
- [x] Freeze first-captured feedback and retain incomplete/unclassified hydration visibly pending. Ignore empty state-only reviews, preserve accepted payloads through edit/delete and account-removal retries.
- [x] Admit feedback into the same durable per-session order as Slack and implement it on the associated PR branch.
- [x] Reply inline when possible or in the PR conversation for overall results. Persist marker-based output intent and reconcile ambiguous sends. Deleted targets produce explicit delivery problems without Slack redirection or completion notification.
- [x] Test pending-review replies, later replies, paginated mutation, duplicates, bot events, body-only reviews, authorization races and response loss. Run bounded live review fixtures and clean their branches/PRs.

## Comments

Implemented locally on 2026-09-12. Verified intake journals encrypted delivery and frozen feedback authorization in the same repository transaction. Review IDs group body and inline members across either envelope order. Paginated hydration preserves first-captured text, pending reviews and unclassified feedback remain visible, and accepted decisions survive account disconnection or removal. Outside feedback remains attributed context for later authorized direction.

Feedback uses the existing session acceptance sequence and runner handoff. The output consumer tracks durable inbox delivery to route GitHub-origin results to GitHub, with no Slack progress or completion messages. Inline replies retain the discussion root even when the submitted-review envelope arrives first. Reply intents precede sends, ambiguous sends require a positive App/destination/marker match, and missing targets retain explicit delivery problems. Uncertain replies hold later runner handoffs. Session reads expose hydration and delivery warnings.

### Standards

The review found an unfenced GitHub POST and destination-specific enqueue logic inside Slack delivery. Publication now holds the repository fence through authorization and the complete send; shared routing lives in Agent/Output.ts. A proposed event-readiness invalidation requirement was withdrawn because the accepted ongoing-session contract preserves inputs through readiness holds. The migration documentation now states that distinction. No remaining Standards findings.

### Spec

The review found that review-first delivery of a later inline reply could choose the reply itself as the output target. Hydration now stores the discussion root. The regression failed before the fix and passes afterward. No remaining implementation findings. Live acceptance was pending at the initial review; the follow-up below completes it.

Review totals: zero remaining Standards findings and zero remaining implementation Spec findings.

### Validation

The full application suite passed 597 tests, with the opt-in live fixture skipped. After review fixes, the feedback/output suites passed 15 tests and verified ingress passed 19, including the additional reply-order and journal-failure regressions. The full native runner suite passed 30 tests, with its existing opt-in live publication fixture skipped. Native publication includes a GitHub-origin turn updating the same existing PR branch while preserving human commits.

Tests cover paginated mutation, overlapping envelopes, pending-review replies, later replies in either order, body-only and empty reviews, bot filtering, exact mentions, rejection across linking/restoration, concurrent removal, preserved accepted authorship, missing targets and lost-send reconciliation. These are controlled PostgreSQL, HTTP, Workerd and real-Git tests. They do not establish live webhook callbacks, deployed service bindings or account-link callbacks.

Root `vp check` passed with zero errors and 456 warnings. Runner typechecking and the production build passed.

### Initial live-validation handoff

The [bounded live fixture](../github-review-fixture.md) is ready. The user requested exact credential variables and was given the ignored root .env.github-review-fixture file. Its four values are still empty. Run the fixture after the disposable repository and separate App/reviewer credentials are supplied; record its results and confirm PR closure and branch deletion before marking the final checklist item complete. No live GitHub writes, deployment or paid model calls have been performed for this ticket.

### Live validation completed on 2026-09-12

The [bounded live fixture](../github-review-fixture.md) passed against Effect-TS/slopcop-sandbox PR #14. A real review body and two inline comments produced exactly one accepted session input. The production adapter published an inline App reply and reconciled its numeric author, marker, PR and discussion root. See the [successful run and independently verified cleanup](../github-review-live.json).

Live attempts exposed a fixture seed that retained an installation access-error flag and GitHub review comments that omit performed_via_github_app. The seed now explicitly clears the flag. Reconciliation now verifies the authenticated App's numeric ID and resolves its exact bot account to a numeric user ID when that metadata is absent. A controlled regression rejects a mismatched App and an impostor bot. Both follow-up reviewers reported zero remaining findings.

The fixture accepts PEM text in either private-key variable and reports unreadable paths without echoing their values. PRs #12 and #13 from the earlier attempts were also closed without merging and their branches deleted; independent API reads verified cleanup for all three attempts. Evidence: [attempt 1](../github-review-live-attempt1.json), [attempt 2](../github-review-live-attempt2.json).

This is live GitHub REST evidence with local durable admission and a runner stand-in. Verified webhook intake and native branch publication remain covered by their separate controlled integration suites. No deployed callbacks, account-link callbacks or paid model behavior are claimed.

Final validation: root `vp test` passed 600 tests across 108 files, with the opt-in live fixture skipped; the separately enabled live fixture passed. Root `vp check --fix` passed with zero errors and 457 warnings. The native runner results above remain applicable; no runner code changed during this follow-up.
