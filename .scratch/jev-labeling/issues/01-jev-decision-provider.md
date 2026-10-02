# 01: Jev decision provider

**Status:** ready-for-agent

**Completion:** implemented 2026-10-02; not yet reviewed or deployed.

**Blocked by:** None (can start immediately).

**What to build:** Replace the labeling `LanguageModel` path with `OpenRouterDecisionModel` behind `ClassifierProvider`.

- [x] Add `@effect/ai-openrouter` to the `pnpm-workspace.yaml` catalog at the pinned snapshot commit (`7c5525a6…`) and to `apps/cluster/package.json`. Remove `@effect/ai-openai-compat` from both; labeling is its last user.
- [x] Build the `Decision.make` definition from a list of rules, with two probability questions per rule (`rN_matches`, `rN_sufficient`) over a state namespaced by rule (`{ rN: { evidence, omissions } }`). Put it in `Labeling/Classifier.ts` or a new `Labeling/Decision.ts`.
- [x] Change `ClassifierProvider` to the batch-shaped `decide(rules)`, which returns `{ matches, sufficient }` for each rule (see the spec's provider seam). Replace `fromLanguageModel` with `fromDecisionModel`, using a 15 s timeout. Until ticket 03, the classifier sends a one-rule batch.
- [x] Wire `Worker.ts` with `OpenRouterDecisionModel.layer({ model })` and `OpenRouterClient.layer({ apiKey })` from `OPENROUTER_API_KEY`. The identity is `openrouter` plus the model. Remove `OPENAI_API_KEY` and `OPENAI_API_URL` from labeling config.
- [x] Make `inputBytes` measure the decisions request instead of chat framing. Drop `SYSTEM_INSTRUCTIONS` from the labeling path.
- [x] Rewrite `providerErrorMessage` for the new variables and decision errors.
- [x] Rewrite `test/Labeling/AiProviderInput.test.ts` against a fake HTTP client that returns Decisions API JSON. Cover:
  - rounded probabilities such as `0.02/0.93/0.04`
  - a missing answer for one rule's question, which should produce `InvalidOutputError`
  - a request with several rules, checking the question keys and the namespaced state on the wire
  - 401, 429 with `retry-after`, and 400
- [x] Update every `ClassifierProvider` stub to the new answer shape: `Classifier.test.ts` (`ProviderStub`), `AiEvaluationResults.test.ts`, `AiEvaluationRetries.test.ts`, `Evaluation.test.ts`, `ResultActions.test.ts`, `ResultActionApi.test.ts`, `Groups.test.ts`, `GroupsApi.test.ts` and `AiResultCache.test.ts`. `Classifier.test.ts:461` should expect `OPENROUTER_API_KEY`.

## Comments

2026-10-02: Implemented on branch t3code/ca4f15cc. `@effect/ai-openrouter` replaces `@effect/ai-openai-compat` at the pinned snapshot. `ClassifierProvider.decide(queries)` answers `{ matches, sufficient }` per rule; `fromDecisionModel` builds one `Decision.make` of `probability` questions from `classifierRequest` (`packages/domain/src/Labeling/Policy/AiInput.ts`), which owns the question wording, the `{{fact:x}}` → `state.rN.evidence.x` rewrite and the namespaced state. `Worker.ts` wires `OpenRouterDecisionModel` and `OpenRouterClient` from `OPENROUTER_API_KEY`, identity `openrouter` plus `LABELING_AI_MODEL` (default `typesafe/jev-1.13`). `SYSTEM_INSTRUCTIONS` is gone; `AiInputDetails.text` is the single-rule request as sent (`system` removed; older stored rule tests still decode). Error messages name the new variables and treat HTTP 402 as exhausted credit. Effect reports an invalid decision answer as retryable, so it is retried like a timeout. `test/Labeling/AiProviderInput.test.ts` covers the byte budget, the wire shape for two rules, a missing answer, 401/400/402/429/500 and Retry-After.
