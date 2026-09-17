# 09: Publish the first draft reproduction PR

**What to build:** A confirmed bug reproduction becomes a Janitor-owned branch and linked draft PR in the original repository, with the failing test and no fix. The issue summary links the resulting PR and accurately reports partial or unresolved publication.

**Blocked by:** 07: Produce validated bug reproductions in dry-run; 08: Publish and maintain the issue summary.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0008, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Persist the validated patch, test evidence, agent-authored PR content, exact base, and intended branch/PR writes before the first remote mutation.
- [ ] Publish through separate durable branch and draft-PR actions, each with Activity-level reconciliation and fresh authorization/control checks inside every actual write attempt.
- [ ] Use stable publication identity and recorded ownership. A branch name alone does not establish ownership; refuse collisions with unowned branches or unrelated PRs.
- [ ] Enforce selected repository, test-only patch scope, owned branches, and draft-only creation in trusted application code outside the model. Never write labels, fix code, merge, or mark ready.
- [ ] Publish against the tested commit even if the default branch moves. Preserve the existing default-branch identity and never silently rebase an untested patch.
- [ ] Apply duplicate-suppression evidence rules before opening a PR. Questions, enhancements, unclear results, and unconfirmed reproductions never produce one.
- [ ] Validate agent-authored PR text with the same output restrictions as summaries. Update the issue summary with the actual GitHub PR link.
- [ ] Reconcile each uncertain branch or PR outcome before retrying; unresolved state blocks later writes. Preserve partial results and orphan-branch identity without destructive rollback or repeated model work.
- [ ] No reviewed CI contract or downstream CI audit gates publication. Repository administrators own CI safety and invokers own their instructions.
- [ ] Verify one draft PR from a validated reproduction, ownership collision, failure between push and PR creation, lost responses, default-branch advancement, and revocation/cancellation between writes.
