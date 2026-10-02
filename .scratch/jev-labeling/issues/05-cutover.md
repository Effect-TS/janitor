# 05: Cutover

**Status:** ready-for-human

**Blocked by:** 01, 02, 03, 04

**What to do:** Provision the new key, confirm Jev works for real rules, and deploy. AI consent carries over through migration `0055`.

- [ ] Create an OpenRouter key with a spend cap. Store it as `OPENROUTER_API_KEY` in the Infisical `janitor` project (production and development).
- [ ] Send a live `POST /api/alpha/decisions` request with `typesafe/jev-1.13` to confirm the model id and the response shape.
- [ ] Run the rule test tool on production AI rules against sample issues. Compare the tester's one-rule answers with the batched answers from real evaluations.
- [ ] Deploy. Delete `OPENAI_API_KEY` and `OPENAI_API_URL` from Infisical, plus `AGENT_RUNNER_MODEL_API_KEY` and `CHAT_MODEL` if #92 left them behind.
- [ ] Check that `LABELING_AI_MODEL` is unset or `typesafe/jev-1.13`, so it matches the migrated consent rows.
- [ ] After deploy, compare each rule's match rate with the week before. If one changed sharply, adjust that rule's minimum confidence. Watch the `failed` and `unknown` rates and Jev usage.

## Comments
