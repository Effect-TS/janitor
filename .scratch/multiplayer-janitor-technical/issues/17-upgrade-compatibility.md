# Decide runner upgrade and deployment compatibility

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03, 04, 11, 12

## Question

How should Janitor, its independently pinned OpenCode runner and the Sandbox bridge evolve without corrupting existing sessions or repeating external work during a rollout?

Decide versioning and compatibility checks for service commands/events, native SDK state, Janitor-owned SQL tables, workspace checkpoints and the bridge protocol. Specify startup behavior for incompatible persisted state, migration ownership, treatment of active sessions during deployment and safe rollback limits. Use the verified SDK startup recovery and generation fences; account for the observed delay between Worker deployment and container-image rollout.

The lifecycle tests establish bounded restart recovery, not compatibility across arbitrary SDK/schema changes. State which upgrade checks implementation must automate and which deployment procedure the MVP will support. Do not choose silent data deletion or change the accepted session recovery semantics. This ticket decides the contract and procedure; it does not deploy an upgrade.

## Planning input from model configuration

[Decide model configuration and credential ownership](16-model-configuration.md#answer) requires immutable non-secret configuration records retained for existing sessions, an independently changeable default for new sessions, and operator-managed runner secrets. Define how a deployment activates credential rotations and retains required records, including rollback and already-running requests. Do not change a session model or delete its configuration during a rollout. Model retirement produces an explicit error; existing-session model migration is outside the MVP.

## Comments

### Accepted maintenance policy

The user accepts maintenance pauses for MVP upgrades that change session storage or execution behavior. Incoming platform messages continue to be saved durably while execution pauses for a controlled upgrade, then proceeds under the native recovery contract. Routine compatible releases may use normal restart recovery. This is an operator deployment procedure, not a new teammate stop/resume command.

[Cloudflare container rollout documentation](https://developers.cloudflare.com/containers/configuration/rollouts/) states Worker activation precedes container replacement and deploy success only means rollout started. Require runtime bridge compatibility checks; deployment completion alone cannot establish a compatible image. No live upgrade has been performed.

Remaining decisions include handling incompatible stored state and allowable rollback after migrations. Local SDK migration/recovery evidence is under inspection.

### Compatibility and rollback proposal

Pinned SDK inspection found that native migrations skip known completed IDs but do not automatically reject unknown newer migration IDs. Each migration step is transactional; the entire upgrade is not one transaction. Therefore a partially upgraded database can persist, and the SDK alone does not make a code downgrade safe.

Recommend an outer compatibility check before starting the SDK or dispatching repository tools. On unknown/incompatible state or migration failure, preserve all data, mark the affected session unavailable, retain incoming work and require operator repair. A rollback is permitted only when the old code has been tested against the actual resulting state and deployed peer versions. Otherwise keep execution paused and repair forward. Never clear a session, rewind publication journals or restore an older checkpoint automatically to make old code start. This proposal awaits user confirmation.

Pinned evidence at `2df00955cb933e977427535d2505e50cbc689c69`: `packages/core/src/database/migration.ts` applies missing forward migrations and ignores `_janitor_*` bootstrap tables; `packages/core/src/database/database.ts` propagates initialization failures; `packages/sdk/src/internal/host.ts` starts suspended-session recovery during host creation. Compatibility, maintenance and uncertainty guards must run before constructing that host. `packages/core/src/session/execution.ts` distinguishes shutdown interruption, which preserves the durable execution claim, from user interruption. Do not use a user-stop operation to implement deployment maintenance.

The existing [repository execution results](../research/repository-execution-results.md) and [lifecycle results](../research/runner-lifecycle-results.md) establish same-version restart behavior, generation fencing, checkpoint uncertainty and observed old-image rollout overlap. They do not establish cross-SDK upgrades, whole-upgrade atomicity, safe downgrades or a live deployment drain. Require those compatibility cases as implementation/release acceptance checks.

### Accepted compatibility and rollback policy

The user confirmed preserving incompatible sessions and queued work, preventing execution, and showing actionable errors. Rollback is allowed only when the older release supports the actual stored state. Otherwise operators repair forward while execution stays paused. Session data is never reset automatically.

## Answer

### Release identity and compatibility

Use an explicit release manifest for Janitor, the separately pinned runner and the Sandbox bridge. Record the OpenCode revision, isolated dependency lock/build identity, Worker compatibility date/flags, immutable container image identity, model configuration IDs, protocol versions and supported storage formats. Build versions identify artifacts; they do not alone establish compatibility.

Version the Janitor/runner command and event contracts, the repository bridge protocol, Janitor-owned SQL schema, native SDK migration set and workspace checkpoint manifest independently. Define supported reader/writer combinations for each release and test every combination allowed during its rollout. Routine releases must preserve the current deployed protocol until both sides support the replacement. Deploy consumers before enabling new message writers. Preserve stable input IDs, operation IDs, event cursors, ordering and rejection outcomes across versions. Unknown required fields, operations or incompatible major versions block processing explicitly; they must not be acknowledged as successfully executed. Existing durable intake can retain them pending a compatible consumer.

Every repository dispatch must validate the bridge's advertised protocol and required capabilities, tied to the running instance/image. Repeat after instance replacement. Do not infer the image from the Worker deployment result. Unknown/incompatible bridges receive no new tool work. Preserve an in-flight operation's identity and uncertainty during replacement; never retry it as a new operation merely because the version or generation changed.

### State ownership and startup guards

OpenCode owns its native unprefixed tables and forward migrations. Janitor owns its existing application migrations and the runner's `_janitor_*` coordination/compatibility tables. The bridge owns its execution journal format. Janitor-owned migrations must not rewrite native conversation tables; an SDK upgrade uses reviewed native migrations for that pinned target revision.

Maintain a small, stable outer compatibility record readable before constructing the SDK host. Record format versions, the last completed migration target, any in-progress migration target and the minimum compatible reader/writer release family. Check the actual native migration journal against the release's supported migration set. Unknown/newer versions or missing metadata on a nonempty database require explicit operator migration, never a guess that it is a fresh database. Fresh empty databases may initialize.

Before constructing the SDK host, validate compatibility, maintenance state, generation ownership and uncertain-operation blockers. Host construction can start native recovery immediately. Do not rely on a guard installed afterward. Persist migration intent before invoking native initialization; mark completion only after successful initialization and expected schema validation. Earlier migration steps can remain committed after a later failure. Preserve the in-progress record and block execution for repair rather than treating the failed upgrade as atomic. A tested restart may resume that exact supported migration target.

Checkpoint manifests carry format version, session/repository identity, generation, content integrity and operation/checkpoint references from the accepted execution contract. Reject unsupported or inconsistent manifests before restoring into an active workspace. Retain prior checkpoint objects for recovery under the existing retention contract; their existence is not permission to rewind session history.

### Maintenance procedure

Deployment operators may use maintenance pauses for storage or execution changes. This is deployment control, not a teammate command or new dashboard control. Routine compatible releases may use normal native restart recovery, subject to the same compatibility guards.

1. Validate the release manifest and supported upgrade path against representative saved state. Establish a durable maintenance barrier in Janitor before enumerating affected sessions, so new sessions and instructions cannot escape it. Keep platform receipt, authorization and deduplication active. Save inputs in their existing durable order and withhold dispatch while paused. Already accepted inputs remain accepted; do not reset their authority on release.
2. Ask each affected runner to persist a maintenance hold, block new execution and quiesce current work. For an existing host, stop scheduling fresh model/tool operations and use native shutdown semantics that preserve recoverable claims. Allow dispatched foreground operations to finish or reach their existing finite timeout, then commit result/checkpoint or retain explicit uncertainty. A session is quiescent only when no old executor can write and its recoverable state is durable. Generations fence late completions; they do not resolve unknown side effects.
3. Wait for every affected session to acknowledge the hold before incompatible deployment. Do not equate a temporarily unreachable runner with a stopped runner. If quiescence cannot be established, postpone the upgrade or keep the affected resources isolated for operator repair. No new whole-turn timeout is introduced. Preserve alarms and durable wake obligations, but maintenance guards prevent alarms and restarts from resuming execution prematurely.
4. Deploy compatible readers/receivers first, then bridges/runners and finally new writers as required by the manifest. Apply migrations under the hold and enforce pre-host guards. Verify actual bridge readiness after image replacement, not just deploy success. Independent sessions may remain held if only their state is incompatible.
5. Verify stored state, migration completion, model records, usable credentials and peer compatibility before releasing each hold. Release only the matching maintenance epoch, preserving newer removal/disconnection fences. Let native recovery resume eligible work and deliver queued inputs with their original identities/order. A terminally failed turn does not become a new instruction because maintenance ended.

The dashboard must distinguish maintenance or compatibility blockage from active execution, with a concise reason. Preserve pending platform output and deliver it normally where compatible; never manufacture a task-success message for a completed deployment. Updates in a thread may use existing concise status behavior when posting is available.

### Rollback and credential activation

Permit code rollback only when the target release supports the actual current schemas, migration records, checkpoints, pending commands/events, bridge versions and required model configurations. Test that combination, including any partial migration state. A prior successful deployment is insufficient proof. Check Cloudflare's resource-level rollback constraints separately from application data compatibility.

Do not assume native down-migrations exist. If compatibility is unproven, preserve state and repair forward while affected execution remains blocked. Never clear a DO, discard queued inputs, roll back publication receipts or restore an old workspace to make old code start. Historical whole-state restoration is a separate operator recovery procedure requiring reconciliation of accepted inputs and external effects before execution; it is not an automatic deployment rollback.

Retain model configuration records needed by existing sessions, independently of the new-session default. Rotate runner secrets through controlled deployment activation. Existing requests may use the previous credential; new runtime instances receive the active binding. Where possible retain overlapping provider key validity until the new release is verified. A rollback must retain usable approved credentials and must not silently restore a revoked key. If necessary, deploy compatible old code with current secrets instead of selecting a historical version unchanged.

### Required release checks and evidence limits

Automate tests for supported old/new protocol combinations; unsupported versions rejected before side effects; same-state restart; successful forward migration; partial migration failure and restart; older code refusing unsupported newer state; and rollback only on a declared tested path. Test queued input and durable rejection preservation, uncertain publication across release boundaries, stale generation/maintenance acknowledgments, delayed old container images, credential rotation and session-pinned model retention.

Before the first upgrade affecting active sessions, exercise the complete maintenance path in an isolated deployment: inbound messages during the hold, active model and foreground tool operations, process replacement, checkpoint completion/uncertainty and restart before hold release. Confirm no duplicate repository execution or publication and no silently lost input. These are implementation/release acceptance requirements. No cross-version migration, live deployment drain or rollback was executed in this planning ticket. The existing fixtures establish same-version recovery only.

Primary platform sources: [container rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/) document nontransactional Worker/image activation and old-image overlap; [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) document resource-level restrictions; [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) document binding changes through version/deployment activation. Pinned native source and existing fixture evidence are listed in the comments above.

The decision is resolved. The final spec must include the outer guards, durable maintenance barrier and acceptance tests as implementation work, without describing them as capabilities already present in Janitor.
