# 05: Admit authorized invocations and expose the review queue

**What to build:** A teammate opts a repository into review, posts an authorized mention, and sees exactly one queued review run in the frontend. Each run has a persistent agent Entity; a separate per-issue scheduler coordinates its messages, queue, and publications. Keep review behind the development gate until ticket 13.

**Blocked by:** 01: Separate repository eligibility from synchronization.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0007, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Persist per-repository review enablement and dry-run settings using existing Cloudflare Access plus active Janitor membership authorization; no new human repository-admin restriction for settings.
- [ ] Admit only newly created comments on open issues with an actual @effect-janitor mention outside quotes, code, and link destinations. Accept free-form instructions without command keywords; exclude PR comments, issue bodies, ordinary replies, edits, and bot/App identities.
- [ ] Query GitHub for the current issue/comment/repository and human effective write or admin permission, including custom roles with that base permission. Match stable identities and deny on failed checks.
- [ ] Persist the immutable invocation and a receipt keyed by repository/comment before scheduling. Delivery replay cannot create another run; separately posted identical comments remain distinct.
- [ ] Fence delayed comments from disabled, paused, or disconnected periods so restoring eligibility never admits stale work. Edited or deleted invocations cannot be used as replacement instructions.
- [ ] Create one agent Entity per run with explicitly persisted state and messages. The Entity owns its lifecycle; embedded workflows implement actions rather than representing the entire agent.
- [ ] Serialize runs per issue while allowing different issues to run concurrently without feature-specific repository queue or concurrency caps. Expose invoker, instructions, queue position/status, and terminal cancellation reasons in frontend history.
- [ ] Provide Cancel run to linked frontend users with current effective write/admin permission. Edits/deletion, issue closure, and repository pause/disconnect/access loss/review disablement invalidate the appropriate active and queued work; restoration never revives it.
- [ ] Verify replay, quoted/forged/bot invocations, permission failures, queue ordering, cross-issue concurrency, actor state restoration, and cancellation without invoking a model or making GitHub writes.

## Comments

2026-09-17: Implemented on this branch. Migration `0043_issue_review.sql` adds the settings, receipt, run, message and per-issue scheduling tables and the eligibility fence trigger. `packages/domain/src/Review/Mention.ts` decides direct mentions outside quotes, code, link destinations and HTML comments. `apps/cluster/src/Review/` holds the store, the GitHub authority checks (`Authority.ts`: repository identity, open issue, unchanged human comment, effective write or admin permission including custom roles), admission (`Admission.ts`: receipt inside the projection fence, then the `Janitor/AdmitReviewV1` outbox workflow), the `ReviewAgent` cluster Entity with Start and Cancel messages applied once by message identity (`Agent.ts`), the per-issue scheduler (`Scheduler.ts`), settings (`Settings.ts`) and frontend cancellation with a fresh GitHub permission check on the teammate's linked account (`Control.ts`). Routes live in `Ingress/Review.ts`; the web app gains an Issue review settings card and a Reviews section with Cancel run. The deployment gate is `IssueReviewAvailable`, on under `alchemy dev` or `JANITOR_ISSUE_REVIEW_DEVELOPMENT=true`.

Scope notes for later tickets: the scheduler starts the head run at once, so a single invocation shows as `running` (queue position 1) with its 15-minute deadline recorded; the investigation itself, the pre-execution authority recheck, and the `Finish` transition belong to ticket 06. Start rechecks repository eligibility and the accepted generation. Cancellation for repository-level changes is a database trigger on the eligibility generation, so it is atomic with the control change; the agent observes it from the run record.
