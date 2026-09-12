# Decide model configuration and credential ownership

Type: grilling
Labels: wayfinder:grilling
Status: resolved
Parent: ../map.md
Blocked by: 03, 11

## Question

How does the independently deployed runner select and authenticate its MVP model provider, and what configuration must the implementation spec require?

Use the preference for inexpensive open-weight models through team-funded APIs. Decide the provider/model baseline or an explicit deployment-time selection contract, who owns credentials, how secrets reach the runner without entering conversation or workspace checkpoints, and whether configuration changes affect existing sessions or only new work. Define required streaming, tool-call, usage and timeout compatibility checks for the selected native transport. The lifecycle fixture used simulated HTTP responses and did not establish real-provider compatibility.

Keep personal subscriptions, monetary dashboards and configurable spending controls outside MVP scope. Obtain primary provider evidence before proposing provider-specific settings. Do not provision credentials or make paid model calls as part of this decision.

## Comments

### First discussion round

Claimed the named ticket. The team-funded API direction and preference for inexpensive open-weight models remain accepted inputs. No particular provider/model has been selected, and simulated lifecycle model responses do not establish provider compatibility.

Two initial preferences are pending: one deployment-configured default for new sessions versus a teammate-facing model choice; and deployment-operator credential management versus a Janitor admin settings flow. Recommend one deployment default and operator-managed runner-only secrets. Exact provider/model selection may be a deployment-time contract with compatibility checks required before launch. These are proposals, not accepted decisions.

[Cloudflare secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/) describes runtime secret bindings. The proposed design keeps model keys out of conversation records, repository workspaces, checkpoint archives and platform output. The factual review will check how the pinned SDK receives credentials before specifying that boundary.

After the first round, decide how model changes affect existing sessions, credential rotation and unavailable models, then specify compatibility checks for streaming, tool calls, usage and failure handling. No credentials were provisioned and no paid model calls were made.

Initial local inspection distinguishes the existing labeling configuration in `apps/cluster/src/Labeling/Classifier.ts` from the independently pinned runner. The runner fixture uses a native model route with simulated HTTP responses, but replaces model resolution and supplies test capability/context metadata. It does not verify production catalog selection. Its accepted five-minute model inactivity deadline, native retry scheduling, and recorded usage semantics remain constraints on any chosen provider. Provider compatibility is not implied by the labeling client or fake-model tests.

### Accepted deployment default and credential ownership

The user selected one deployment default for new agent sessions, with the exact provider/model selected and compatibility-tested before launch. Deployment operators own the team-funded credentials, provided only to the runner as Cloudflare secrets. No teammate-facing model picker or dashboard credential-management flow is included in the MVP. The existing labeling provider/model remains a separate concept and configuration.

The pinned native route supports runtime authentication through `Auth` credential effects, including bearer credentials. The lifecycle fixture uses `OpenAIChat.route` and a fake HTTP client, disables catalog fetching, and replaces `SessionRunnerModel.resolve` with fixture capabilities and context/output limits. Production model metadata, catalog or embedding selection, and compaction must therefore be specified and validated before launch; none are established by the fake-provider tests. Source revision and dependency pins remain those in the hosting decision.

Next pending choice: keep existing sessions on their selected provider/model when the deployment default changes, or adopt the new default at a future turn boundary. Recommend keeping existing sessions pinned, independently rotating credentials for their provider. Retain the old configuration while sessions need it, and expose unavailable configuration rather than silently changing providers. This recommendation remains unaccepted.

### Accepted model continuity

The user confirmed existing sessions retain their selected provider/model when the deployment default changes; only new sessions adopt the new default. Credential rotation is independent of model selection. Retain the configuration needed by existing sessions. Pin an explicit provider/model reference rather than allowing those sessions to resolve an unspecified current default on restart. A provider alias does not guarantee immutable underlying model weights.

Pinned source inspection confirms `SessionRunnerModel.resolve` uses the default only when `session.model` is absent, and resolves explicit references or returns unavailable errors otherwise. `Auth.effect` loads redacted credentials during request authentication. Use runtime runner secrets through that seam; do not persist key values in session state or workspace checkpoints. Secret updates take effect through deployment/runtime activation, not a promise of instantaneous rotation in already-running requests.

Remaining proposed failure policy: native retries handle temporary provider errors under the accepted supervision limits. Missing/revoked credentials or an unavailable selected model produce a visible execution error while retaining session data and workspace. Do not silently select another provider/model or add indefinite retries. Operators can restore the selected configuration; permanent model retirement requires new work on a supported model, with existing-session migration deferred. Exact recovery of an interrupted turn remains native OpenCode behavior. This policy awaits user confirmation.

### Accepted failure policy

The user confirmed visible errors with preserved session/workspace state, native retries for temporary failures, no silent model substitution, and operator restoration of the selected configuration. If a model is permanently retired, use a new session with a supported model; migration of existing sessions is deferred.

## Answer

### Selection and configuration

Use one operator-configured default for new agent sessions. Choose the exact team-funded provider/model at deployment time, favoring inexpensive open-weight models, and validate it before launch. No provider is selected by this ticket and no provider compatibility is claimed. The existing AI labeling configuration is independent. No teammate model picker, personal subscription connection, or dashboard credential settings are included.

Maintain explicit, versioned model configuration records. Each record contains a stable configuration ID, provider identity, provider API model ID, native route/transport, endpoint, optional variant/settings, supported input/output and tool capabilities, documented context/output limits, compaction policy, and a credential binding reference. Records contain no key values or authentication headers. One configuration ID is the default for new sessions. Keep older records available while existing sessions reference them. Changing a route, endpoint, model, limits or behavior settings creates a new record; credential rotation preserves the record and reference. Do not rely on automatic catalog refresh to change these settings.

At session creation, durably select the default configuration ID with the explicit native model reference before the first model request. Preserve that selection through queued inputs, later turns and recovery. A change to the deployment default affects only new sessions. Model identifiers pin the requested provider/model, not immutable weights behind a provider-managed alias.

Use the pinned SDK's explicit embedding seam, `SessionRunnerModel.resolved`, behind a real resolver backed by those configuration records. Resolve the session's selected record or return a configuration error. Construct the native route with its verified provider API model ID and runtime authentication; expose stable selected identities for durable records and observation. Do not ship the fixture's mocked resolver, fake capability limits or simulated HTTP client. This chooses an explicit deployment configuration over a changing remote model catalog. Keep SDK-native local compaction as the MVP baseline, with the selected session model and accurate limits; provider-specific compaction is not required. A provider requiring a different transport or compaction policy needs a verified configuration before use.

### Credentials

Deployment operators own team-funded provider credentials and supply them only to the runner through Cloudflare Worker secret bindings. Use the pinned native `Auth` credential-loading seam to resolve the binding at request authentication time. Fail for a missing credential instead of falling back to a developer login, personal subscription, workspace environment or unrelated labeling key.

Persist only a binding reference. Keep key values out of Janitor-to-runner commands, conversation state, tool arguments, Sandbox environment, repository files, checkpoints, dashboard projections and platform replies. Redact request headers and credential-bearing errors in diagnostics. A redacted wrapper is not a substitute for checking serialization paths.

Rotate the binding through the runner deployment process without changing the selected model or copying keys into each session. Updated runtime instances use the new binding; already-running requests may have used the prior value. Coordinate overlapping key validity and rollout where the provider permits it. Deployment activation and rollback details belong to [Decide runner upgrade and deployment compatibility](17-upgrade-compatibility.md). No instantaneous global rotation guarantee is implied.

### Failures and restoration

Temporary provider errors follow native OpenCode retry classification and scheduling under the accepted five-minute response-inactivity deadline. Do not add whole-turn retries, indefinite configuration retries or silent provider/model fallback. Preserve normal tool and conversation behavior and the separate execution/delivery states.

Missing or invalid credentials, an unavailable selected model, or invalid model metadata produce an actionable execution error while retaining the conversation and workspace. Report it in the originating platform when delivery is available and in Janitor's existing observation state, without exposing secrets. Restoring the original configuration permits subsequent work using native session behavior. Restoration does not itself invent a new instruction or automatically replay a terminally failed turn. Existing durable recoverable work follows the accepted runner recovery rules.

If the selected model is permanently unavailable, the MVP requires a new session with a supported model. Do not silently transplant conversation or workspace state. Existing-session model migration is deferred.

### Required implementation and launch checks

Before enabling a chosen deployment configuration, record primary provider documentation for its exact endpoint, authentication, model identity, limits and supported features. Validate the complete native configuration with the isolated runner dependency versions and Workerd runtime, not the existing labeling client or only the fake-model fixture.

- Exercise real streaming text, incremental tool-call arguments, multiple tool calls and tool results followed by further model output. Validate the actual tools' schemas and native conversation serialization. Unsupported input types must not be advertised.
- Verify accurate context/output metadata, output termination and native local compaction with retained tool history. Ensure compaction uses the pinned session configuration and does not select an implicit auxiliary default.
- Verify recorded input/output, cache and reasoning usage normalization where reported. Preserve the accepted distinction between normalized zero and unavailable usage; do not estimate missing charges or claim billing completeness.
- Exercise initial-response and mid-stream inactivity, disconnects, authentication errors, missing models and retryable failures through controlled transport tests. Check native retry timing and cancellation without flooding the real provider. Include a real-provider smoke test for successful streaming/tool use and returned usage.
- Verify missing secrets fail clearly, credential rotation changes authentication without changing session selection, and no credentials reach persisted state, repository execution or user-visible errors.
- Restart and change the deployment default with existing sessions and queued inputs. Existing sessions retain their exact configuration; new sessions receive the new default. Retiring a required record must produce an explicit error rather than fallback.

These checks are implementation acceptance requirements, not executed results. Any real paid smoke test requires its own bounded authorization when the provider and credentials are available. This planning ticket provisions no credentials and makes no paid calls.

### Evidence and handoff

Pinned source at revision `2df00955cb933e977427535d2505e50cbc689c69` establishes the embedding and authentication seams in `packages/core/src/session/runner/model.ts` and `packages/ai/src/route/auth.ts`. `packages/core/src/model-resolver.ts` distinguishes provider API identity from selected identity and documents local compaction when provider compaction is omitted. The [runner fixture](../prototype/runner-fixture/worker.mjs) demonstrates the native route under simulated responses, with model resolution replaced. It does not establish real-provider readiness. [Cloudflare secret documentation](https://developers.cloudflare.com/workers/configuration/secrets/) establishes runtime bindings and version/deployment behavior for secret changes.

Carry the configuration record, credential activation and old-record retention requirements into the upgrade decision and the final implementation spec. No new product choice remains in this ticket; provider selection is explicitly a deployment-time responsibility subject to launch validation.
