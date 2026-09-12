# 02: Run a durable agent conversation

**What to build:** A trusted service-level acceptance driver starts a persistent agent conversation, submits instructions and reads responses and usage. Work continues without another prompt and recovers after runner restart.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

Source: [Accepted implementation handoff](../spec.md). Implement this slice within its accepted contracts and evidence limits.

- [ ] Build the separate runner with the accepted pinned OpenCode Workerd SDK and isolated Effect dependency graph. Expose authenticated versioned creation, admission, inspection and cursor-based event contracts; creation and native conversation identity are idempotent.
- [ ] Persist immutable input IDs and payloads, ordered handoff records and runner receipts. Workflow submission is not SDK admission; retain unresolved handoff state until native acceptance and prevent later inputs overtaking uncertain earlier ones.
- [ ] Persist the wake obligation and arm the alarm before native admission can start work. Implement host-scoped execution, approximately 30-second checks, supervision revision races and pre-host generation/uncertainty/compatibility guards.
- [ ] Recover orphaned claims before normal pending-input wake; preserve native queue behavior, provider retries and ten-resumption limit. Enforce five-minute model inactivity at the transport boundary and never force-start terminally failed work.
- [ ] Use a real configuration-backed native model resolver and runner-only secret references. Persist session model selection; keep structured questions disabled and ordinary conversational questions supported. Controlled model responses are sufficient for this slice; real-provider validation has its own ticket.
- [ ] Read durable events using exclusive cursors and replay-safe cumulative usage. Persist consumer catch-up obligations, including idle transitions, rather than depending only on transient notifications.
- [ ] Demonstrate two queued inputs, duplicate IDs before/after inbox promotion, lost admission responses, restart without another message, ordinary question/answer, and interrupted event reads through the acceptance driver. No repository or platform mutation is required.
