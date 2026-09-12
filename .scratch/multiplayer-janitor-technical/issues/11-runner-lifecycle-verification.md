# Verify unattended progress and recovery of the session runner

Type: task
Labels: wayfinder:task
Status: resolved
Mode: HITL
Parent: ../map.md
Blocked by: 03, 04, 13, 15

## Question

Verify the lifecycle design selected for the separate OpenCode runner Worker and per-session Durable Object. Does admitted work complete or recover without another teammate message after the admission request ends, a provider stream stalls or disconnects, or the object/process restarts?

Use the pinned runner build and state/recovery contract. Record how durable pending work causes wakeup, how progress is supervised, and what users observe on failure. Distinguish local process recreation from evidence for the deployed arrangement. Check deployment compatibility and bundle/startup constraints as part of making the fixture runnable.

Prepare a concrete bounded fixture and deployment/resource requirements before requesting any needed live access or spending authorization. This ticket does not preauthorize deployment or paid experiments. Use fake model/tool responses where they answer the lifecycle question. Preserve commands, versions, observations, and limitations. A failed result must trigger an explicit change to the design before spec readiness.

Exercise the admission and projection failure cases in [Decide session state ownership and recovery](04-session-durability.md): duplicate creation attempts, caller-ID retries before and after promotion, saved admission with a lost reply or failed wake, preservation of cross-source acceptance order, and interruption between applying a projection event and advancing its cursor. Verify the actual durable wake/supervision mechanism; use [Choose durable runner supervision and wakeup](13-runner-supervision.md) rather than treating a mocked wakeup as proof.

## Selected design and required cases

The supervision decision is resolved. Its answer owns the contract and timing defaults; this ticket verifies them without substituting a different lifecycle.

- End the admission request and return from alarm handlers while healthy native work continues across multiple real alarm intervals. Verify one execution owner, no repeated prompt, no turn cancellation and no dependency on a dashboard connection or further teammate messages. Include work longer than the documented ordinary inactivity window.
- Kill/recreate the DO between wake-obligation persistence, alarm arming, SDK admission and admission response. Include lost admission responses and failed immediate wake. Prove unattended discovery without a new input or manual test-driver wake.
- Race new admission against an idle check deleting its alarm, duplicate alarms against recovery, and turn settlement against pending inputs. Prove the revision check and native coordinator prevent both lost wakes and concurrent execution.
- Exercise a bounded alarm handler with a hanging downstream inspection, failure after rearming and a subsequent successful check. Distinguish application rearming from Cloudflare's finite automatic alarm retries; record what storage failure cannot guarantee.
- Verify SDK boot-time recovery cannot perform external mutations before generation and uncertain-operation gates are established. Confirm predecessor fencing and single-runtime ownership before native recovery.
- Exercise idle, human-waiting, retry-waiting, blocked, terminal-failed and disconnected states. Idle sessions stop execution checks; a new ordinary input starts eligible work. Retry waits respect native due times. Disconnect prevents stale alarms from reviving work.
- Test the accepted five-minute model inactivity deadline before the first response and midstream, including native HTTP. Test activity resetting the timer and provider completion ending it before a quiet tool finishes. Use accelerated injected clocks where useful, but identify which timing/lifetime cases ran against real deployed alarms.
- Test the native two-minute command default, a longer explicit finite timeout, rejection of zero/unlimited timeouts, descendant cleanup and retained edits after timeout. Quiet command output and long overall turns must not trigger a generic inactivity failure.
- Preserve native model retry limits and Retry-After waits. Exercise ten automatic resumptions of one interrupted turn and native failure on the next recovery check. The counter must survive DO recreation, and routine alarms must not increment it.
- Verify terminal errors become durable output/projection intents and saved work/queued inputs remain intact. Outbound delivery retries must not trigger model work or bypass an unresolved external-effect blocker.

Keep the remote repository fixture's verified contracts as dependencies, rather than rerunning every publication case here. A failure of continuous execution, recovery ownership or deadline enforcement must reopen the relevant decision before spec readiness.

## Comments

### Deployed verification passed; question interaction remains unresolved

Twenty bounded deployed scenarios passed against the actual pinned SDK and Cloudflare DO alarms, including a 180-second turn with no intervening requests, interrupted-turn recovery, native recovery exhaustion, native HTTP timeout/retry behavior, duplicate admission and creation, projection rollback/replay, idle/admission races and blocked startup. All temporary object storage, alarms, Worker and namespace were cleaned up. No external model API, Sandbox, R2 bucket or GitHub mutation was used in this fixture.

The final local human-waiting check exposed a remaining integration choice. OpenCode's structured `question` tool waits for a form submission; a normal queued teammate answer does not settle it. The native execution remains active. Do not close this verification or claim the accepted human-waiting behavior is verified until [Decide how agents ask teammates questions](15-question-interaction.md) is resolved and its selected path checked.

[Lifecycle verification results](../research/runner-lifecycle-results.md) records the successful cases, initial fixture correction, reproduced question gap, timing substitutions and remaining limits. The preferred alarm ownership and timeout defaults need no change based on the successful tests; the question-tool configuration is an explicit decision before completion.

### Question flow accepted; verification ready for closeout

The user accepted ordinary conversational questions with the structured question tool disabled in [Decide how agents ask teammates questions](15-question-interaction.md). The selected path had already passed the pinned local Workerd fixture: a question ended its turn, its alarm cleared, and an ordinary reply started another completed turn. This removes the outstanding human-waiting blocker without requiring another deployment or repeating the twenty successful deployed cases.

All recorded verification evidence is now available for this ticket's closeout. Keep the report's distinction between deployed lifecycle tests, accelerated native HTTP tests, the local question-flow check and the separately verified remote repository contract. Actual Slack/GitHub delivery remains the next integration verification, not a claim of this fixture.

## Answer

The selected DO-hosted runner and alarm supervision passed the bounded lifecycle verification. Admitted work completed without another teammate message after the admission request ended, and native execution recovered from process interruption. The accepted ordinary-question configuration closes the human-waiting gap found during verification.

Twenty deployed scenarios passed. These include a 180-second turn across real 30-second alarms with no intervening requests, missed wake and lost admission response, process restart, ten native resumptions followed by terminal failure, ordered and duplicate inputs, creation recovery, idle/admission races, inspection failures, native HTTP inactivity deadlines and retries, command timeout policy, projection rollback/replay, disconnection and blocked startup. [Lifecycle verification results](../research/runner-lifecycle-results.md) holds the observations, source references, fixture corrections and evidence links.

Use the implementation constraints established by these tests:

- Preserve the host-scoped native execution coordinator when an alarm handler returns. Rearm durable supervision before fallible inspection and use admission revisions to prevent stale idle checks from deleting newer wake obligations.
- Recover orphaned claims through native restart accounting before considering an ordinary pending-input wake. Respect native terminal outcomes and retry due times; do not use alarms to bypass either.
- Persist caller-supplied session and input identities before handoff. Retried creation and admission reconcile those same identities. Advance projection state and its cursor atomically.
- Establish persisted blockers and generation validity before SDK initialization can launch its automatic recovery sweep. Fault injection must wait for storage synchronization when it intends to simulate a crash after a committed write.
- Apply model inactivity deadlines at the HTTP request/body boundary so native transport error classification and retries remain intact. Provider-stream completion ends that deadline; a quiet tool has its own finite timeout.
- Apply [Decide how agents ask teammates questions](15-question-interaction.md): exclude the native structured question tool and use ordinary conversation replies. The pinned local check verified that the question ends its turn, its alarm clears, and the next ordinary input starts another completed turn.

The long-running case used real elapsed time and the accepted alarm interval. Other fault cases explicitly accelerated alarm and inactivity durations. Native HTTP parsing and retries ran against simulated responses; no external model provider was contacted. Command defaults and overrides were checked at the native invocation boundary, while actual process timeout, descendant containment and workspace persistence reuse [Verify the remote repository execution contract](12-remote-execution-verification.md). These are feasibility results, not a completed production runner or universal outage guarantee.

All temporary objects, alarms, Worker and namespace were cleaned up; [independent cleanup checks](../research/runner-cleanup.json) confirmed resource-specific 404 responses and deletion of the fixture secret. Closeout rechecked the saved successful results and resolved dependencies. No repeat deployment or test run was necessary.

The next verification is [Verify Slack and GitHub delivery integration](14-platform-delivery-verification.md). Provider configuration and upgrade compatibility remain separate planning decisions before spec readiness.
