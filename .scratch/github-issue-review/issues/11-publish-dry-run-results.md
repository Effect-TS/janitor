# 11: Publish saved dry-run results from the frontend

**What to build:** A currently authorized teammate publishes the latest eligible saved dry-run result from the frontend without rerunning the agent, while the repository may remain in dry-run mode.

**Blocked by:** 10: Handle subsequent reproductions without overwriting human work.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0011, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Offer Publish results only for the latest invocation's completed result within 14 days, with no newer active or queued invocation, an unchanged existing source comment, and a run that was not cancelled.
- [ ] Resolve the frontend user's linked GitHub identity and require current effective write/admin permission. Record original invoker and publisher separately; the original invoker may have lost permission.
- [ ] The action authorizes only the selected saved result. Keep repository dry-run enabled if it was enabled; simply disabling dry-run never grants publication authority.
- [ ] Enqueue publication through the existing per-issue scheduler and reuse the same agent-requested action workflows, validation, ownership, and recovery behavior. Do not rerun LLM investigation or silently retest/rebase.
- [ ] Recheck the publisher and all eligibility conditions inside each actual write attempt. Pause, disconnection, unavailable access, disabled review, closure, edited/deleted invocation, or a newer invocation blocks publication.
- [ ] Repeated clicks return or reconcile the same publication, including after a browser disconnect. Expose pending, completed, blocked, partial, and unresolved outcomes in the frontend.
- [ ] Use saved validated text and patch only; GitHub output contains no frontend link, mentions, labels, or Slack notifications.
- [ ] Verify publishing with dry-run on, a different authorized publisher, original-invoker revocation, newer-result races, expiry, duplicate clicks, human-edited PRs, and ambiguous remote writes.
