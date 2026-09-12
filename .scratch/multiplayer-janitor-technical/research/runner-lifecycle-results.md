# Unattended runner lifecycle verification

Twenty bounded Cloudflare scenarios passed using the pinned OpenCode Workerd SDK and real Durable Object alarms. The human-waiting check exposed an incompatibility with native structured forms. The user accepted ordinary conversational questions with the structured tool disabled in [Decide how agents ask teammates questions](../issues/15-question-interaction.md), and that selected path passed locally. [Verify unattended progress and recovery of the session runner](../issues/11-runner-lifecycle-verification.md) is resolved with the evidence and limits recorded below.

## Executed evidence

| Area                         | Observation                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unattended lifetime          | A 180-second fake-model turn completed across at least five real 30-second alarms. The driver made no requests to that object for 220 seconds after admission. One runtime incarnation and one model call were recorded.                                                                           |
| Saved input, missed wake     | An admitted input with immediate wake suppressed and its response discarded was picked up by an alarm and completed.                                                                                                                                                                               |
| Crash after admission        | A real `ctx.abort` after saved admission was followed by alarm activation and completion without another input.                                                                                                                                                                                    |
| Interrupted turn             | A process aborted while its native execution claim was held. The next constructor was followed by an alarm, native recovery and completion.                                                                                                                                                        |
| Recovery exhaustion          | Eleven interrupted model starts represent the initial attempt plus ten resumptions. Native recovery then emitted terminal failure; the alarm obligation cleared. Routine checks did not spend resumptions.                                                                                         |
| Ordered inputs               | Three sequentially admitted inputs representing Slack/GitHub/Slack were delivered in acceptance order by the harness. Actual platform ingestion remains the platform verification ticket.                                                                                                          |
| Duplicate delivery           | Retried IDs before and after promotion produced one admitted input and one model call, retaining the original payload.                                                                                                                                                                             |
| Creation recovery            | Concurrent/retried creation returned one identity. An abort after native creation but before saving the returned mapping recovered the same caller-supplied native session ID and one creation event.                                                                                              |
| Idle/admission race          | A new input arrived during a deliberately delayed idle inspection. The changed revision prevented deletion of the newer wake obligation. Both inputs completed.                                                                                                                                    |
| Inspection failure           | A real Effect timeout on a never-completing inspection plus seven injected inspection errors did not exhaust progress. Explicitly rearmed alarms eventually processed the pending input.                                                                                                           |
| HTTP first-response deadline | The actual native request executor, LLM client, protocol parser and session retry path handled an injected HTTP request that never returned headers. The deadline failed the attempt and native retry completed.                                                                                   |
| HTTP midstream deadline      | The same native path handled a partial response followed by a stalled body. The response stream timed out, was cancelled and retried successfully.                                                                                                                                                 |
| Stream activity              | Chunks arriving within the inactivity interval kept a stream alive beyond that interval's total duration.                                                                                                                                                                                          |
| Quiet tool                   | A tool took 800 ms after the provider stream ended, exceeding the accelerated 150 ms model inactivity deadline. It completed normally, followed by another model response.                                                                                                                         |
| Provider retry delay         | A 503 response with Retry-After delayed the next attempt for at least the requested second. Alarms did not bypass the native wait.                                                                                                                                                                 |
| Disconnected response        | A partial HTTP stream followed by an injected connection-reset error retried successfully.                                                                                                                                                                                                         |
| Provider retry exhaustion    | A stream that stalled on every attempt made five model requests, then native execution failed.                                                                                                                                                                                                     |
| Command policy               | The real native ShellTool forwarded 120,000 ms for its default and 300,000 ms for an explicit longer timeout. The pre-execution hook rejected zero timeout and background execution before the shell boundary. Process execution was intentionally replaced at that boundary in this policy check. |
| Projection transaction       | An injected exception between projection writes and cursor advancement rolled both back. Applying and replaying native durable events then produced one projection entry per sequence. This checks the transaction pattern, not a deployed Janitor dashboard implementation.                       |
| Disconnect and startup gate  | Disconnection cancelled active work, removed the alarm and rejected later admission. After a separate crash with a persisted blocker, alarm activation did not initialize native recovery or call the model again.                                                                                 |

Native process timeout/cancellation, descendant containment, edits retained after failure and checkpoint/restore behavior reuse the executed [remote repository contract](repository-execution-results.md). This fixture does not repeat repository publication tests or claim to have run a 120-second shell command. The command-policy case verifies the native default and override at the actual invocation boundary; previous tests verify native timeout enforcement and external cleanup.

## Human-waiting finding and accepted resolution

In the local pinned Workerd runtime, the native `question` tool opened a form and kept its turn active. After an ordinary queued input saying "Choose A", the model-call count remained one, the native claim remained held, the input remained pending and alarms continued checking. This differs from an agent asking a question in a normal reply, finishing its turn and processing the next message later.

The question tool calls `Form.ask`, which waits on a form-specific deferred result. Normal prompt admission does not submit that form. The accepted MVP resolution removes the structured question tool and uses ordinary conversational questions. Native form handling is outside the selected MVP tool configuration.

The [ordinary-question path passed locally](runner-plain-question-result.json): the structured tool was absent from the model's advertised tools, the agent's question ended its turn and cleared the alarm, and the next ordinary input produced a second completed turn. The user subsequently accepted this behavior. This is not a Slack integration test.

## Fixture corrections and limits

The first startup-blocker test failed because it wrote the blocker and immediately aborted without waiting for storage synchronization. The corrected injection explicitly awaited `storage.sync()` before aborting; the blocker then survived and prevented SDK initialization. [The initial result](runner-final-first-result.json) is retained alongside the successful rerun. This is a fault-injection correction, not evidence that an unconfirmed write survives an immediate abort. Production admission and fencing must respect durable completion boundaries.

The fixture initially compared the terminal outcome with `error`; pinned native state uses `failed`. This was corrected before the failure-with-pending-work supervisor branch was treated as representative. Orphaned claims also take precedence over pending-input wake, so ordinary wake cannot bypass native recovery accounting.

The long lifetime case used real 30-second alarms and real elapsed time. Other cases accelerated alarms to 500–1,000 ms and model inactivity to 150 ms. The transport wrapper's deployment default remains 300,000 ms. The HTTP fixtures use native parsing, error classification and retry logic with a supplied simulated HTTP client; they make no external provider calls. Real provider compatibility and credentials are still planning work.

Tests do not establish immunity to arbitrary Cloudflare outages, CPU starvation, unavailable storage, or every deployment transition. The provider workspace here is in memory; external operation fencing/checkpoints are separately tested by the remote contract. No production Janitor runner, platform ingestion or output publisher was implemented.

## Artifacts and cleanup

- [Core lifetime/recovery cases](runner-remote-result.json)
- [Native HTTP, delivery and race cases](runner-additional-result.json)
- [Final command-policy, creation and startup-gate cases](runner-final-result.json)
- [Local native HTTP smoke](runner-http-local-result.json)
- [Native structured-question reproduction](runner-question-result.json)
- [Versions and executed bundle hash](runner-provenance.json)
- [Cloudflare cleanup verification](runner-cleanup.json)
- [Fixture source and commands](../prototype/runner-fixture/README.md)

All deployed case drivers cleaned their object data and alarms. The temporary Worker and its DO namespace independently returned 404 after deletion. The local fixture secret was deleted and retained artifacts checked for its value. No Sandbox, R2 bucket or GitHub resource was created for this fixture. The existing Cloudflare login was retained.
