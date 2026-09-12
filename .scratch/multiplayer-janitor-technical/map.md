# Plan the multiplayer Janitor MVP architecture

Labels: wayfinder:map
Status: resolved

## Destination

Resolve the runtime, architecture, and integration decisions needed for an implementation-ready spec of the agreed Slack-first multiplayer Janitor MVP. The final spec must describe component responsibilities, contracts, durable state and recovery, and acceptance checks without leaving build-blocking design choices implicit.

## Notes

- The user accepted the [implementation specification](spec.md). All child tickets are resolved and the planning destination is reached. Implementation and release acceptance checks remain as specified in the handoff.

- The product authority is [Design shared work with Janitor](../multiplayer-janitor/map.md), especially [Choose the MVP scope and planning handoff](../multiplayer-janitor/issues/10-mvp-scope-and-handoff.md). Reuse those decisions; reopen one only when a concrete technical constraint requires a tradeoff with the user.
- Start by investigating OpenCode V2 using its Effect SDK APIs and Durable Object feasibility, as explicitly requested. Establish exactly which repository, revision, package, and API the names denote. Do not silently substitute a generated HTTP SDK, current default-branch implementation, or an older release.
- Distinguish running the agent execution loop inside a Durable Object from using a Durable Object to coordinate execution hosted elsewhere. These are alternatives to evaluate, not decisions already made.
- Consult wayfinder, grilling, domain-modeling, and unslop. Research tickets use research; prototypes use prototype. Follow `docs/agents/issue-tracker.md` and the root glossary.
- This is planning. No production implementation, live deployment, repository mutation on GitHub, real agent execution on team repositories, or paid experiments are part of charting. A later bounded feasibility prototype may be proposed when evidence requires it.
- The user explicitly requested an implementation-ready spec. Once decisions are resolved, synthesize their accepted contracts into `spec.md` here as the planning handoff. Ticket answers remain the source of decision rationale; this permits the spec artifact, not product implementation.
- Treat the chosen harness as the owner of normal agent conversation behavior wherever its verified APIs support that behavior. Do not reintroduce custom conflict arbitration, repeated-mention prompting, stop/resume commands, spending controls, detailed log viewers, or GitHub-to-chat completion notifications into the MVP.
- Existing product research and the [accepted walkthrough](../multiplayer-janitor/prototype/walkthrough.html) are inputs. They do not establish runtime compatibility or production API behavior.
- Local starting points: `apps/cluster/src/Worker.ts` already uses `AlchemyCloudflareCluster`; `WorkflowOutbox.ts`, `WorkflowDispatcher.ts`, and the GitHub webhook pipeline supply durable delivery; `LiveHub.ts` supplies repository observation updates. Inspect the existing responsibilities before introducing competing coordination. Effect packages are pinned in `pnpm-workspace.yaml`; compatibility must use those actual versions.
- Pin and cite primary evidence in research artifacts. Distinguish documented support, inspected code, inference, and executed experiments. Capture research on isolated branches with ticket pointers; do not switch the working checkout.

## Decisions so far

- [Identify OpenCode V2's Effect APIs and runtime requirements](issues/01-opencode-effect-apis.md): Pinned the V2 Workerd Effect SDK and explicit queued delivery; dependency compatibility and execution behavior still need a probe.
- [Establish Durable Object capabilities for agent execution](issues/02-durable-object-feasibility.md): Source supports a DO-hosted loop and SQLite recovery, while repository tools require separate execution services and lifecycle behavior needs verification.

- [Verify the Workerd Effect SDK under Janitor's dependencies](issues/10-workerd-effect-probe.md): Local execution and SQLite recovery work with a fake model and tool; measured Effect API drift and resumed-turn queuing constrain the hosting decision.

- [Choose the agent execution and hosting boundary](issues/03-execution-boundary.md): Accepted a separate OpenCode runner Worker with one DO per session and external repository execution; independent dependencies and explicit feasibility gates precede spec readiness.

- [Decide session state ownership and recovery](issues/04-session-durability.md): Accepted durable ordered delivery into the harness-owned conversation, native restart behavior, replayable projections, and reconciliation before repeating uncertain external effects.

- [Decide repository access and workspace isolation](issues/05-repository-execution.md): Accepted private session workspaces in Cloudflare Sandbox, R2 checkpoints, GitHub App access, and publication and disconnection behavior; concrete execution mechanics remain subject to verification.

- [Decide platform identity and authorization contracts](issues/06-platform-identity.md): Accepted persistent linked-account authorization independent of Access expiry, admin/member roles, and explicit admin removal and restoration; supersedes earlier ongoing Access eligibility rules.

- [Decide Slack and GitHub event delivery contracts](issues/07-slack-github-delivery.md): Accepted immutable inputs, grouped reviews, explicit mentions for general PR comments, compact progress, and recovery behavior; platform integration verification gates spec readiness.

- [Decide dashboard and usage data contracts](issues/08-observation-contracts.md): Accepted compact session projections, independent execution and delivery status, and session-lifetime recorded input/output totals; team aggregates are deferred.

- [Verify the remote repository execution contract](issues/12-remote-execution-verification.md): Verified native SDK execution, foreground containment, R2/SQLite recovery and GitHub App publication; recorded the database-table convention, capture/checkpoint ordering and cleanup contract.

- [Choose durable runner supervision and wakeup](issues/13-runner-supervision.md): Accepted runner-owned alarms, 30-second checks, native recovery limits and finite operation deadlines.

- [Decide how agents ask teammates questions](issues/15-question-interaction.md): Accepted ordinary conversational questions with the structured question tool disabled; the selected path passed the local lifecycle check.

- [Verify unattended progress and recovery of the session runner](issues/11-runner-lifecycle-verification.md): Passed twenty deployed lifecycle scenarios and the local ordinary-question check; recorded supervision constraints, evidence limits and cleanup.

- [Verify Slack and GitHub delivery integration](issues/14-platform-delivery-verification.md): Completed provider and local verification; carry bounded recovery and first-captured feedback into the spec, with live channel removal/restoration deferred to implementation acceptance.

- [Decide model configuration and credential ownership](issues/16-model-configuration.md): Accepted a deployment default, session-pinned model configuration, operator-managed runner secrets and visible failures without fallback; require real-provider validation before launch.

- [Decide runner upgrade and deployment compatibility](issues/17-upgrade-compatibility.md): Accepted controlled maintenance, compatibility checks before native recovery, versioned contracts and state, and tested rollback paths with forward repair when incompatible.

- [Validate the architecture and implementation-ready spec](issues/09-spec-readiness.md): The user accepted the consolidated spec, workflow walkthrough, implementation sequence and acceptance requirements; the technical map is settled.

## Not yet specified

None. All planning decisions are resolved; the accepted spec records the implementation and release checks still to perform.

## Out of scope

- Native structured question forms and their platform UI/recovery are deferred. MVP questions use ordinary thread replies, as accepted in [Decide how agents ask teammates questions](issues/15-question-interaction.md).

- Persistent background processes across shell commands, including development servers and watchers, are deferred. The user accepted foreground-only execution, with command descendants stopped before checkpointing, in [Verify the remote repository execution contract](issues/12-remote-execution-verification.md).

- Team-wide token aggregates and usage date-range filtering are deferred. The MVP retains per-session totals and team-wide session visibility, as refined in [Decide dashboard and usage data contracts](issues/08-observation-contracts.md).

- Cloudflare Artifacts integration or early-access provisioning for the MVP. Use Cloudflare Sandbox with R2 workspace checkpoints; Artifacts remains a later option. The accepted storage direction is recorded in [Decide repository access and workspace isolation](issues/05-repository-execution.md).

- Rebuilding or expanding the accepted product scope. Discord delivery, cross-platform session mirroring, multi-repository work within a session, and coordination of separate agent efforts remain later work.
- Implementing or deploying the MVP during this map.
- Teammates' personal agent subscriptions, dedicated stop/resume and shutdown controls, configurable budgets or additional approval controls, detailed execution-log retention/viewing, monetary reporting, and GitHub-to-chat review-completion notifications.
- Declaring the OpenCode V2/Durable Object approach feasible without evidence, or selecting a fallback without a recorded decision.
