# Labeling with Jev 1.13 through OpenRouter

Status: needs-triage

## Goal

AI labeling rules stop using an OpenAI-compatible chat model through `LanguageModel.generateObject`. They use TypeSafe's decision model Jev 1.13 (`typesafe/jev-1.13`) through OpenRouter's Decisions API, by way of Effect's `DecisionModel` service. Labeling is the only AI feature left on `main` (issue review and Slack sessions were removed in #92), so after this change Janitor has no chat-model code and no `@effect/ai-openai-compat` dependency.

## What exists today

- `ClassifierProvider` (`apps/cluster/src/Labeling/Classifier.ts:117`) takes one rendered string and returns `{ matches: boolean | null, confidence, reason }`.
- `fromLanguageModel` (`Classifier.ts:125`) calls `generateObject` with `SYSTEM_INSTRUCTIONS` (`packages/domain/src/Labeling/Policy/AiInput.ts:7`) and a JSON user message `{ instructions, evidence, omissions }`, with a 60 s timeout.
- Each AI labeling rule asks one yes/no question about one label. Picking between labels happens in labeling groups, not in the model.
- Outcome mapping (`Classifier.ts:702`): `matches: null` gives `unknown` (`insufficient-evidence`). A match at or above `minimumConfidence` gives `match`. Anything else gives `no-match`, with `low-confidence` when the confidence is below the threshold.
- `Worker.ts:186-208` wires `OpenAiLanguageModel` and `OpenAiClient` from `OPENAI_API_KEY`, `OPENAI_API_URL` and `LABELING_AI_MODEL` (default `gpt-5.6-luna`), with the provider identity hard-coded to `"openai"`.
- The free-text `reason` is required by the schema, stored in `labeling_ai_decision.reason TEXT NOT NULL`, and shown in the rule editor and activity views.

## What the platform gives us

- **Effect core.** The pinned snapshot (`7c5525a6…`) already includes `effect/ai/Decision` and `effect/ai/DecisionModel`. `Decision.make({ input, decisions })` combines an input schema with named `classify`, `rate` or `probability` decisions. `DecisionModel.decide` encodes the input as JSON and validates the answers, so labels must exist, distributions must sum to 1, and values must fall in `[0, 1]`. Failures come back as `AiError`.
- **Effect provider.** `@effect/ai-openrouter` ships `OpenRouterDecisionModel.layer({ model })`, and pkg.pr.new publishes it for the same snapshot commit. It maps:
  - `Classify` to `choice`
  - `Rate` to `score`
  - `Probability` to `noul`

  It sets `probabilityPrecision: 2`, so Jev's two-decimal rounding is rescaled instead of rejected. It drops `usage.cost`.

- **Jev on OpenRouter.**
  - Endpoint: `POST https://openrouter.ai/api/alpha/decisions`, authenticated with an ordinary OpenRouter key.
  - Context limit: 32k tokens for the state plus the longest question.
  - Pricing: USD 0.042 per million input tokens, with no charge for output.
  - Latency: roughly 350–550 ms.
  - Output: no text. A choice answer is `{ choice, confidence, probabilities }`.
  - The endpoint is labelled **alpha**.

## Design

### Decision definition

Each AI rule asks two `Decision.probability` questions about its own evidence:

```ts
{
  [`${key}_matches`]: Decision.probability({
    instructions: rulePrompt, // {{fact:x}} references resolved against state[key].evidence
    criteria: { true: "The issue or pull request satisfies the instructions", false: "It does not" },
  }),
  [`${key}_sufficient`]: Decision.probability({
    instructions: `Does state.${key} contain enough evidence to answer: ${rulePrompt}`,
    criteria: { true: "The supplied evidence settles the question", false: "It cannot be settled from the supplied evidence" },
  }),
}
```

`key` is a short positional id such as `r0`, assigned when the request is built; rule ids are UUIDs. Keeping sufficiency in its own question means "not enough evidence" doesn't use up probability that would otherwise go to `matches`. The rule prompt becomes the instructions, and each rule's evidence and omissions list go into `state[key]`. The untrusted-evidence rule from `SYSTEM_INSTRUCTIONS` has nowhere to go: Jev takes no system prompt and doesn't follow instructions found in the state.

### One request per item

`evaluateLabeling` (`apps/cluster/src/Labeling/Evaluation.ts:33-53`) currently evaluates rules one at a time and makes one request per AI rule. Under this plan, every AI rule that still needs an answer for an issue or pull request goes into a single Decisions request.

1. **Prepare each rule on its own.** As today, check the gate policy, missing evidence, consent, provider identity, input rendering, evidence hash, cache and claim (`Classifier.ts:470-640`). Rules settled at this step (not applicable, unknown, cache hits, or rules waiting on another worker's claim) don't go in the request.
2. **Decide once.** The state is `{ r0: { evidence, omissions }, r1: { … } }`, and the request carries two questions per rule. Namespacing by rule keeps the domain rule that a rule is given only the facts its prompt references; its questions point at `state.rN` only. Facts shared between rules are repeated, which costs little at USD 0.042 per million input tokens.
3. **Record per rule.** Map each pair of answers to an outcome and write one `labeling_ai_decision` row per rule, so caching and the rule tester still work per rule.

Constraints:

- **Size.** Jev allows 32k tokens for the state plus the longest question and 64k per request. Pack rules in order into requests of at most 80,000 bytes (`MAX_REQUEST_BYTES`), which leaves room for tokenizer variance at three or more bytes per token, and start a new request when the next rule doesn't fit. At the default per-rule budget of 16 KB, five rules at full size share a request; typical rules are far smaller.
- **Leases.** Take one lease per request instead of one per rule. The hourly limit of 100 then counts requests.
- **Failures.** `DecisionModel.decide` validates every answer, so one invalid answer fails the whole request. A failed or retried request fails or retries every rule in it. Retry guidance (`retry-after`, three attempts in 240 s) applies to the request.
- **Rule tester.** `Labeling/Test.ts` evaluates one rule against many items. Each item has its own state, so it sends a request with one rule per item.

### Outcome mapping

- If `P(sufficient) < 0.5`, the outcome is `unknown` (`insufficient-evidence`). The 0.5 cutoff is a constant, not a per-rule setting.
- Otherwise, if `P(matches) >= minimumConfidence`, the outcome is `match`.
- Otherwise the outcome is `no-match`. When `0.5 <= P(matches) < minimumConfidence`, the reason code is `low-confidence`.
- Stored `confidence` is `P(matches)`, a calibrated probability rather than the model's own estimate of its confidence.

### Reason text

Jev returns no explanation. Janitor writes a fixed-format reason from the answers, for example `matches 0.93 · evidence sufficient 0.97`. The column stays `NOT NULL`, and the existing prefixes (`Insufficient evidence:`, `confidence … below …:`, `Recovered after …`) still work. A new nullable `probabilities jsonb` column on `labeling_ai_decision` stores `{ matches, sufficient }`, so the UI can show the numbers without parsing text.

### Provider seam

The `ClassifierProvider` interface changes from `ask(prompt: string) => ClassifierAnswer` to a batch shape from the start:

```ts
decide(rules: ReadonlyArray<{ instructions: string; evidence: unknown; omissions: unknown }>)
  => Effect<ReadonlyArray<{ matches: number; sufficient: number }>, ClassifierProviderError>
```

- `fromDecisionModel(identity)` replaces `fromLanguageModel`. It builds one `Decision.make` definition per call from the rules it receives and requires `DecisionModel.DecisionModel`.
- Test stubs keep using `Layer.succeed(ClassifierProvider, …)`. They answer per rule and record each request's size, so tests can check the batching.

### Cache and consent

- Bump `decisionVersion` from 3 to 4, so cached chat-model answers expire.
- Provider identity becomes `{ provider: "openrouter", model: "typesafe/jev-1.13" }`. Pin that id; don't use `~typesafe/jev-latest`, because consent and the cache key both depend on the model id.
- Consent carries over. Migration `0055` rewrites the provider and model on existing `labeling_ai_consent` rows to `openrouter` / `typesafe/jev-1.13`, so repositories with AI access enabled stay enabled. The "AI provider changed" check (`Classifier.ts:496-501`) stays, so a later model change still needs either another migration like this one or re-enabling. Deploying with a `LABELING_AI_MODEL` other than the migrated id makes every AI rule unknown until consent is enabled again.

### Configuration

| Variable                           | Change                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`, `OPENAI_API_URL` | Remove                                                                                                                                                                                                |
| `OPENROUTER_API_KEY`               | Add as a redacted secret. It is the deployment's single OpenRouter credential, for labeling now and any later OpenRouter feature. When it's absent, labeling uses the existing `unavailable` provider |
| `LABELING_AI_MODEL`                | Keep. Default becomes `typesafe/jev-1.13`                                                                                                                                                             |

Other configuration changes:

- Reduce the request timeout from 60 s to 15 s.
- Drop `max_completion_tokens`.
- Adjust `inputBytes` (`AiInput.ts:11`), which reserves space for chat framing, to measure `{ state, questions }` instead.

### Error messages

Rewrite `providerErrorMessage` so it names `OPENROUTER_API_KEY` and `LABELING_AI_MODEL` and drops any mention of "structured responses". `InvalidOutputError` now means "Jev returned an invalid decision", for example an unknown label or probabilities that don't sum to 1. The retry logic stays as it is.

## Settled decisions

- 2026-10-02: one `OPENROUTER_API_KEY` for the whole deployment, not a labeling-specific key.
- 2026-10-02: keep the unknown result, using two probability questions per rule (matches and sufficient evidence) rather than a three-way classify or a single probability.
- 2026-10-02: send all of an item's uncached AI rules in one request, split only to stay under Jev's size limits.
- 2026-10-02: existing AI consent carries over to Jev. Repositories are not asked to re-enable it.

## Risks

- `/api/alpha/decisions` is an alpha surface, and `@effect/ai-openrouter` decision support is marked `@stability unstable`.
- `GET /api/v1/models` lists `typesafe/jev-router` but not `typesafe/jev-1.13`. Confirm the model id with a live call before cutover.
- Rules written as chat instructions ("explain…", multi-step reasoning) may score poorly as Jev instructions. Run the rule test tool against sample issues before deploying.
- Jev documents English as its most accurate language.
- Each rule's minimum confidence (default 0.8) was set against the chat model's own rating of its confidence. The same number from Jev is a probability, so a rule may match more or less often after the switch. Ticket 05 compares match rates before and after.
- Batching means one bad answer or one slow request affects every AI rule for that item. Today each rule fails on its own.
- Jev may answer one rule's questions differently when other rules' evidence is in the same state. Each question names its `state.rN` slice, but that isn't enforced. The rule tester sends one rule per request, so it can disagree with production. Compare the two during cutover.

## Out of scope

- Per-rule model choice.

## Tickets

- [01 Jev decision provider](issues/01-jev-decision-provider.md)
- [02 Decision outcome and storage](issues/02-decision-outcome-and-storage.md)
- [03 One request per item](issues/03-one-request-per-item.md)
- [04 UI and documentation](issues/04-ui-and-documentation.md)
- [05 Cutover](issues/05-cutover.md)

## Sources

- `effect/ai/DecisionModel.ts` and `Decision.ts` in the pinned snapshot
- [OpenRouterDecisionModel.ts](https://github.com/Effect-TS/effect/blob/main/packages/ai/openrouter/src/OpenRouterDecisionModel.ts)
- [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev)
- [How to use Jev](https://openrouter.ai/blog/tutorials/how-to-use-jev/)
- [Jev Decisions API limits](https://dryhurst.io/articles/jev-openrouter-decisions-api/)
