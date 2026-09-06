# GitHub auto-labeling design

## Status

Proposed design. No implementation is included.

[GitHub synchronization design](./github-synchronization-design.md) owns webhook ingestion, topology, workflow infrastructure, synchronized snapshots, freshness, targeted refresh, and repair. This document owns rules, managed-label behavior, evaluation, mutation, UI, AI, privacy disclosures, and labeling convergence.

The remaining product decision is managed-label ownership. This design recommends enforced add/remove behavior for concrete rules and apply-only behavior for AI rules. The UI must state both policies before save.

## Goals

- Configure repository-scoped rules for issues and pull requests.
- Select outputs from synchronized labels that still exist in GitHub.
- Support typed deterministic predicates such as pull request base branch.
- Support bounded AI classification without giving an agent mutation tools.
- Explain and audit each decision.
- Converge after duplicate, delayed, or out-of-order webhooks and repeated activities.
- Execute reconciliation as a durable Effect workflow on the Cloudflare architecture defined by the synchronization design.

## Non-goals

- Arbitrary scripts, regular expressions, JSON logic, or executable expressions.
- Letting AI invent labels, call GitHub, or choose mutation operations.
- Exactly-once GitHub mutations or AI calls.
- Replacing all labels on an entity.
- Creating missing labels automatically.
- Cross-repository rules in the first release.

## Product semantics

### Qualified snapshots are evaluation inputs

Webhook deliveries are invalidations, not evaluation state. Synchronization projects them, verifies current state as required, and publishes a qualified `SnapshotReady` record. Auto-labeling evaluates that snapshot without a GitHub read.

A reconciliation identity is:

- canonical entity identity;
- synchronized snapshot generation;
- latest published rules revision;
- AI approval-policy revision.

Several deliveries may converge on one reconciliation. Delivery ID deduplicates ingestion and projection only. A later snapshot generation, active rules revision, or AI approval-policy revision creates a new reconciliation identity. Policy changes do not emit handoffs. Webhook and background-sync work uses the latest configuration when it evaluates, regardless of when the event arrived or the item was created. Queued work carrying an older revision is handed off under the latest revision.

Evaluation requires a `Verified` snapshot within its purpose-specific age limit. If the snapshot is projected, syncing, stale, blocked, superseded, expired, or missing required fields, labeling requests targeted synchronization and makes no mutation. This keeps freshness and repair policy in the synchronization boundary.

### Rules produce managed-label decisions

Each enabled rule has one entity target, one evaluator, and one or more preselected output labels. Display order has no evaluation meaning.

For each label enforced by concrete rules:

1. Any matching rule makes the label desired.
2. If none match but at least one result is indeterminate, preserve its current state.
3. Otherwise the label is undesired.

Rules targeting the same label use OR semantics. Concrete predicates within one rule use AND semantics. Users express more complex OR behavior as separate rules.

AI rules are apply-only in the first release. A match may add a label. AI no-match, failure, or indeterminate results never authorize removal. This bounds prompt injection, nondeterminism, and provider changes.

### Managed-label ownership

Ownership is keyed by repository, entity kind, and stable label ID.

- A label targeted by an enabled concrete enforced rule, or still in revision-bound retirement, is managed for that entity kind.
- Janitor may add a desired managed label.
- Janitor may remove an undesired managed label, even if a person added it.
- Janitor never removes an unmanaged label.
- Later reconciliation repairs manual removal of a desired managed label.
- A label targeted by AI is apply-only and never enters the automatic removal set.

Disabling the last enforced rule puts the label into a revision-bound retiring state. A targeted synchronized scan finds stale uses. Reconciliation removes them before a compare-and-set releases ownership, unless a later revision reclaimed the label. Disabling a repository pauses mutation and leaves labels unchanged.

GitHub does not identify who assigned a label, so Janitor does not infer per-assignment ownership from webhook races. A product that always preserves human assignments must expose an apply-only mode instead.

## Domain model

All API, persisted, workflow, GitHub, and AI boundaries use Effect Schema. External identifiers are branded. Numeric IDs outside JavaScript's safe integer range require lossless decoding. Label and entity node IDs are preferred where the API supports them.

### Reconciliation request

`SnapshotReady` supplies:

| Field                    | Meaning                                               |
| ------------------------ | ----------------------------------------------------- |
| Entity identity          | Canonical synchronized issue or pull request identity |
| Snapshot generation      | Version of synchronized entity state                  |
| Covered journal sequence | Highest known invalidation covered by verification    |
| Relevant fingerprint     | Hash of fields and labels used by active rules        |
| Freshness status         | Qualification supplied by synchronization             |
| Active rules revision    | Latest published ruleset to evaluate                  |
| AI approval revision     | Consent and provider-policy fence                     |

Repository content and credentials do not appear in workflow submission payloads. The workflow loads the snapshot from the application database by this identity.

### Label reference

A configured label stores repository ID, GitHub database and node IDs, and last observed display fields. Stable ID is identity. GraphQL mutations use node IDs. Rename preserves a rule; deletion makes the reference unresolved; same-name recreation does not retarget it.

### Ruleset

A ruleset is an immutable repository revision. Publishing a policy or changing a rule updates the configured and active pointers in the same transaction. This does not request synchronization, scan existing items, or enqueue reconciliation. Draft saves do not change the ruleset.

Each rule has a stable ID, name, enabled state, issue or pull-request target, concrete or AI evaluator, and one or more existing label references. Validation rejects empty outputs, duplicate IDs, cross-repository labels, unresolved labels, incompatible predicates, and size-limit violations. For one entity kind, a label cannot be both concrete enforced and AI apply-only.

### Concrete evaluator

The first release uses a closed predicate set:

| Target       | Predicates                        |
| ------------ | --------------------------------- |
| Both         | title contains, author is         |
| Pull request | base branch is, draft state is    |
| Issue        | no issue-only predicate initially |

Equality and case-folding semantics are explicit. Negation, if added, uses separate typed operators rather than a general expression language. Publication is independent of snapshot readiness. Missing facts produce unknown evaluations until normal synchronization fetches them.

### AI evaluator

An AI rule contains a bounded instruction, allowed input fields, fixed user-selected labels, and an application-owned prompt-policy version. The provider receives a normalized qualified snapshot. It has no tools, credentials, arbitrary network access, mutation authority, or label-selection authority.

Provider output decodes to match or no-match with a short reason and cited field identifiers. Timeout, refusal, malformed output, provider error, or exhausted retries becomes indeterminate. AI no-match and indeterminate both preserve current labels.

Reuse a persisted decision only for the same rule, active revision, relevant-input fingerprint, provider identity and mode, immutable model version, prompt-policy version, and AI approval-policy revision. Store the decoded result, bounded sanitized reason, cited fields, latency, token use, error category, and retention state. Reasons must not quote private repository content.

Repository AI use requires explicit opt-in to an approved provider mode. Consent has `Enabled`, `Draining`, and `Disabled` states. An AI activity atomically acquires a bounded, fenced call lease only while consent is `Enabled`, then checks that lease immediately before the outbound request. Revocation moves consent to `Draining`, prevents new leases, and becomes `Disabled` after active leases finish or expire. A call that already holds a lease may still send data and cannot be recalled; the UI reports this boundary and draining progress. The UI also identifies the fields sent, provider, training-use policy, residency, subprocessors, and retention periods for provider and Janitor copies.

## Reconciliation

Given current synchronized labels, managed-label policy, and rule outcomes:

- add desired managed or apply-only labels not present;
- remove present concrete-managed labels that are conclusively undesired;
- preserve unmanaged labels, apply-only labels, and enforced labels with an indeterminate result.

Mutations use GraphQL `addLabelsToLabelable` and `removeLabelsFromLabelable` with node IDs. Janitor never uses replace-all or remove-all. Empty plans send no request.

GitHub mutation and workflow persistence cannot be atomic. The external commit may succeed before the Durable Object stores the activity result. Mutation activities are therefore at-least-once. Each attempt reloads or verifies current labels, excludes authorization errors, applies only the remaining set difference, and treats the desired already-present or already-absent state as success.

Before a non-empty mutation, the activity rechecks repository enabled state, global mutation-disable state, active rules revision, snapshot generation, covered journal sequence, relevant fingerprint, `Verified` status, verification age, and AI approval-policy revision. A mismatch returns a typed superseded result and requests targeted synchronization where needed. Consent revocation prevents queued calls that have not acquired a lease and supersedes queued plans. It cannot recall an already leased provider request. A GitHub-state race can still happen after the mutation check; label webhooks and repair restore convergence.

## Execution flow

### Snapshot handoff

Synchronization writes `SnapshotReady` and its outbox row in the same application-database transaction that publishes qualified freshness. The producing workflow follows that commit with a dispatch activity, and a Cron-woken singleton recovers overdue submission. Both use the same execution ID and equivalent payload.

The Cloudflare workflow engine uses first-payload-wins for duplicate execution IDs. Never reuse an ID with changed content. Workflow tag, payload, activity result, and orchestration changes are deployment contracts. Breaking changes get a new versioned tag while old registrations remain available for in-flight executions.

### Workflow activities

The workflow orchestrates serializable receipts. Stable activities are:

1. Load and qualify the synchronized snapshot and latest published rules revision.
2. Acquire and recheck a bounded AI call lease, then evaluate each AI rule under a stable activity name containing its rule ID. Evaluate concrete predicates purely over the loaded snapshot.
3. Aggregate decisions and persist the proposed plan.
4. Recheck fences and apply the remaining label set difference.
5. Record decisions, planned and observed mutations, warnings, and terminal status.

Activity-side application writes use workflow execution ID, activity name, and logical record identity as idempotency keys. AI provider calls and GitHub writes may repeat if their response is lost before activity-result persistence. Only persisted decisions and observed GitHub state are authoritative.

Long delays use uniquely named durable workflow clocks. Cloudflare stores clocks and activity results in the workflow execution's Durable Object SQLite. The application does not inspect or migrate this storage.

Expected reconciliation failures are typed outcomes. With default defect capture, a defect is a terminal stored failure and resubmitting its execution ID does not rerun it. Overdue application state and operator repair inspect that result and create a new attempt-keyed remediation execution after the defect is fixed. Application SQL records durable handoff and outcome; labeling does not depend on parent-child wake RPC.

### Rules changes and repair

Publishing a revision changes what subsequent evaluations use without initiating work. Normal webhooks and background synchronization still emit qualified snapshots. If publication overlaps an evaluation or a pending label-write attempt, the old plan is fenced and the entity is handed off to the latest revision.

Low-frequency synchronized repair covers webhook loss and mutation uncertainty. It respects the shared SQL rate budget and shows progress and typed failures in the UI. Auto-labeling neither paginates GitHub entities nor owns repair scheduling.

## Service boundaries

### Shared GitHub transport

The synchronization design owns the server-only App transport and SQL-backed rate budget. Auto-labeling uses it for node-ID label mutations and current-state verification inside mutation activities. Credentials never reach browsers, workflow payloads, snapshots, logs, or AI providers.

The conservative App permission set is Metadata read, Issues read/write, and Pull requests read/write. A sandbox permission test should determine whether pull-request write permission can be reduced while preserving GraphQL label mutations.

### Configuration API

The configuration API runs in the same backend Worker deployment and behind Cloudflare Access. It validates route-specific Access JWT audience, repository installation coverage, Origin, CSRF, and optimistic rules revision.

Initial operations load rules, list synchronized labels with freshness, save a complete ruleset, preview a draft against a qualified snapshot, request targeted refresh, and list reconciliation outcomes. Saving revalidates stable label identities. A stale expected revision returns a conflict and preserves the user's draft.

### Application persistence

Neon stores immutable rules revisions, managed-label state, current revision pointers, snapshots, reconciliation generations, decisions, plans, mutation audit, AI cache, usage, and privacy metadata. Effect workflow execution state remains in platform-owned Durable Object SQLite. These stores have separate migration and operational ownership.

## User interface

Repository settings show enabled or paused state, installation and permission health, snapshot freshness, active and configured revisions, and repair progress. Pausing explicitly leaves current labels intact.

The rule editor selects target before predicates, renders concrete predicates as "all", limits outputs to synchronized stable label references, and keeps missing references visible as errors. Enforced labels show the add/remove ownership warning. AI labels show apply-only behavior and privacy/cost disclosure.

Preview is an explicit action because AI may send content and incur cost. It uses a qualified snapshot and shows snapshot generation and age, draft revision, predicate and AI outcomes, additions, managed removals, preserved labels, indeterminate results, and provider/model/prompt-policy identity. Preview never mutates.

The Foldkit model represents loading, failure, clean, dirty, validation failure, saving, conflict, preview, synchronization, and reconciliation progress as explicit states. Saved state and editable draft remain separate. On conflict or refresh failure, preserve the draft and prior view while showing a recovery action.

## Observability and privacy

Search runs by workflow execution ID, repository, entity, snapshot generation, covered journal sequence, active rules revision, and AI approval-policy revision. Delivery ID remains useful ingestion context but is not reconciliation identity.

Record fingerprints rather than credentials, rule outcomes, planned and observed label changes, activity attempts, classified failures, GitHub request ID, AI model metadata and use, and retention status. Never log installation tokens, authorization headers, private keys, webhook secrets, raw private content, or unsanitized AI reasons.

Private snapshot fields follow the synchronization design's encryption, purge, crypto-erasure, and backup-expiry policy. AI copies have an explicit shorter policy where required. Uninstall or confirmed access loss stops mutation immediately and schedules content deletion while retaining only permitted identifiers and audit.

## Failure behavior

| Failure                                           | Result                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Duplicate `SnapshotReady` submission              | Same execution ID and payload join the first execution                               |
| Changed payload with reused execution ID          | Invalid producer behavior; first payload remains authoritative and telemetry alerts  |
| Snapshot becomes stale before evaluation          | Request targeted synchronization; no plan                                            |
| Snapshot changes before mutation                  | Return superseded; no mutation                                                       |
| GitHub accepts mutation before result persistence | Retry verifies state and applies only the remaining difference                       |
| AI succeeds before result persistence             | Call may repeat; persisted cache identity selects the authoritative decision         |
| AI consent enters `Draining`                      | No new call lease; already leased calls finish or expire before `Disabled`           |
| AI fails                                          | Indeterminate; no removal                                                            |
| Label was deleted                                 | Degraded configuration; no name-based substitution                                   |
| Installation is suspended or permission removed   | Block mutation and preserve existing labels                                          |
| Workflow DO is evicted                            | SQLite reactivates on alarm or contact                                               |
| Application database restarts                     | Activities resume from committed snapshot, outbox, decision, and audit state         |
| Deployment occurs in flight                       | Compatible registration and migration resume, or a versioned tag isolates the change |
| Captured execution defect                         | Stored terminal failure; a fixed deployment uses a new remediation execution key     |

## Verification strategy

Domain tests cover schema rejection, every concrete predicate, stable label identity, revisions, retirement, pause, and cross-kind ownership. Property tests prove unmanaged labels never enter removal, plans are idempotent, and OR/indeterminate aggregation preserves labels.

AI tests cover output decoding, injection attempts, unconfigured-label selection, timeout, refusal, malformed output, provider outage, repeated calls, cache identity, reason sanitization, and retention. No AI outcome may authorize removal.

Workflow and infrastructure tests cover:

- duplicate execution IDs and first-payload-wins;
- multiple deliveries converging to one snapshot generation;
- isolate eviction and workflow DO reactivation;
- alarms and two sequential durable clocks;
- GitHub success before activity-result persistence;
- snapshot verification age expiring during AI evaluation;
- AI opt-in revocation while provider work or mutation is queued;
- consent draining, call-lease expiry, and revocation after lease acquisition;
- repeated application-database writes after lost replies;
- application-database interruption and restart;
- immediate outbox dispatch plus Cron/singleton overdue recovery;
- deployment and Durable Object migration compatibility;
- captured-defect remediation with a new execution key;
- closed and merged entity retirement reconciliation.

API and UI tests cover Access audience and repository authorization, full synchronized label results, stale label save rejection, optimistic conflicts, no-mutation preview, explicit UI states, ownership warnings, AI disclosure, and preserved drafts.

Release invariants are:

1. Janitor never removes a label outside the active or revision-bound-retiring concrete-managed set for that repository and entity kind.
2. A stale, blocked, superseded, or policy-revision-mismatched plan never authorizes mutation. Revision-mismatched work is handed off to the latest configuration.
3. After inputs stop changing and retries and repair complete, enforced labels equal the latest resolved concrete decisions, apply-only labels include successful AI additions, and unmanaged labels remain unchanged.

## Delivery sequence

1. Pass the deployed Cloudflare Worker and Durable Object gate in the synchronization design.
2. Add qualified snapshot handoff, pure evaluation, persistence, and one pull-request base-branch rule with mutation disabled.
3. Add convergent node-ID mutation, audit, preview, configuration UI, retirement, and repair for concrete rules.
4. Add issue events and remaining concrete predicates only after their synchronized projection tracks are ready.
5. Add AI behind repository opt-in after privacy, cost, repeated-call, indeterminate, and retention gates pass.

The tracer is a concrete "pull request base branch is `main`" rule targeting one existing label. It exercises synchronized label discovery, revision publication, qualified snapshots, workflow submission, convergent mutation, and audit before AI adds another failure mode.

## Rejected alternatives

- Evaluate webhook payloads. Delayed and partial events are not qualified state.
- Key reconciliation by delivery ID. Deliveries converge through snapshot generation and active revision.
- Fetch GitHub during evaluation. Synchronization owns reads and qualification; only the mutation activity verifies external state as needed.
- Replace the complete label list. It can erase human or integration labels.
- Identify labels only by name. Rename and delete/recreate make names unsafe identities.
- Infer assignment ownership. GitHub cannot preserve that distinction across races.
- Treat AI failure as false. Outages would remove valid labels.
- Give AI tools or label choice. Classification does not require mutation authority.
- Use a general expression language. A closed predicate set is easier to validate, migrate, explain, and render.
- One permanent workflow per entity. Finite snapshot/revision executions have clearer deployment and supersession behavior.

## Primary risks

- The Effect Cloudflare integration is branch-only and unreleased.
- GitHub mutation and workflow persistence cannot be atomic.
- Large repositories make background synchronization and retirement scans expensive.
- Managed-label removal can surprise users unless the UI makes ownership explicit.
- AI introduces private-data handling, nondeterminism, cost, and provider outages.

## References

- Synchronization and execution infrastructure: [GitHub synchronization design](./github-synchronization-design.md)
- Effect branch: `eff-988-alchemy-cloudflare-cluster`, commit `f414380`
- Effect workflow definition: `packages/effect/src/unstable/workflow/Workflow.ts`
- Effect activity semantics: `packages/effect/src/unstable/workflow/Activity.ts`
- Effect Cloudflare workflow engine: `packages/platform/cloudflare/src/CloudflareWorkflowEngine.ts`
- Effect Alchemy integration: `packages/platform/cloudflare/src/AlchemyCloudflareCluster.ts`
- Internal workflow runtime/storage: `packages/platform/cloudflare/src/internal/workflowRuntime.ts` and `workflowStorage.ts`
- Effect Cloudflare README and changesets: `packages/platform/cloudflare/README.md`, `.changeset/cloudflare-cluster.md`, `.changeset/cloudflare-alchemy-cluster.md`
- GitHub label endpoints: <https://docs.github.com/en/rest/issues/labels>
- GitHub GraphQL label mutations: <https://docs.github.com/en/graphql/reference/mutations#addlabelstolabelable>
- GitHub App installation authentication: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-an-installation>
