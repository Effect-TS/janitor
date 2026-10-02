# 02: Decision outcome and storage

**Status:** ready-for-agent

**Completion:** implemented 2026-10-02; not yet reviewed or deployed.

**Blocked by:** 01

**What to build:** Map Jev answers to labeling outcomes and persist the probability distribution.

- [x] Map outcomes:
  - `P(sufficient) < 0.5` gives `unknown` (`insufficient-evidence`).
  - Otherwise, `P(matches) >= minimumConfidence` gives `match`.
  - Otherwise the outcome is `no-match`, with `low-confidence` when `0.5 <= P(matches) < minimumConfidence`.
- [x] Store `confidence` as `P(matches)`. Generate the fixed-format reason text and keep the existing prefixes.
- [x] Add migration `0055` with a nullable `probabilities jsonb` column (`{ matches, sufficient }`) on `labeling_ai_decision`. Write it on insert and read it back from the cache.
- [x] In the same migration, update `labeling_ai_consent` rows to `provider = 'openrouter'`, `model = 'typesafe/jev-1.13'`, whatever their state, so enabled repositories stay enabled.
- [x] Bump `decisionVersion` to 4.
- [x] Rewrite the `ClassifierEvaluator` comment (`packages/domain/src/Labeling/Policy/Program.ts:41-44`). It says the classifier asks a language model, and that low confidence gives `unknown`; the code gives `no-match`.
- [x] Update `Classifier.test.ts`, `AiResultCache.test.ts`, `AiEvaluationResults.test.ts` and `Evaluation.test.ts` for the new mapping, the version bump and the consent carry-over. Include a test that a migrated consent row matches the new provider identity.

## Comments

2026-10-02: Implemented on branch t3code/ca4f15cc. `decisionOutcome` in `Classifier.ts` maps the two probabilities (sufficiency cutoff `SUFFICIENT_EVIDENCE = 0.5`). Migration `0055_jev_decisions.sql` adds `labeling_ai_decision.probabilities` and rewrites every consent row to `openrouter` / `typesafe/jev-1.13`; documented in `apps/cluster/migrations/README.md`. `decisionVersion` is 4 and `INPUT_VERSION` is 4. `Evaluation` gains optional `probabilities`. Note: `labeling_ai_decision.confidence` is a single-precision column, so cached confidences are approximate; the exact values are in `probabilities`. Tests: `test/Labeling/JevDecisions.test.ts` (mapping, migration carry-over) plus updated stubs across the labeling tests via `answer`, `answerEach`, `insufficient` and `queryText` in `test/Labeling/support.ts`.
