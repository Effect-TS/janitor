# 13: Verify and enable the complete production workflow

**What to build:** Make the completed review feature eligible for production configuration only after the synchronization migration and all review slices satisfy the confirmed design. This ticket prepares enablement; it does not itself authorize deployment or repository opt-in.

**Blocked by:** 04: Complete the synchronization-as-cache migration; 11: Publish saved dry-run results from the frontend; 12: Expire detailed history without losing publication ownership.

**Status:** ready-for-agent

**Completion:** complete. Reconciled on 2026-09-18. See [completion review](../completion-review.md).

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006–0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Keep production issue review gated until the synchronization-as-cache migration and complete review path are present; remove temporary development-only limitations without bypassing per-repository opt-in.
- [x] Verify an authorized free-form mention through admission, persistent agent Entity, embedded LLM actions, executable reproduction, draft PR, and single summary; verify a dry-run through explicit frontend publication.
- [x] Exercise per-issue ordering, cross-issue concurrency, replay, permission revocation, edited/deleted invocations, issue closure, repository controls, and cancellation while an action is pending.
- [x] Verify runner restart with a usable sandbox resumes persisted actions without repeating completed LLM calls, whereas loss of unfinished workspace interrupts and requires a new invocation. The original deadline survives both cases.
- [x] Exercise uncertain branch/PR/comment writes, partial publication, human edits, retention expiry, and publication retries without new model work.
- [x] Demonstrate direct GitHub automation during cache failure for labeling and review, and usable Slack repository access without synchronization readiness.
- [x] Verify credential-free sandboxes, permitted patches, output validation, agent-authored prose, no frontend references in GitHub output, no Slack review integration, and no labeling integration.
- [x] Use the repository's required checks and focused integration scenarios. Document environment-dependent checks and any deployment smoke test still required; do not report unavailable checks as passed.
- [x] Update operator-facing documentation for opt-in, dry-run, explicit publication, cancellation, retention, and known check/write races. Deployment and live repository enablement remain separate authorized actions.

## Comments

Implemented 2026-09-18. Production configuration now uses `JANITOR_ISSUE_REVIEW_ENABLED`, defaulting to false; the temporary development flag is retired. Repository opt-in remains separate. Added complete model-directed reproduction/publication scenarios during cache failure for automatic and explicitly published dry-run results, and strengthened restart coverage to resume a pending action while preserving the original deadline. Existing integration suites exercise the remaining acceptance scenarios.

Operator instructions and the acceptance coverage map are in [the operator guide](../../../docs/issue-review.md) and [the verification record](../../../docs/issue-review-verification.md). The record distinguishes controlled external services, real local execution, and live smoke tests still required. No deployment plan, deployment, or live repository opt-in was performed.

Validation: `vp install` succeeded; `vp check --fix` passed with 0 errors and 347 existing warnings; `vp test` passed 790 tests across 125 files. The post-review investigation suite passed all 110 tests. Standards review found one use of internal persistence in new assertions, resolved by using public history; no remaining findings. Spec review found no gaps.

2026-09-18 completion review: implementation commit `96a6cd3` and current code/test coverage support completion of this ticket. Earlier comments describe each slice at implementation time; later tickets supersede their temporary limitations. Live deployment verification remains separate, as recorded in [the completion review](../completion-review.md).
