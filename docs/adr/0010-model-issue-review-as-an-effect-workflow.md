# Model issue review as an Effect Workflow

Status: accepted.

The choice to model the entire review run as a Workflow is superseded by [ADR 0012](0012-model-the-agent-as-a-cluster-entity.md). The agent is a cluster Entity with embedded workflows for actions. The Activity idempotency, fresh authorization, and publication reconciliation requirements below remain applicable.

Use an Effect Workflow to orchestrate each issue-review run, with idempotency handled at individual Activity boundaries. This models durable execution and publication recovery explicitly instead of relying only on dispatcher retries or ephemeral sandbox state.

Before publication, retain the validated patch, test evidence, and intended writes. When a GitHub write has an uncertain outcome, its Activity reconciles GitHub state before retrying. Recovery may finish the same publication under fresh authorization and repository checks but must not restart model work. If the outcome cannot be established, report unresolved publication and stop further writes.

Workflow durability and external-write reconciliation are complementary. The concrete Activity boundaries and storage representation will follow the repository's Effect Workflow patterns; implementation is not part of this design interview.

Existing labeling workflows already use named Activities and persisted publication plans. The installed Effect Activity implementation memoizes completed results but may rerun an interrupted Activity body. Fresh permission and repository checks therefore belong inside each actual write attempt, not solely in a completed authorization Activity whose old result could be replayed. Retain the execution deadline across recovery so interruption cannot restart the 15-minute allowance.

The original recovery choice was to report interrupted investigations and require a new invocation. ADR 0012 refines this: runner restarts may restore persisted agent state and resume pending actions when the sandbox remains usable, while loss of unfinished sandbox work still interrupts the run. Completed action results and uncertain publication writes remain recoverable without restarting the entire investigation.
