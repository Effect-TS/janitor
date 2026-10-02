# 04: UI and documentation

**Status:** ready-for-agent

**Completion:** implemented 2026-10-02; not yet reviewed or deployed.

**Blocked by:** 02

**What to build:** Show decision probabilities where the UI showed model reasons, and document the new model.

- [x] Carry `probabilities` on the labeling wire (`apps/web/src/components/labeling-wire.ts`). In `rule-editor.ts:1212-1218`, show the distribution instead of free-text reasoning.
- [x] Update the consent copy in `workspace.ts` (lines 997, 2003 and 2073-2076) so it reads `openrouter · typesafe/jev-1.13` and says that evidence goes to OpenRouter and TypeSafe.
- [x] Update the sample copy in `design-system.ts:719` and the fixtures in `workspace.test.ts`.
- [x] In `CONTEXT.md`, update "AI provider and model" and "Minimum confidence" (now a calibrated probability), and note that AI results carry no model explanation.
- [x] Add ADR 0013, "Labeling uses a decision model": why Jev over a chat model, the two questions per rule (matches and sufficient evidence), one request per item with evidence namespaced by rule, losing explanations, and the alpha API risk.
- [x] Update the labeling section of `.env.example` (lines 37-45): `OPENROUTER_API_KEY` replaces `OPENAI_API_KEY` and `OPENAI_API_URL`.

## Comments

2026-10-02: Implemented on branch t3code/ca4f15cc. The web wire carries `probabilities`; the rule editor shows `match N% · evidence sufficient N%` and the reason without its numeric summary; the input inspector pretty-prints the sent request. Consent copy reads `<model> through <provider>`. Design-system sample, `workspace.test.ts` and `Ingress/Rules.test.ts` fixtures updated. `CONTEXT.md` updates AI provider and model, minimum confidence and unknown result, and adds sufficient evidence. ADR 0013 records the decision. `.env.example` and `README.md` name `OPENROUTER_API_KEY`.
