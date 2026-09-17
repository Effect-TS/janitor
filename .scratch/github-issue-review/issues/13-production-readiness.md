# 13: Verify and enable the complete production workflow

**What to build:** Make the completed review feature eligible for production configuration only after the synchronization migration and all review slices satisfy the confirmed design. This ticket prepares enablement; it does not itself authorize deployment or repository opt-in.

**Blocked by:** 04: Complete the synchronization-as-cache migration; 11: Publish saved dry-run results from the frontend; 12: Expire detailed history without losing publication ownership.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0006–0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Keep production issue review gated until the synchronization-as-cache migration and complete review path are present; remove temporary development-only limitations without bypassing per-repository opt-in.
- [ ] Verify an authorized free-form mention through admission, persistent agent Entity, embedded LLM actions, executable reproduction, draft PR, and single summary; verify a dry-run through explicit frontend publication.
- [ ] Exercise per-issue ordering, cross-issue concurrency, replay, permission revocation, edited/deleted invocations, issue closure, repository controls, and cancellation while an action is pending.
- [ ] Verify runner restart with a usable sandbox resumes persisted actions without repeating completed LLM calls, whereas loss of unfinished workspace interrupts and requires a new invocation. The original deadline survives both cases.
- [ ] Exercise uncertain branch/PR/comment writes, partial publication, human edits, retention expiry, and publication retries without new model work.
- [ ] Demonstrate direct GitHub automation during cache failure for labeling and review, and usable Slack repository access without synchronization readiness.
- [ ] Verify credential-free sandboxes, permitted patches, output validation, agent-authored prose, no frontend references in GitHub output, no Slack review integration, and no labeling integration.
- [ ] Use the repository's required checks and focused integration scenarios. Document environment-dependent checks and any deployment smoke test still required; do not report unavailable checks as passed.
- [ ] Update operator-facing documentation for opt-in, dry-run, explicit publication, cancellation, retention, and known check/write races. Deployment and live repository enablement remain separate authorized actions.
