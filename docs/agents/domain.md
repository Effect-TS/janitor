# Domain docs

This repo uses a single-context layout:

- `CONTEXT.md` at the repo root holds domain terminology.
- `docs/adr/` holds architectural decisions.

## Before exploring

Read `CONTEXT.md` and ADRs relevant to the area you are working in.

If these files do not exist, proceed silently. The `domain-modeling` skill creates them when terms or decisions are resolved.

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in issues, proposals, hypotheses, and tests.

If a needed concept is missing, check existing code terminology and note genuine gaps for `domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify that ADR and explain why the decision should be reconsidered.
