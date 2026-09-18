# 09: Publish the first draft reproduction PR

**What to build:** A confirmed bug reproduction becomes a Janitor-owned branch and linked draft PR in the original repository, with the failing test and no fix. The issue summary links the resulting PR and accurately reports partial or unresolved publication.

**Blocked by:** 07: Produce validated bug reproductions in dry-run; 08: Publish and maintain the issue summary.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0008, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [x] Persist the validated patch, test evidence, agent-authored PR content, exact base, and intended branch/PR writes before the first remote mutation.
- [x] Publish through separate durable branch and draft-PR actions, each with Activity-level reconciliation and fresh authorization/control checks inside every actual write attempt.
- [x] Use stable publication identity and recorded ownership. A branch name alone does not establish ownership; refuse collisions with unowned branches or unrelated PRs.
- [x] Enforce selected repository, test-only patch scope, owned branches, and draft-only creation in trusted application code outside the model. Never write labels, fix code, merge, or mark ready.
- [x] Publish against the tested commit even if the default branch moves. Preserve the existing default-branch identity and never silently rebase an untested patch.
- [x] Apply duplicate-suppression evidence rules before opening a PR. Questions, enhancements, unclear results, and unconfirmed reproductions never produce one.
- [x] Validate agent-authored PR text with the same output restrictions as summaries. Update the issue summary with the actual GitHub PR link.
- [x] Reconcile each uncertain branch or PR outcome before retrying; unresolved state blocks later writes. Preserve partial results and orphan-branch identity without destructive rollback or repeated model work.
- [x] No reviewed CI contract or downstream CI audit gates publication. Repository administrators own CI safety and invokers own their instructions.
- [x] Verify one draft PR from a validated reproduction, ownership collision, failure between push and PR creation, lost responses, default-branch advancement, and revocation/cancellation between writes.

## Comments

Implemented separate durable branch and draft-PR actions. Each write checks current invocation authority and repository controls. Validated tests remain based on the recorded commit, with branch and PR ownership retained independently of detailed run history. Lost responses reconcile without another model call; uncertain outcomes fence later writes and preserve partial publication. Agent-authored summary variants report the actual PR URL or incomplete publication. Production enablement remains gated by ticket 13.

## Standards

No outstanding documented-standard or code-smell findings.

## Spec

No outstanding findings against ticket 09. Safe PR reuse and explicit frontend publication remain in tickets 10 and 11.

Review totals: 0 Standards findings, 0 Spec findings.

Validation: `vp check` passed. The full suite passed, 738 tests across 125 files. The final scoped-credential adjustment passed all 66 focused publication and adapter tests. GitHub publication was exercised through the test transport; no live repository was published to or enabled.
