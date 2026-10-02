# Labeling uses a decision model

Status: accepted.

AI labeling rules ask TypeSafe's Jev 1.13 (`typesafe/jev-1.13`) through OpenRouter's Decisions API, using Effect's `DecisionModel`, instead of asking a chat model for a structured answer. A rule's question is a yes-or-no judgement, and Jev answers it with calibrated probabilities, takes no system prompt and does not follow instructions found in evidence. Input costs USD 0.042 per million tokens, output is free, and a request answers in about half a second.

Each rule asks two probability questions about its own evidence: whether the item satisfies the prompt, and whether the evidence is enough to decide. Below one half for sufficiency the result is unknown, preserving labels as missing facts already do. Otherwise the probability of a match is compared with the rule's minimum confidence. A separate sufficiency question keeps "cannot tell" from diluting the match probability, which a single three-way choice would.

All of an item's AI rules that need an answer share one request. The state is namespaced by rule (`state.r0`, `state.r1`, …) and each question names its slice, so a rule is still only given the facts its prompt references. Rules are packed into as few requests as Jev's 32k-token context allows, each under one lease. One invalid answer or failed request fails every rule in it; rules still settle individually through the cache, claims and the decision record.

Jev returns no explanation. Janitor records a fixed reason such as `matches 0.93 · evidence sufficient 0.97` and stores the probabilities alongside the decision.

`OPENROUTER_API_KEY` is the deployment's only AI credential, and `LABELING_AI_MODEL` defaults to `typesafe/jev-1.13`. The model id is pinned rather than `~typesafe/jev-latest` because consent and the decision cache key on it. Consent given for the earlier chat model was carried over by migration rather than asked for again.

The Decisions API is an alpha OpenRouter surface and Effect marks decision support unstable; both may change under us. Jev may answer a rule differently when other rules' evidence shares its request, while the rule tester sends one rule at a time, so production and test answers can differ slightly.
