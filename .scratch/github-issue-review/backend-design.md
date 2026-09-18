# Backend design

Invocation update, 2026-09-18: new review requests use the `/janitor` slash command, replacing user mentions to avoid notifying an unrelated GitHub account. ADR 0007 records the current invocation contract.

Implementation status, 2026-09-18: this design has been implemented through tickets 01–13. The confirmation language below is historical. See [completion review](completion-review.md) for the current status.

Confirmed by the user as part of the consolidated design. This document records the mechanics beneath the accepted [spec](spec.md). Confirmation does not authorize implementation. Existing capabilities and gaps are recorded in [implementation-facts.md](implementation-facts.md).

## Admission and identity

Extend the signed webhook path to recognize newly created comments on open issues. Parse the direct mention outside quotes, code, and link destinations in trusted code; the model does not decide whether a comment authorizes execution. Fetch the current issue, comment, repository identity, and effective author permission from GitHub. Match stable numeric user and repository IDs. Reject bots, edited or missing source comments, PR conversation comments, unavailable access, and disabled or paused repositories.

Persist the accepted instruction snapshot and a receipt keyed by repository and comment identity before scheduling work through the existing transactional outbox. Delivery IDs deduplicate transport; comment identity deduplicates invocation. Preserve a connection/admission boundary so delayed events from a disconnected or disabled period cannot create work after reconnection or enablement. Refuse to reinterpret redelivery as a new request.

Use one durable per-issue scheduling record to serialize runs and explicit publications. Different issues execute concurrently across the cluster. A frontend publisher proves their linked GitHub identity and current effective permission; ordinary settings retain existing Janitor membership authorization.

## Agent Entity, action workflows, and sandbox

The agent is a persistent cluster Entity that receives messages, owns its state, and emits messages. It coordinates admission rechecks, evidence acquisition, repository provisioning, investigation, validation, and publication. Embedded Effect Workflows model actions such as individual LLM invocations and publication operations. Each action has a stable identity and a persisted result; the complete agent is not a Workflow.

Use one agent Entity per review run, with the separate per-issue scheduler coordinating independent runs and publication. Persist agent state explicitly rather than assuming persisted mailbox messages capture it. Apply each completed action result once to agent state, including after duplicate delivery. Pending external actions must not prevent cancellation messages from being processed.

Record the actual default-branch name and commit. The orchestrator obtains repository contents from GitHub and supplies a checkout to the sandbox without credentials. Any historical revision needed for a confirmed-fixed comparison is provisioned the same way. Extraction and provisioning must not execute repository hooks or scripts on the orchestrator.

Each active run owns an isolated, ephemeral sandbox with Node.js, pnpm, and common system tools. Package installation and tests use its internet access. Model calls and model credentials stay in trusted orchestration, which brokers filesystem and shell tools into the sandbox. Repository selection, remote reads, and publication use typed operations outside the sandbox; model-supplied URLs or branch names cannot select arbitrary repositories or writes.

Persist the start time and deadline once. Installation, investigation, and testing share the 15-minute allowance. After runner restart, restore agent state and resume pending actions if the sandbox remains usable, reusing completed LLM results. Losing unfinished sandbox work makes the investigation interrupted and requires a new invocation; retain available observations. Recovery never grants a new time allowance or revives cancelled work. A completed investigation can proceed through publication recovery without repeating model calls.

## Durable records

Use the existing database, cluster messaging, and Workflow infrastructure for invocation receipts, persisted agent state, action identities/results, run state, deadlines, cancellation, evidence references, and publication results. Store a bounded validated patch with its exact base commit, test command/results, generated prose, and intended writes before publication. For the MVP, bounded artifacts can be stored with run records rather than introducing durable full-workspace snapshots.

Keep detailed run data for 14 days. Retain only minimal receipts, summary IDs, branch/PR ownership, and last publication fingerprints afterward while connected. Ownership records may retain hashes of content without retaining full old reports. Expired detailed results are not eligible for frontend publication.

## Validation outside the model

Validate the patch against the recorded base, independently of sandbox Git status or the model's description. Canonicalize paths and reject traversal, symlink/submodule changes, binary payloads, prohibited configuration/dependency files, and changes outside the discovered test layout. Bound file count and patch size with internal constants. Test layout discovery uses repository conventions and test configuration; it is not permission to execute configuration outside the sandbox.

Path checks cannot prove that a helper is used only by tests or that a failing assertion represents the reported bug. Preserve the test command, exit result, relevant output, and the agent's explanation. Confirm reproduction only when the evidence supports the reported failure, not a setup failure. Where scope or evidence cannot be established, retain the findings and block the reproduction PR rather than broadening permitted changes.

Validate agent-authored publication text independently: prevent mentions and frontend links, restrict links to permitted evidence, and enforce bounded length. Do not insert application-owned prose templates. Invalid output cannot be published verbatim; retain it as a validation failure if it cannot be corrected within the investigation deadline.

Issue review uses least-privilege, repository-scoped installation credentials. Separate read operations from publication. GitHub permission categories do not express label prohibition, owned-branch restrictions, or draft-only behavior, so trusted publication code enforces these rules. No generic GitHub-write tool is exposed to the model.

## Publication and recovery

Represent branch update, draft PR creation/update, and summary creation/update as separate Activities with persisted intent and results. Use a deterministic Janitor branch identity plus durable ownership; a matching name alone never proves ownership. Compare existing branch head and PR content with the last recorded publication before reuse, and refuse to overwrite intervening changes.

Within each actual write attempt, recheck the current authorizing actor, source invocation, issue state, connection, pause, access, review enablement, cancellation state, and publication mode. Apply the existing per-issue serialization. A previously completed authorization Activity cannot supply a cached permission grant for a new write attempt.

Normal run publication uses its invoker's authority. Explicit frontend publication uses the selected result and publisher's fresh authority, with the latest-result, retention, and unchanged-source requirements. Merely disabling dry-run never authorizes publication.

Reconcile GitHub state when a response is lost before repeating the operation. Use the durable branch, PR, and summary identities to identify completed writes. If the outcome cannot be established, mark publication unresolved and stop further writes. Preserve partial publication in run history, including an orphan branch if a later PR operation fails; do not attempt destructive rollback.

The summary links the actual reproduction PR when one exists. It is updated on later authorized runs without creating a new comment on every run. All published claims identify the tested commit rather than silently following a newer default-branch head.

## Cancellation and freshness

Persist cancellation independently of the model. Invocation edits/deletions, issue closure, repository state changes, and explicit frontend cancellation invalidate the applicable work. Check this state between tool/model operations and before each write. Re-fetch the source comment before execution and publication and process edit/delete events without admitting new agent work. An edit observed even if later reverted still invalidates the accepted invocation.

Stop sandbox processes when cancellation or timeout is detected. Work already accepted by GitHub cannot be recalled by local cancellation. Serialize local control changes with publication attempts where possible, and report completed or uncertain writes accurately. Remote permission changes and external writes cannot be made one atomic transaction; the accepted check/write race remains.

## Delivery order

1. Separate shared connection, pause, access, and workflow eligibility from synchronization, preserving stale-work rejection.
2. Migrate labeling to direct GitHub reads and migrate Slack repository access checks. Do not release old labeling jobs that still depend on synchronized snapshots merely by deleting their readiness checks.
3. Build review admission, per-issue scheduling, the persistent agent Entity and embedded action workflows, validation, and frontend history. Development may overlap the migration, but production review enablement waits for its completion.
4. Add guarded GitHub publication and explicit frontend publication of dry-run results using the same Activities and ownership checks.

Validation before rollout should cover forged or quoted invocations, permission revocation, edited/deleted comments, duplicate deliveries, issue/repository cancellation, sandbox interruption, uncertain remote writes, human-edited PRs, forbidden patches, dry-run publication, and history expiry without replay. These are implementation acceptance scenarios, not tests written during this interview.
