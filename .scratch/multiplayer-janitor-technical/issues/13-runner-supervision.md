# Choose durable runner supervision and wakeup

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03, 04

## Question

Which concrete mechanism keeps admitted OpenCode work progressing and wakes interrupted sessions without another teammate message?

Use the accepted runner ownership and recovery invariants. Compare a runner-owned Durable Object alarm and execution lifecycle with supervision through existing Janitor durable workflow facilities. Determine who arms and rearms wakeups, what durable state distinguishes pending work from intentional waiting or failure, how wake and admission races are reconciled, how stalled execution is detected, and when retries stop and a visible failure is reported. Avoid a second agent conversation scheduler. Verify platform and harness capabilities from primary evidence before presenting mechanism choices.

Specify the arrangement and meaningful timing/retry policy to test in [Verify unattended progress and recovery of the session runner](11-runner-lifecycle-verification.md). The earlier local probe did not establish unattended liveness. Do not authorize live deployment or spending as part of this decision.

## Comments

### First discussion round, awaiting the user's decision

Recommend keeping supervision inside the separate runner Worker, using each session DO's durable alarm. Janitor's existing delivery facilities remain responsible for getting inputs durably admitted. Once admitted, the runner owns the wake obligation, native execution lifecycle and recovery. The alternative is a Janitor workflow that repeatedly calls the runner and tracks its supervision lifecycle across the service boundary. That can reuse existing infrastructure but introduces another durable owner and coordination protocol after admission.

The proposed alarm handler would reconcile saved work, invoke or join native OpenCode execution, and retain a future wake obligation while recoverable work remains. Healthy work must continue across supervision intervals without restarting its turn. Idle, intentional waiting and terminal failure must not be interpreted as reasons to run the model again. Exact execution intervals, stall detection and retry policy follow the ownership choice; they are not yet accepted.

Primary platform documentation checked on 2026-09-11 establishes the constraints:

- [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) provides one alarm per DO, at-least-once delivery, one alarm handler at a time and six automatic retries. Application-owned wake obligations must be explicitly rearmed; retries are not an indefinite progress guarantee.
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) says ordinary outbound fetch streams do not independently prevent eviction. Persist recovery state incrementally.
- [Durable Object state](https://developers.cloudflare.com/durable-objects/api/state/) says `waitUntil` does not extend DO lifetime.
- [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/) gives alarm handlers a 15-minute wall-time limit. Supervision must return and rearm within that limit; a session or agent turn need not end when an alarm invocation ends.

This is a planning proposal. The selected lifecycle still needs the existing unattended-progress verification before spec readiness. No resources were deployed for this discussion.

### Pinned harness and existing infrastructure evidence

Read-only inspection used OpenCode revision `2df00955cb933e977427535d2505e50cbc689c69` under `/tmp/janitor-workerd-probe/tools/workerd-probe/vendor/`:

- `packages/core/src/session/execution.ts:20`: `wake` returns after registering work; `resume` starts or joins execution and waits; `awaitIdle` waits without starting. Active ownership is process-local and includes cleanup.
- `packages/core/src/session/run-coordinator.ts:72`: the host-scoped coordinator coalesces wakeups and handles admission racing with settlement. Awaiting wake is not awaiting completion.
- `packages/core/src/session/execution.ts:79`: a durable execution claim survives shutdown interruption; normal settlement releases it.
- `packages/sdk/src/internal/host.ts:49`: runtime creation automatically forks native suspended-session recovery.
- `packages/core/src/session/execution/restart.ts:33`: recovery uses durable per-turn accounting, terminalizing after ten automatic resumptions. It assumes the old execution owner is dead. A supervisor must preserve this accounting and fence/stop predecessors before replacing a runtime.
- `packages/core/src/database/sqlite.workerd.ts:39`: the injected storage contract exposes SQLite and transactions. No alarm API calls were found in SDK/core/server, so the proposed supervisor does not compete with a native SDK alarm owner.

Janitor's `apps/cluster/src/WorkflowDispatcher.ts:100` marks submission accepted when workflow submission succeeds. `WorkflowOutboxCron.ts` and `Worker.ts` provide minute-based repair of missed submissions. They do not supervise admitted OpenCode work. Using them for that purpose would require a new workflow protocol for progress inspection, fencing, repeated wakes and terminal classification.

### Accepted supervision owner

After an ASCII walkthrough explaining an alarm as a persisted future check-in, the user accepted runner-owned DO alarm supervision: "Yeah, I guess that's fine." The alarm continues checking healthy execution, recovers interrupted work through the harness and stops execution checks when the session is idle or intentionally waiting. It does not send another prompt or restart healthy work. Timing, stall detection and retry details remain under discussion.

### Proposed timing and failure behavior, awaiting answers

1. Schedule checks approximately every 30 seconds while runnable work exists. Wake promptly on input; this interval is a recovery/check-in target, not a delay before beginning work or a precise platform delivery guarantee. Each handler is bounded and rearms before returning. It must leave healthy host-scoped execution running.
2. Preserve native per-turn recovery accounting, including its ten-resumption limit. Routine alarm checks do not spend recovery attempts. Surface exhausted recovery in the home thread and retain saved work and queued inputs. Never force-start a terminal failed turn to bypass native accounting.
3. Detect stalls at the operation level. Propose a five-minute model-response inactivity deadline covering the first response and subsequent stream activity. Keep native command timeout behavior with its two-minute default and permit explicit longer finite command timeouts. Disallow an unlimited command timeout in the MVP. Quiet command output and a long overall turn are not themselves failures. Native provider retries remain distinct from process-restart recovery; do not add a blanket whole-turn retry loop.

Further pinned source inspection found that the native shell permits `timeout: 0`, disabling its deadline, and HTTP model execution has no universal default inactivity deadline. Preserving all defaults would therefore leave some stalls unbounded. The proposal above intentionally supplies those missing bounds, subject to the user's decision and the lifecycle verification.

### Accepted defaults

The user accepted all three timing and failure recommendations: "Those defaults are fine with me." This completes the supervision decision. The answer below records the accepted behavior and the implementation invariants required to preserve it.

## Answer

### Ownership and execution lifetime

The separate runner Worker owns supervision through the single durable alarm on each session DO. Janitor's existing outbox and workflow facilities remain responsible for delivery until durable runner admission. They do not poll admitted agent work or schedule conversational turns. OpenCode retains its conversation queue, run coordinator, provider retries and restart recovery.

Schedule a check approximately every 30 seconds while runnable or interrupted work exists, starting work promptly on admission. An alarm is a persisted check-in, not an agent prompt. It is neither a precise timing guarantee nor a 30-second execution limit.

Each alarm invocation performs bounded inspection and scheduling, leaving healthy execution in the host-scoped native coordinator. Do not await the whole agent turn in the alarm handler or dispose its runtime when the handler returns. Do not cancel a native execution fiber merely because a supervision interval ends. Rearm before performing fallible asynchronous inspection so a crash does not depend solely on Cloudflare's finite automatic alarm retries. A duplicate alarm is harmless after re-reading durable state.

This arrangement must demonstrate continuous execution after the admission request and alarm handlers return. Neither `waitUntil`, a detached fiber nor an outgoing model stream independently proves that property. If the deployed lifecycle test cannot establish it, reopen this decision rather than silently moving the loop or imposing turn-length limits.

### Durable state and admission races

Keep supervisor records in `_janitor_*` tables, alongside the harness-owned data. Record the repository/session generation, a monotonic supervision revision, the wake obligation and next due time, and any recovery blocker or terminal supervisor error. Native inbox entries, execution claims, retry events and terminal events remain authoritative for agent work. Do not maintain a competing conversation queue or treat a persisted "running" flag as proof of a live process.

Before SDK admission can start work, persist a wake obligation and arm the alarm. This deliberately permits an extra alarm if admission fails. Confirm admission only after the SDK has durably accepted the stable input identity and the wake obligation is established. A crash before admission is retried by Janitor's existing delivery record; a crash after admission is discoverable by the alarm. Retried admission keeps the original ID and payload.

Serialize short supervisor mutations, never the entire turn. Every admission advances the supervision revision. Before clearing or postponing a wake obligation, reconcile native state and recheck that revision in the serialized mutation. If admission raced with inspection, repeat inspection or retain the earlier wake. An idle check must not delete an alarm armed for a newer message. Constructor initialization must preserve an already scheduled alarm rather than overwrite its imminent firing.

### What a check does

| Observed state                                                                  | Supervisor behavior                                                                                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native execution is locally active, including cleanup                           | Leave it running and retain the next check. A quiet stream or command alone does not imply process failure.                                                                       |
| Admitted input is pending and no execution or recovery blocker owns the session | Request native wake. Let the native coordinator coalesce duplicate wakes and handle admission racing with settlement.                                                             |
| An orphaned durable execution claim exists                                      | Establish that the previous owner is gone, reconcile external operations, then use native suspended-session recovery. Serialize recovery sweeps; they are not routine heartbeats. |
| Native provider retry is waiting for its due time                               | Respect the native retry schedule. An alarm must not bypass its delay or count waiting as a stall.                                                                                |
| Agent is idle or intentionally waiting for human input                          | Clear execution checks after the revision/state recheck. An ordinary later input arms supervision again.                                                                          |
| Uncertain external effect prevents safe continuation                            | Preserve work and inputs, stop dependent execution and report the concrete blocker using the previously accepted reconciliation contract.                                         |
| Execution has terminally failed, including exhausted recovery                   | Report failure and do not force-start that failed turn. Preserve saved work and queued inputs; later work follows native semantics and existing blocker rules.                    |
| Repository/session has been disconnected                                        | Apply the accepted generation fence and cleanup contract; stale alarms and completions cannot restart the session.                                                                |

SDK host creation starts recovery asynchronously. On activation, establish generation validity and external-operation recovery gates before any recovered tool can mutate the workspace or publish. Never construct a replacement runtime while its predecessor can still act. Reuse the remote operation identities, bridge fencing and checkpoint reconciliation already verified in [Verify the remote repository execution contract](12-remote-execution-verification.md).

### Deadlines, retries and visible outcomes

Use a five-minute inactivity deadline for each model request, covering the wait for the first response and gaps during the response stream. Track provider-response activity at the transport, not Slack output or supervisor heartbeats. Stop that timer when the provider exchange ends; time spent awaiting an independently running tool is not provider inactivity. Apply the deadline to native HTTP as well as other supported transports; optional legacy SDK settings do not establish a native HTTP default.

Foreground commands retain the native two-minute default. Explicit longer finite timeouts are allowed. Reject zero, non-finite or otherwise unlimited timeouts before dispatch. Native timeout/cancellation handling must stop command descendants before checkpointing, as required by the remote execution contract. There is no whole-turn deadline and no output-silence deadline for commands.

Surface operation timeouts through normal native error/result handling. A command timeout can be a tool result the agent addresses; it is not automatically a failed session. Model failures use native retry classification and scheduling. The pinned model retry implementation uses four scheduled retries with jittered exponential delay starting at two seconds, and caps provider Retry-After at fifteen minutes. Supervision must preserve those waits and must not wrap them in an additional whole-turn retry loop.

Keep the native durable allowance of ten automatic resumptions per interrupted turn. Native recovery increments before resuming; after ten resumptions, its next recovery check terminalizes the turn. Ordinary alarm checks do not increment this counter, and host recreation must not reset it. A terminal failure creates the existing durable error/output projection for delivery to the home thread. Delivery failures remain separate from execution state; a failed Slack send must not rerun agent work.

Temporary supervision or storage-service errors retain the wake obligation and retry inspection. They do not by themselves authorize replaying external effects or force-starting failed turns. Expose a recovery/delivery problem rather than claiming completion. Terminal configuration failures are reported as failures. If storage itself is unavailable, saving/rearming cannot be guaranteed at that instant; record that limitation in the deployed failure tests instead of claiming immunity to arbitrary platform outages.

### Source details and verification handoff

Additional source inspection at the pinned revision establishes these defaults:

- `packages/core/src/tool/plugin/shell.ts:22` and `:52` define the 120-second default and unlimited zero value. `packages/core/src/shell.ts:379` enforces timeout and a three-second force-kill grace.
- `packages/core/src/session/model-transport.ts:23` defines a ten-second WebSocket connection timeout and five-minute frame inactivity timeout. `packages/ai/src/route/executor.ts:225` does not establish a universal native HTTP deadline.
- `packages/core/src/session/runner/step.ts:102` keeps provider streaming and tool completion distinct.
- `packages/core/src/session/runner/retry.ts:64` defines bounded provider retry delays and emits `RetryScheduled` with the intended due time.
- `packages/core/src/session/execution/restart.ts:75` counts recovery durably before execution; `:191` skips locally active sessions during its sweep.

[Verify unattended progress and recovery of the session runner](11-runner-lifecycle-verification.md) now has a concrete design to test. This decision resolves the mechanism and defaults, not deployed feasibility. It authorizes no live deployment or spending.
