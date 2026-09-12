# Decide session state ownership and recovery

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03

## Question

Which component owns each durable fact about a session, and how does work survive duplicate delivery, disconnection, restart, and partial failure?

Define the identities and relationships of the home thread, session, repository, harness conversation, pending inputs, active turn, and linked PR. Decide input ordering and deduplication, persistence checkpoints, restart recovery, outbound-effect reconciliation, and treatment of failures visible to users. Distinguish turn completion from session lifetime. Use harness facilities where verified, and decide Janitor's responsibilities at their boundary. Cover current-state and token-usage derivation without introducing deferred session-control commands or a detailed execution-log product.

Account for the measured interrupted-turn behavior in [Verify the Workerd Effect SDK under Janitor's dependencies](10-workerd-effect-probe.md). Decide whether to adopt the harness's resumed-turn input delivery and what Janitor must guarantee about wakeup and interrupted external effects. Do not assume local restart results establish production liveness.

## Comments

### First discussion round, awaiting answers

Carry forward the accepted hosting responsibilities. Janitor owns team/platform associations and delivery; the session runner owns the conversation and harness inbox. Janitor's dashboard derives execution state and usage from runner events rather than becoming a competing conversation store. Exact identifiers, acknowledgment checkpoints, deduplication, and projection cursors will be specified after checking the available APIs.

Two behavioral decisions are ready for discussion:

1. Adopt the measured OpenCode recovery semantics: after interruption, the oldest queued input may join the resumed turn, with remaining inputs retaining FIFO order. Recommend adopting this behavior instead of adding a Janitor-specific rule that first completes the interrupted turn in isolation.
2. If an external operation may have completed but its response was lost, reconcile its result before retrying. If the result cannot be established, stop the affected operation and dependent work, retain queued inputs, and explain the uncertainty in the home thread. Recommend this behavior instead of blindly repeating a potentially completed write. Safe recovery should proceed automatically; this does not introduce an approval workflow or a new resume command.

The user's existing requirement that work continue without repeated prompts remains a requirement, not a new question. The selected wakeup/supervision mechanism and its evidence must support it.

### Accepted recovery behavior

The user asked what recovery meant. We clarified the concrete case of a runner process stopping during work, then restarting from the saved conversation and queued inputs, and the separate case where an external write may have succeeded before its response was lost.

The user accepted preserving OpenCode's behavior and the recommendation to reconcile uncertain external effects before retrying: "Yes, I think we should preserve the behavior of open code. And we can go with your recommendation for the second question."

### Admission and replay source evidence

Read-only inspection of pinned OpenCode source at `2df00955cb933e977427535d2505e50cbc689c69` found:

- `packages/core/src/session/session.ts:139` reconciles a caller-supplied message ID before preparing a new admission. `session/inbox.ts:157` returns an existing matching session/type admission, retaining the original payload. `session/inbox.ts:113` also recognizes IDs after promotion out of the inbox. Conflicting session/type identity fails. A duplicate may still wake execution.
- `session/inbox.ts:175` admits through the event bus. `packages/core/src/bus.ts:317` and `:398` transactionally persist the event, projection, and sequence update. The Workerd SQLite adapter waits for the storage transaction. `session/session.ts:168` wakes after admission. A failed response can therefore follow durable admission; retries must retain identity.
- Upstream `packages/core/test/session-owned.test.ts:226` and `:275` cover persistence-before-wake, changed retry payloads, and promoted message retries. These tests were inspected, not rerun. The local probe did not explicitly exercise duplicate admission.
- `packages/core/src/bus.ts:764` replays durable events with sequence greater than `after`; `:828` subscribes before replay and emits `log.synced` before following new events. Sequence gaps are possible, and `log.synced` is a synchronization marker.
- Janitor's existing `apps/cluster/src/GitHub/WebhookJournal.ts:109` stores delivery identity and projection work in one transaction. `Ingress/GitHubWebhook.ts:229` accepts only after recording. This is a precedent for ingress durability, not an atomic transaction with the future runner.

### Proposed ownership and delivery contract, awaiting discussion

Janitor assigns a stable agent-session identity and owns its home-thread, connected-repository, and linked-PR associations. The runner owns the corresponding OpenCode conversation, harness inbox, active execution, and canonical execution/usage events. Janitor's dashboard is a replayable projection of those events. A completed turn leaves the session available for later ordinary authorized messages.

For each authorized source input, Janitor durably records the source identity, author, original payload, and destination session before acknowledging acceptance. It retains an outbound delivery record until the runner confirms admission. Forwarding retries use the same runner message ID and original payload. Platform delivery duplicates are not new instructions; separate messages with identical text remain separate instructions. The runner admission receipt is not a completion receipt.

Propose one durable acceptance order per session across Slack and authorized GitHub review inputs. Dispatch in that order, resolving uncertain admission of an earlier input before allowing a later one to overtake it. Order by Janitor's durable acceptance, not potentially delayed platform timestamps. OpenCode then owns conversational queue behavior. Janitor's delivery backlog is an inter-service handoff record, not a second agent inbox.

Advance a dashboard consumer's durable cursor together with its projection update, making replay harmless. Usage means reported harness usage, not inferred billing for interrupted provider requests. On restart or a failed wake after admission, durable supervision must discover pending work and retry wakeup without needing a teammate message; the mechanism and production behavior remain verification requirements.

### User decision on ownership and delivery

The user accepted the proposed single per-session durable acceptance order across Slack messages and authorized GitHub feedback: "yes". This completes the discussed ownership and delivery contract alongside the accepted OpenCode recovery behavior and uncertain-effect reconciliation.

## Answer

### Ownership and identity

Janitor owns a stable agent-session identity, its one home-thread association, connected-repository identity, linked-PR associations, and the mapping to one OpenCode conversation in the session's runner DO. These associations survive process restarts. Creating or delivering to an existing session must not accidentally create another conversation. PR routing/cardinality and repository access rules are specified by the repository and platform tickets.

The runner owns the canonical conversation, harness inbox, execution state, durable execution events, and reported usage. The external execution environment owns workspace files and operation results. Janitor owns delivery records and rebuildable dashboard projections, not a second conversation or agent scheduler. Session and conversation identities remain stable across turns and host recreation; a turn completing does not close the session. Ordinary authorized messages can start later work without a resume command.

### Admission, ordering, and retries

For each authorized source input, Janitor durably stores its source identity, author, original payload, target session, stable runner message ID, and position in the session's acceptance order. Save that record and its outbound delivery intent together before reporting durable acceptance. Platform transport acknowledgment details belong to the platform ticket; acknowledgment is not a claim that execution finished.

One acceptance order covers Slack and authorized GitHub feedback. Use Janitor's durable acceptance order, not platform timestamps. Forward in that order; resolve uncertain admission of an earlier input before allowing a later input to overtake it. This head-of-line delay is intentional. A terminal admission failure must be recorded and reported, not silently treated as success; handling that rejected input in platform output is part of the delivery contract.

Duplicate delivery of the same source event maps to the same input. Distinct messages with identical text remain distinct inputs. Retry runner admission with the same message ID and original payload. OpenCode owns deduplication at admission and conversational queuing after admission. Its source recognizes caller IDs even after promotion from the inbox and keeps the first admitted payload. A changed retry payload is not an edit mechanism. Platform edits and review-event grouping must receive explicit treatment in the platform contract.

Janitor retains its outbound delivery intent until runner admission is confirmed. There is no atomic transaction spanning Janitor and the runner. If the runner saved the input but its reply was lost, retrying the same ID reconciles the handoff. A runner admission receipt confirms durable input, not turn completion, and a wake failure after saving input does not justify a new message ID.

### Recovery and unattended progress

Adopt OpenCode's observed restart behavior. The oldest queued input may join the resumed turn before the interrupted turn produces a final answer; remaining inputs retain FIFO order. Do not reconstruct a separate Janitor turn queue to force the old turn to finish first.

Janitor supervises delivery until admission. The runner is responsible for durable wakeup and progress after admission. Pending or interrupted work must be discoverable from durable state and retried without another teammate message. A detached fiber, an in-memory flag, or a provider stream alone does not meet this contract. The runner must retain or rearm a durable wake obligation while recoverable work exists and reconcile it against harness state after activation.

The concrete unattended-execution and wakeup arrangement must pass [Verify unattended progress and recovery of the session runner](11-runner-lifecycle-verification.md), including the crash window between admission and wake. Durable Object alarms are an available mechanism to evaluate with the existing durable scheduling facilities; this answer specifies responsibility and invariants, not an experimentally verified liveness mechanism. [Choose durable runner supervision and wakeup](13-runner-supervision.md) resolves that now-explicit mechanism choice before verification and spec readiness.

### External effects and failures

Track externally mutating operations by stable operation identity and retain enough intent/result information to reconcile retries. If an operation may have completed but its response was lost, query or reconcile the external result before repeating it. Use idempotency support where available. Do not claim exactly-once external execution from input deduplication or event replay.

When the result cannot be established, stop the affected operation and dependent work, retain queued inputs, and explain the uncertainty in the home thread. Safe recovery proceeds automatically. If human context is necessary, ask for it through the ordinary conversation. This adds neither a blanket approval workflow nor stop/resume commands. Repository-specific reconciliation belongs in the repository execution contract; chat/GitHub publication reconciliation belongs in the platform delivery contract. Both must honor this rule.

Retain recoverable work through transient delivery and process failures. Report terminal or unresolved failures visibly rather than presenting the session as completed. Derive running, completed, and failed outcomes from harness events plus delivery/reconciliation state; absence of a live process does not imply success. Exact UI labels and output grouping belong to the observation and platform tickets.

### Event replay and usage

Maintain a separate durable event cursor per session and consumer. Apply an event's projection change and advance that consumer's cursor atomically in Janitor storage. Replay uses the runner's exclusive durable sequence cursor; tolerate gaps and treat `log.synced` as a synchronization marker. Replayed events must not double-count usage or duplicate outbound publication intents. Outbound publication intents require their own durable delivery/reconciliation records.

The dashboard is a projection that can be rebuilt from retained runner facts. Token totals reflect usage actually reported by the harness; do not infer or bill missing usage from interrupted provider requests. Period totals and concrete projection schemas are specified in the observation ticket. Detailed execution-log retention/viewing remains deferred; that does not authorize discarding records required for pending recovery or delivery.

### Verification and follow-through

The source evidence above establishes the intended deduplication and replay APIs; only the narrower local cases recorded in the probe were executed. Add explicit duplicate-admission tests before/after promotion, lost-admission-response tests, creation identity checks, interrupted projection updates, and recovery without new input to the lifecycle verification. External-operation reconciliation remains a required remote-execution check.

The hosting direction is unchanged. Any failure to meet these invariants must be resolved before the implementation-ready spec is accepted.
