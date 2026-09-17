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
