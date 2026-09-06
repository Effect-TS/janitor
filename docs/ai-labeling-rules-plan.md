# AI labeling rules implementation plan

Status: proposed implementation, September 6, 2026. No application or production changes are included in this plan.

## Recommendation

Implement the [inline-facts prompt document](mockups/11e-ai-inline-facts.html) as the AI variant of the existing rule editor. A rule manages one GitHub label, asks one question, and references its evidence with `{{fact:...}}`. Only existing catalog facts are supported. PR diff and source-code retrieval are deferred; `{{fact:diff}}` remains an unsupported reference.

Reuse the existing classifier, policy-version storage, configuration revisions, consent, workflow dispatcher, and label planner. Evaluate a bounded set of available snapshot facts with one structured model call. Keep AI evaluation outside repository inventory sync. No new GitHub content-fetching service or artifact storage is needed.

An AI rule can add its label after a confident match. Negative, uncertain, incomplete, and failed evaluations preserve existing labels. Confidence is a model-reported score, not a calibrated probability of correctness.

## What already exists

| Area            | Current implementation                                                                                                                                                                            | Work needed                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Classifier      | `apps/cluster/src/Labeling/Classifier.ts` has structured boolean/confidence/reason output, a 60-second provider timeout, consent leases, decision caching, and an unavailable-provider fallback.  | Preserve structured decision metadata; prevent duplicate calls; add evidence completeness checks and request budgets.                                              |
| Prompt language | `packages/domain/src/Labeling/Policy/Prompt.ts` parses `{{fact:title}}` and substitutes JSON values. It requires a separately declared evidence list and caps rendered text at 40,000 characters. | Derive evidence from references for the new API; share parsing with autocomplete; separate unavailable evidence from empty values; budget tokens as well as bytes. |
| Evaluation      | Classifiers already participate in policy testing and entity reconciliation. Rules enforce `preserve` for classifier misses.                                                                      | Add direct AI-rule CRUD and draft-rule tests without making the browser orchestrate policy creation/publication/binding.                                           |
| GitHub data     | `RefreshEntity.ts` retrieves required collections. Changed files retain path/status only, with a 300-file local cap and a completeness flag.                                                      | Preserve readiness and completeness in the AI evidence path. Reuse existing fact retrieval; no patch or source-code fetching.                                      |
| UI              | Rule table, flow editor, item selector, CodeMirror integration for policies, and contextual YAML completion exist.                                                                                | Add an AI editor mode using the approved mockup and the existing editor integration.                                                                               |

Specific correctness gaps to address during implementation:

- `renderPrompt` currently substitutes `null` for absent facts. AI evaluation must stop with an explicit unavailable-evidence result rather than asking the model to infer an answer from missing data.
- `entityFacts` constructs collection facts from available collection arrays. Propagate collection readiness/completeness through the AI path; an unfetched or truncated array is not an empty, complete collection.
- Decision lookup precedes consent checking. Establish a consistent product contract: when AI is disabled, neither cached nor new AI decisions may initiate new label actions. Check consent before cache use and again at the label-action boundary.
- A cache miss followed by `INSERT ... ON CONFLICT DO NOTHING` does not prevent two concurrent paid calls. Coordinate in-flight evaluation by request hash.
- Returned evaluations lose the structured confidence stored in the decision table. Do not parse display strings such as “(cached)” to build the UI.
- Reconciliation currently evaluates rules serially. Deduplicate identical policy/evidence requests and use a small bounded concurrency for independent AI work, preserving the existing aggregate group planner.

## Research retained for this scope

CodeRabbit's published cost-engineering account describes rate limits and caching to reduce repeated model work. Adopt bounded evaluation and exact-input reuse here. Its summarization and code-review machinery are not required for this release. [CodeRabbit cost engineering, December 2023](https://www.coderabbit.ai/blog/how-we-built-cost-effective-generative-ai-application)

Greptile documents repository graph indexing for code context. That addresses a broader review task and is outside this implementation. [Greptile graph-based context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)

## UI

Use the current rules table and routes. Add a Policy/AI type choice when creating a rule; keep the type fixed after creation initially. Derive the table badge from the actual evaluator, including existing rules bound to classifier policies.

For an AI rule:

- Keep label and target above the prompt, Enable beside Back to rules, conditional Save/Cancel above the test bench, and Delete beneath the test controls.
- Use CodeMirror with a plain-text prompt mode and decorated fact references. Build on `components/policy-source/editor.ts`; do not ship the mockup's imperative textarea handlers into Foldkit.
- Autocomplete opens after `{{` or `{{fact:`. Offer names, descriptions, types, target compatibility, and availability. Arrow keys navigate, Enter/Tab inserts, Escape dismisses. Preserve ordinary indentation when completion is closed, undo/redo, paste, and caret position.
- Reference parsing is shared with the API. Support repeated references but count unique facts; enforce the existing 4,000-character prompt and eight-fact limits. Highlight malformed, unknown, and target-incompatible references at their source ranges.
- No evidence checkboxes or separate editable evidence list. `{{fact:changedFiles}}` means names/statuses, not file contents. Autocomplete offers only supported facts and explains their types.
- Keep the revised confidence card and presets. Store 0–1 on the wire and show 0–100%. Add concise help explaining that the score is model-reported.
- If AI access is disabled, link to the repository setting; do not silently enable it.
- Test an explicitly selected PR or issue using unsaved values. Show queued, gathering evidence, evaluating, complete, blocked, and failed states. Editing invalidates the displayed result; late responses cannot overwrite a newer draft.
- The result shows Match/No match/Unknown, confidence when available, the label action, a short explanation, snapshot identity, and evidence availability. Keep source details in a disclosure. Do not restore the standalone Test configuration screen.
- For exclusive groups, distinguish the tested rule's own decision from the group's final label plan. Existing labels can remain because AI rules preserve labels; do not imply exclusive groups automatically remove old AI labels.

Implement state and asynchronous commands through Foldkit's existing Model/Message/update structure and the existing editor effect seam. Share stateless field rendering with policy rules where useful; avoid a new general-purpose form framework.

## Domain, persistence, and API

### One rule editing operation

Keep one public rules resource, with a discriminated definition:

```ts
type RuleDefinition =
  | { type: "policy"; policyId: string; onNoMatch: "preserve" | "ensure-absent" }
  | { type: "ai"; target: "issue" | "pull_request"; prompt: string; minimumConfidence: number }

// Existing labelId, enabled, group, priority, and optimistic version remain.
```

The exact schemas should follow the repository's Effect Schema conventions. The AI branch always normalizes to `onNoMatch: "preserve"`; reject attempts to override this.

Internally, give a directly authored AI rule one explicitly owned classifier policy. Reuse immutable policy versions and configuration snapshots rather than adding a second evaluator/version system. This requires a real ownership invariant, not a naming convention:

- Create the owned policy, initial version, rule, configuration revision, and outbox work in one database transaction.
- Saving an edited AI definition creates a new immutable classifier version and advances the rule/configuration atomically. A metadata-only or enable-only change does not create a new classifier version.
- The rule's optimistic version guards the whole operation. Return a conflict with the current representation on concurrent edits. Use the same revision lock/order as existing configuration mutations.
- Owned policies are excluded from the reusable policy list and cannot be edited or bound independently. Rule deletion retires the owned policy; retain historical versions required by snapshots/audit and clean them up under the existing retention rules.
- Existing rules using a shared classifier policy remain supported and read as AI type, but editing the shared classifier stays an explicit policy action. Do not silently take ownership or change every bound rule. Offer copy-to-owned as a separate later operation if needed.
- Saving is immediate database work. Evaluation and activation are asynchronous and must not gate the HTTP response or depend on a repository sync completing.

This trades a small ownership rule for reuse of the existing compile, activation, version, and reconciliation machinery. It avoids a browser sequence of create-policy → publish → create-rule with partial failures.

### Endpoint changes

Paths below are relative to `/api/v1/repositories/:repositoryId` and extend the existing ingress/service split.

| Endpoint                           | Behavior                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /rules`, `GET /rules/:ruleId` | Include type and full editable definition on detail, version, and concise capabilities. Keep list payloads compact.                |
| `POST /rules`                      | Accept a policy or AI definition. Validate, derive evidence, and save atomically. Support an idempotency key for creation retries. |
| `PATCH /rules/:ruleId`             | Optimistic update; partial metadata changes remain supported. A supplied definition is replaced atomically, not partially merged.  |
| `DELETE /rules/:ruleId`            | Preserve version checking and retire owned classifier state in the same transaction.                                               |
| `POST /rules/validate`             | Pure validation of an unsaved definition; return field/source diagnostics and derived requirements. No GitHub/provider work.       |
| `POST /rule-tests`                 | Validate an unsaved definition plus one selected item, create a bounded test job, return `202` with its ID. No label mutations.    |
| `GET /rule-tests/:testId`          | Return job progress and the final typed result. Scope lookup to the connected repository and authenticated operator.               |

Reuse the existing test service's compile/planning logic and workflow dispatcher for test jobs. Keep existing policy-test endpoints compatible. Do not build a second queue system. Return a retry interval and stop polling on terminal states; use bounded polling with backoff. Client cancellation stops polling; the server job remains bounded and its decision may be reusable.

Retain compatibility for existing policy-rule request shapes during rollout. Extend the fact catalog response used by the UI with completion metadata and resolution source, rather than maintaining a handwritten browser catalog.

Return structured error codes for invalid references, unavailable facts, consent disabled, provider unavailable, stale snapshot, incomplete evidence, size limit, and rate limit. A valid request with unavailable evidence produces Unknown/blocked, not a fabricated No match or an undifferentiated 500.

## Evidence strategy

Resolve prompt references from the existing fact catalog and entity snapshot. Use the existing required-track mechanism for collection facts. Rule saves return immediately; missing or stale evidence produces a clear pending/Unknown test state while existing refresh work catches up. Do not invoke AI as part of repository inventory sync.

`{{fact:changedFiles}}` provides file paths and statuses only. It cannot establish what code changed. Prompts requiring source-code inspection may be unanswerable with the available facts; the classifier must be able to return insufficient evidence.

Before calling the provider, verify that every referenced fact is available, fresh enough, and complete. Distinguish an empty collection from an unfetched or truncated collection. A PR exceeding the current changed-file collection cap returns Unknown only for rules that require that incomplete fact; title/body-only rules can still run.

```text
Prompt references
    → validate and derive existing fact requirements
    → read snapshot facts and check readiness/completeness
    → render bounded evidence
    → structured classifier call
    → recheck snapshot, configuration, consent, and rule status
    → existing label planner and reconciliation
```

Proposed starting budgets, to tune against fixtures before production automation:

| Resource          | Initial bound                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Prompt            | Existing 4,000-character limit                                                                                 |
| Referenced facts  | Existing eight-unique-fact limit                                                                               |
| Rendered input    | Existing 40,000-character cap plus a 12,000-model-token cap; also respect the model's context/output reserve   |
| Model output      | 1,000 tokens with a bounded reason                                                                             |
| Provider deadline | 60 seconds per attempt; at most two attempts within a 120-second evaluation deadline                           |
| Concurrency       | Two model calls per repository initially and a configurable global cap; reserve capacity for interactive tests |

Oversized or incomplete evidence returns Unknown without silently truncating input. Do not introduce diff downloads, patch storage, source citations, base-SHA fetching, repository cloning, or related-file retrieval as dependencies of this release.

## Reliability, privacy, and cost

- Hash the normalized prompt, unique fact values and completeness, provider/model identity, rendering version, and threshold. Store typed confidence, outcome, reason, usage, latency, evidence availability, and cache status. Exact evidence identity determines reuse; do not use semantic similarity caching for label actions.
- Use a database-backed in-flight claim with expiry/ownership fencing around identical classification work. Await/reuse the same computation from a test and automation where inputs match. A unique cache row alone is insufficient. Do not promise exactly-once billing across provider timeouts; bound retry exposure.
- Never log rendered prompts, raw fact values, tokens, or provider credentials. Reasons can contain repository content too; treat them as repository content for authorization and purge. Disconnect and consent revocation prevent new model work; active work follows the existing lease/draining contract.
- Keep untrusted issue/PR fact values separate from operator instructions. JSON escaping and system instructions reduce ambiguity but are not a security boundary. The classifier has no network, shell, or label-write tools; structured output alone cannot execute an action.
- Add an explicit insufficient-evidence answer to the provider schema, rather than forcing every model response to be boolean. The server, not the model, enforces completeness, thresholds, permission, and label identity.
- Retry transient rate-limit/5xx failures with bounded backoff and Retry-After. Permission failures, invalid input, and oversized evidence are terminal for that revision. Do not let an unavailable provider generate endless UI “running” states.
- Coalesce rapid pushes into the newest requested generation. Keep AI evaluation outside installation inventory sync. Reuse existing outbox/dispatcher recovery and recheck current state before label writes.
- Set per-repository and global token/request budgets. Record cache hits, duplicate suppression, queue time, provider time, retries, unknown reasons, evidence availability, stale-result rejection, and estimated usage cost. Rule saves and repository connections remain independent of this work.

## Delivery sequence and acceptance checks

1. **Domain and correctness foundations.** Shared reference parser and diagnostics; derived evidence; explicit evidence completeness; typed classifier metadata; insufficient-evidence schema; consent/cache ordering; request deduplication. Test malformed/repeated tokens, target restrictions, empty versus missing facts, prompt injection fixtures, and cache invalidation.
2. **Atomic API and ownership.** Implement the definition union, owned-policy invariants, transaction boundaries, optimistic conflicts, idempotent creation, and migration compatibility. Test rollback between every logical write, shared-policy isolation, historical snapshots after deletion, and stable save/enable behavior while sync is paused.
3. **Snapshot evidence readiness.** Propagate fact availability, freshness, and collection completeness through the classifier. Test unavailable collections, truncated changed-file lists, empty values, oversized prompts, and snapshot changes during evaluation. Confirm title/body-only rules do not wait for unrelated collection tracks.
4. **UI and asynchronous test bench.** Implement the approved editor and table type, integrate reference completion with Foldkit/CodeMirror, and expose test-job progress. Test keyboard editing, dirty/save/cancel, restored focus, conflict handling, stale responses, terminal polling, and the one-item/no-label-mutation test contract.
5. **Automation and measurement.** Route both manual and automatic evaluation through the same snapshot-evidence/classifier path, retain planner/group semantics, and enforce final revision/consent checks. Test duplicate webhooks, concurrent tests and automation, reconnect/disconnect, consent revocation, disabled rules, and deployment recovery during a call.
6. **Controlled production rollout.** Deploy additive migrations and backward-compatible API first, then UI. Keep new AI automation off by default. Configure and verify the provider explicitly; test existing consent behavior. Measure in test-only mode on an agreed pilot repository before enabling one narrow rule. Enable further rules only after reviewing false positives, unknown outcomes, latency, and cost.

Initial acceptance targets: metadata saves remain sub-second apart from network latency; cached tests finish within two seconds; ordinary fact-based tests target p95 under 30 seconds, with every job terminal within its configured deadline. These are measurement targets, not current guarantees. Run a labeled fixture set containing issue categorization, documentation labels, author/label-based context, misleading PR descriptions, missing or truncated facts, and questions that cannot be answered without code. Report precision/recall and abstention separately; a higher slider setting must not be advertised as a guaranteed accuracy rate.

Run the project's dependency checks, `vp check`, `vp test`, frontend build, and Worker bundle check. Rehearse migration and rollback compatibility. Production rollback disables AI automation and restores compatible code; it does not destroy evidence, audit, or policy history.
