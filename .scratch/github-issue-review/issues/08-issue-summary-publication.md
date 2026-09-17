# 08: Publish and maintain the issue summary

**What to build:** A publishing-mode review writes one agent-authored summary comment on its issue and updates that comment on subsequent authorized runs. Uncertain sends recover without repeating investigation.

**Blocked by:** 06: Complete an evidence-based review in dry-run.

**Status:** ready-for-agent

**Design context:** Use the confirmed GitHub-invoked issue review specification and backend design, the domain glossary, and ADR 0007, 0010 as refined by 0012. This ticket is one slice of the approved design; production review enablement waits for ticket 13.

- [ ] Persist intended agent-authored text and publication identity before writing. The agent Entity requests durable publication actions; individual Activities own their idempotency and report results back to persisted agent state.
- [ ] Maintain a durable summary identity per issue and update it rather than creating a comment for every run. Each claim names the actual investigated commit and accurately states evidence and uncertainty.
- [ ] Trusted output checks prevent mentions and frontend links, verify links against permitted evidence, and enforce bounded length. Use no application-owned prose template; invalid output cannot be published verbatim.
- [ ] Each actual write attempt obtains fresh author permission and checks unchanged source invocation, open issue, connection, pause, access, review enablement, cancellation, and publication mode under per-issue serialization.
- [ ] Dry-run blocks automatic publication, including when enabled during investigation. Disabling it never publishes old results automatically. No Slack output, label writes, or labeling inputs are introduced.
- [ ] Use repository-scoped, least-privilege credentials outside the sandbox and expose only the permitted comment operation to publication code.
- [ ] Reconcile lost responses against GitHub before retrying. An unresolved outcome stops further writes and appears in frontend history; completed writes remain after cancellation or later failure.
- [ ] Verify first publication, subsequent update, ambiguous creation/update outcomes, output rejection, permission revocation, edit/deletion, closure, and dry-run/control changes racing publication.
