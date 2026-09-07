# AI rule test progress and input handling

## Findings

The initial “Evaluating…” label is premature. `ClickedTest` in `rule-editor.ts` creates a `Running` state without a status; the view treats every status other than `queued` as evaluating. The API correctly acknowledges asynchronous tests as queued, producing the visible reversal.

`AiClassifier.classify` rejects input before calling the provider when the rendered prompt exceeds 12,000 UTF-8 bytes. `renderPrompt` separately enforces 40,000 characters. Neither path shortens input or reports which fact caused the overflow. Decision results currently expose a free-text reason rather than structured input diagnostics.

Read-only production inspection on September 7, 2026 found that the `Effect-TS/effect` bug rule references `title` and `body`. Its prompt is 1,703 characters. PR #7908 has a 15-byte title and a 10,470-byte body; JSON encoding grows the body to 10,872 bytes. Substitution produces roughly 12.6 KB, just above the application cap. This is an application budget rejection, not an observed provider context-window error.

The rule also instructs the model to use changed-file patches as primary evidence. No patches are supplied. Diff support remains out of scope; that instruction needs an editorial correction, or the model can legitimately report insufficient evidence after the budget problem is fixed. Do not silently change or publish the production rule.

## 1. Stable, truthful progress

- Show one stable primary label, **Testing…**, from click until completion.
- Use a smaller secondary phase: **Submitting → Queued → Evaluating**. Show Evaluating only after the server reports `running`. For tests that finish immediately, go directly to the result.
- Replace the optional string status with explicit typed phases. Retain test ID and generation so responses from a previous test cannot affect the current one. Terminal results cannot regress to queued/running; delayed observations cannot move an observed running job back to queued.
- Show elapsed time during a long wait and a useful queue explanation after a short grace period. Do not invent progress percentages or an estimated completion time.
- Keep the durable job and existing polling transport. Return completed results directly when available. Retry transient polling failures with bounded backoff against a wall-clock deadline; distinguish “Unable to check progress” from a job that actually failed. Do not enqueue another paid evaluation just because a poll failed.

This is a small UI/state correction; it does not require SSE, WebSockets, or replacing the job queue.

## 2. Prepare input once, within a clear budget

Introduce a pure `prepareClassifierInput` function shared by tests and automatic labeling. It returns either a prepared request plus an input report, or a typed reason that evaluation cannot proceed.

Use one documented, server-configurable UTF-8 input budget instead of unrelated rendered-character and byte limits. Start with a modest 16,000-byte budget, accounting for system instructions and message framing as well as the user prompt and evidence. Verify the final provider request size in tests. This should let #7908 use its full description without loss; verify that against the actual provider envelope before rollout. A larger provider context window is not a reason to send unlimited data.

Keep the existing authoring limit for the rule's instructions. Never truncate the author's instructions, change the gate policy, or lower the confidence threshold to make input fit. If the instructions and required overhead alone consume the budget, return an actionable validation error.

Preparation order:

1. Include only referenced facts. Send each distinct fact once in a clearly separated evidence block, preserving `{{fact:...}}` references in the instructions as references to that block. Explain this mapping to the model. Repeated references should not duplicate large values.
2. Preserve all evidence when it fits. Do not strip code blocks, logs, links, or prose merely because they look noisy; these can contain the evidence needed to classify a bug.
3. If still oversized, retain small facts such as title, author, branch, and flags in full. Allocate the remaining space across large referenced facts using a deterministic policy, with a minimum share so the first large fact cannot crowd out the rest.
4. Shorten long text at paragraph or line boundaries, retaining both the beginning and end. Mark each omitted range explicitly. Keep collection values as valid structured data, dropping whole entries rather than slicing serialized JSON. Account for the omission markers themselves and verify the final UTF-8 size. Preserve complete Unicode characters.
5. Tell the model which evidence is incomplete and to return insufficient evidence when the retained context cannot support the decision. Trimming is not permission to guess. Retain current label-preservation behavior for unknown outcomes.

Do not add an AI summarization pass or automatically retry with a larger paid model. Both add cost, latency, and another source of interpretation. Deterministic preparation plus one classification call is the first implementation.

## 3. Make omissions inspectable

Keep the normal result compact. When nothing was omitted, show a collapsed **AI input · Complete** disclosure. When shortening occurred, show an amber **AI input shortened** notice alongside the result, independently of match/no-match/unknown.

The disclosure should contain:

- Facts supplied, original and supplied sizes, and total request size versus budget.
- A row per shortened fact, including omitted character or entry counts and the exact source ranges.
- **View sent input** and **View omitted content**, showing the snapshot used for this test. A link to the current PR is useful but is not a substitute for the tested snapshot, which may have changed.
- Clear empty states: a missing fact is unavailable, an unreferenced fact was not requested, and a shortened fact was partially omitted. These are different conditions.

Example copy: “Description shortened to fit the AI input limit. 3 paragraphs omitted. Review AI input.” Counts must come from the preparation report, not model-generated prose.

Use **Insufficient evidence** for a model that cannot decide. For a request that was never sent, show **Could not evaluate** with the specific cause and action: shorten instructions, supply a missing fact, configure a provider, or retry after a temporary service limit. Preserve the machine-level `unknown` outcome where needed for label planning; improve its presentation rather than creating another labeling outcome.

The input report should remain visible even if the provider fails after preparation, and cached results should retain the same report. Do not present a shortened-context result as a full-context decision.

## 4. Carry diagnostics through the API and cache

- Add optional structured input diagnostics to `Evaluation` and the test response: preparation version, completion status, original/supplied bytes, budget, per-fact sizes, and omitted ranges/counts. Use reason codes for input rejection, missing evidence, provider failure, and insufficient confidence instead of parsing prose.
- Persist compact input reports with AI decisions and return them on cache hits. Include preparation version, configured budget, final provider input, original evidence hash, and model identity in the cache identity. This prevents reuse across different omission strategies and keeps the report tied to the right source.
- Retain the exact evidence snapshot needed to reconstruct sent and omitted input for the existing test-result lifetime. Store source once with the omission manifest, not separate copies of every excerpt. Large diagnostic content should be fetched only when the disclosure is expanded.
- Reuse the existing authenticated repository API and encrypted payload storage where practical. Apply repository access checks, TTL cleanup, and disconnect/purge handling. Do not put source bodies or omitted text in application logs.
- Bound retained diagnostic size separately from provider input size. If an exact inspectable snapshot cannot be retained within that limit, return an explicit input-too-large result rather than silently discarding evidence that the UI promises can be inspected. Expired diagnostics must say they expired rather than substituting a newer PR body.

Additive fields allow old cached decisions to keep working. Show “Input details unavailable for this earlier result” for historical records; do not invent a report or rerun a paid evaluation just to fill it in.

## 5. Correct the production rule's evidence expectations

Prepare a proposed edit to the bug rule that bases its question on the referenced title and description, removing the requirement to inspect patches. Surface the supplied-fact list in the input disclosure so this mismatch is visible. Do not attempt to infer required facts from arbitrary prose with brittle keyword validation.

Test the proposed prompt separately and have its owner review it before publication. A budget fix should not silently alter an existing rule's classification criteria. Do not make a matching result for #7908 a success condition; success means that the model evaluates the intended available evidence and explains its decision.

## Implementation and acceptance

Implement in separate commits: progress state; pure input preparation and tests; API/cache diagnostics and bounded snapshot retention; input disclosure and actionable result messages. Then validate against production data without changing repository labels.

Acceptance checks:

- No Evaluating → Queued reversal, no terminal-state regression, no stale-test overwrite, and no duplicate provider call after polling failure.
- #7908 no longer fails solely because it crossed the old 12 KB limit. Confirm whether it fits losslessly after all request overhead is counted.
- Oversized text and collections stay within budget; repeated references, JSON escaping, multibyte text, and boundary-sized prompts are covered. Author instructions and small required facts remain intact.
- The UI reproduces the exact sent/omitted content for the test snapshot, including after a cache hit, and explains expired or unavailable diagnostics.
- Missing or insufficient evidence still preserves labels. Verify gate rejection makes no provider call. A provider failure still displays any preparation warnings.
- Measure preparation time, serialized request bytes, input/output token usage reported by the provider, queue wait, and evaluation duration. One normal evaluation should require at most one provider call; cache hits require none.

The user subsequently authorized implementation and deployment. Production rule edits and patch support remain separate work.

## Implemented behavior

Preparation uses a 16,000-byte default, configurable with `LABELING_AI_INPUT_BYTES` between 4,000 and 64,000. The budget counts UTF-8 encoded messages plus a 1,024-byte reserve for the response schema and provider framing. A provider integration test verifies the actual serialized request fits this estimate.

A read-only copy of the production bug rule and PR #7908 fits losslessly at 14,725 budgeted bytes. Preparation took about 1.6 ms locally. This proves the size rejection is resolved, not that the rule must classify this PR as a bug.

Tests retain the original referenced evidence in the existing repository-scoped test row for its five-minute lifetime, with a separate 128,000-byte source limit. Polls omit this content. The input endpoint returns the saved snapshot on demand and refuses expired results. The existing cleanup and repository purge remove it. Automatic decisions retain only the compact report. No new storage service or summarization call is needed.

For a proposed title-and-description-only rule, the owner can replace the patch requirement with:

> Determine whether this pull request fixes a defect in existing behavior using {{fact:title}} and {{fact:body}}. Look for a described failure and its correction. Distinguish bug fixes from new features, refactoring, and maintenance. Do not assume access to code or patches. Return insufficient evidence if the supplied title and description cannot establish whether a defect is being fixed.

This is a proposal for review, not an edit to the production rule. Its existing instructions may still yield insufficient evidence because they request patches.
