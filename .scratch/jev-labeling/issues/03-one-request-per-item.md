# 03: One request per item

**Status:** ready-for-agent

**Completion:** implemented 2026-10-02; not yet reviewed or deployed.

**Blocked by:** 02

**What to build:** Send all of an issue's or pull request's uncached AI rules to Jev in one Decisions request, instead of one request per rule. See "One request per item" in the spec.

- [x] Split `AiClassifier.classify` (`apps/cluster/src/Labeling/Classifier.ts:470-750`) into three steps:
  - **prepare** runs per rule: gate policy, missing evidence, consent, provider identity, input rendering, evidence hash, cache lookup and claim.
  - **decide** runs once per batch: lease, provider call and retries.
  - **record** runs per rule: outcome mapping and the `labeling_ai_decision` write.
- [x] Have `evaluateLabeling` (`apps/cluster/src/Labeling/Evaluation.ts:33-53`) prepare every enabled AI rule, send the rules that still need an answer in as few requests as the size limit allows, then record each result. Non-AI rules are evaluated as they are now.
- [x] Pack rules in configuration order into requests under a fixed byte limit derived from Jev's limits: 32k tokens for the state plus the longest question, and 64k per request. A rule that exceeds the limit alone is already rejected by the per-rule input budget.
- [x] Take one lease per request. Apply retry guidance to the request, and fail or retry every rule in it together.
- [x] Rules whose claim belongs to another worker wait for that worker's decision outside the batch, as they do now.
- [x] Have `Labeling/Test.ts` use the same path with one rule per item.
- [x] Tests:
  - Three uncached AI rules on one item make one provider call.
  - Cached rules, rules blocked by their gate, and rules with missing evidence stay out of the request.
  - Rules that exceed the byte limit are split across requests.
  - A failed request marks every rule in it `failed`.
  - A retried request counts one attempt per request. (Covered only by the existing single-rule retry tests.)
  - Labeling groups still freeze when any rule in the batch is unknown or failed. (Covered by the existing group tests, which now run through the batched path.)

## Comments

2026-10-02: Implemented on branch t3code/ca4f15cc. `AiClassifier.classifyMany` groups inputs by repository, prepares each rule (applicability, evidence, consent, provider, rendering, hashes), claims and checks the cache per rule under one claim owner, packs misses with `packRequests` under `MAX_REQUEST_BYTES = 80_000`, and runs each request under one lease with shared retries before recording one decision per rule. Rules whose claim another worker holds join after the requests. `classify` is a one-element `classifyMany`; `classifyAiMany` is the service-optional wrapper. `evaluateLabeling` now sends all enabled AI rules of an item through one `classifyAiMany` call. The rule tester still evaluates one rule per item. Tests: `JevDecisions.test.ts` (three uncached rules in one request with cached, gated and missing-evidence rules left out; oversized rules split), `Evaluation.test.ts` (one request for two AI rules; a failing request fails both rules).
