# Choose the agent execution and hosting boundary

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 01, 02, 10

## Question

Given verified OpenCode Effect APIs and Durable Object capabilities, where do agent sessions, model calls, tools, repository operations, and coordination run?

Choose whether the requested Durable Object directly hosts execution or coordinates another runtime, or whether a feasibility prototype is needed before that choice. Name the selected OpenCode revision/API boundary and its relationship to Janitor's Effect version. Assign component responsibilities and identify how the existing Cloudflare/Effect deployment can support them without duplicating a harness-owned concern. If the preferred arrangement fails, present a concrete alternative and tradeoff to the user. Do not silently change the accepted interaction model.

Use [Verify the Workerd Effect SDK under Janitor's dependencies](10-workerd-effect-probe.md) as executed evidence. Decide how the selected boundary handles the incompatible Effect APIs and which remaining production lifecycle checks it requires. The tested three-package alignment is not an approved application downgrade.

## Comments

### Proposed hosting direction, awaiting discussion

Use the measured OpenCode V2 Workerd Effect SDK as the planning baseline, with one Durable Object per agent session in a separately built runner Worker. That runner owns the OpenCode conversation, model calls, harness inbox, and execution events. Repository files, Git operations, and commands run through a separate execution service. Janitor retains platform authentication, authorization, inbound delivery, session routing, and outward notifications/observation.

A separate runner build/dependency graph is proposed to isolate OpenCode's tested Effect dependencies from Janitor's snapshot. Treat the boundary as serialized commands and events rather than sharing Effect services across builds. The exact contract belongs in the subsequent integration decisions.

The alternative is to run the entire OpenCode loop alongside the repository workspace in an external runtime, with Janitor coordinating it. That avoids placing the loop's lifetime under Durable Object lifecycle constraints, but moves conversation persistence and runner supervision outside that object. Neither alternative has production guarantees from the local probe.

First discussion question: adopt the DO-hosted runner plus external repository execution as the preferred direction, conditional on proving production liveness and remote tool integration, or choose the external runner direction? The recommendation is the former, consistent with the user's preferred OpenCode/DO direction and the successful local loop tests. This is not yet an accepted hosting decision. Any required feasibility work must remain an explicit blocker before spec readiness.

### User decision

The user accepted the proposed separate runner Worker, one Durable Object per agent session, external repository execution, dependency separation, and explicit remaining feasibility checks: "Yes, I think this sounds good".

## Answer

Use a separately built and deployed OpenCode runner Worker, with one Durable Object per agent session. The accepted direction remains conditional on the lifecycle and remote-execution verification below.

| Component                                   | Responsibility                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing Janitor application                | Team identity and authorization, platform event admission, routing to sessions, outward delivery, and dashboard projections. Reuse existing durable ingress/outbox facilities where appropriate. |
| Session Durable Object in the runner Worker | Own the OpenCode conversation, harness inbox, model calls, tool orchestration, and durable execution events through the Workerd profile. Janitor does not duplicate the agent conversation loop. |
| External repository execution environment   | Own the session's repository workspace and execute file operations, Git operations, commands, and tests requested through the runner's tools.                                                    |

The baseline is OpenCode V2 source revision `2df00955cb933e977427535d2505e50cbc689c69`, using `@opencode/sdk/workerd/effect` and its embedded Effect APIs. Build the runner with its own dependency resolution, starting with the tested registry `4.0.0-rc.112` versions of `effect`, `@effect/platform-node`, and `@effect/platform-node-shared`. Janitor retains its snapshot dependencies. Merely adding a workspace package under the existing global overrides is insufficient isolation; the runner's dependency graph and build must be independently pinned.

Janitor and the runner exchange serialized commands and events. They do not exchange Effect services, fibers, or implementation-specific error objects. Exact transport, schemas, delivery acknowledgments, deduplication, and observation contracts belong to the subsequent state and integration decisions.

An external runtime hosting the entire agent remains an alternative if the selected arrangement fails its checks. Switching to it requires a recorded hosting decision; it is not an automatic fallback.

[Verify unattended progress and recovery of the session runner](11-runner-lifecycle-verification.md) and [Verify the remote repository execution contract](12-remote-execution-verification.md) block spec readiness. These checks must establish the selected production arrangement, including progress without another teammate message and handling of interrupted external operations. The local fake-model probe is not sufficient evidence. Live deployment, paid resources, and credential provisioning are not authorized by this planning decision.

The measured restart behavior remains input to [Decide session state ownership and recovery](04-session-durability.md); this hosting choice does not silently settle that behavior. Repository environment selection and publication authority remain in [Decide repository access and workspace isolation](05-repository-execution.md).
