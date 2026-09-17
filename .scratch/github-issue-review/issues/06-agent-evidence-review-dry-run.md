# 06: Complete an evidence-based review in dry-run

**What to build:** An admitted review agent investigates current repository evidence and produces a completed frontend result for unclear issues, questions, and enhancements. Bug reports receive an evidence assessment without claiming executable reproduction until ticket 07.

**Blocked by:** 05: Admit authorized invocations and expose the review queue.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0007, 0009, 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] The persistent agent Entity processes messages and owns conversation, decisions, and run state. Invoke the LLM through embedded action workflows with stable identities and persisted results; apply duplicate action completions only once.
- [ ] Reuse the deployment's agent-model configuration independently of labeling. Only the current invocation supplies instructions; prior conversations and results, quoted/reference material, repository contents, and tool output remain evidence.
- [ ] Acquire issue/comment/PR evidence directly from GitHub and provision the recorded actual default-branch commit into an isolated sandbox without credentials. Provisioning never executes repository hooks or scripts outside the sandbox.
- [ ] Model calls and all GitHub credentials stay outside the sandbox. Use typed repository operations and sandbox inspection tools; no generic publication capability is exposed to the model.
- [ ] Classify bug/enhancement/question/unclear, search open and closed issues/PRs in the same repository, and retain evidence links. Answer questions from code/docs; assess enhancement support and gaps; unclear reports explain missing information and stop.
- [ ] Record a single 15-minute deadline covering active investigation and subsequent installation/testing. Respect provider rate limits within remaining time; impose no model-call, daily spending, or feature-specific API quota.
- [ ] Refresh authority before execution and detect invalidation during work. Cancellation messages remain processable while an action is pending; stop further actions after cancellation or expiry.
- [ ] After runner restart, restore persisted agent state and resume pending actions if the sandbox remains usable, reusing completed LLM results. Loss of unfinished sandbox work marks the run interrupted and requires a new invocation; recovery never resets the deadline.
- [ ] Frontend history exposes invoker, instructions, commit, status, findings, uncertainty, and available evidence. Dry-run makes no GitHub writes and has no Slack integration.
- [ ] Verify an actual admitted invocation through agent/action execution to persisted frontend findings, with restart, cancellation, hostile evidence, and rate-limit cases.
