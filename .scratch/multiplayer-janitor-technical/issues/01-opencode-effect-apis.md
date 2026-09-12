# Identify OpenCode V2's Effect APIs and runtime requirements

Type: research
Labels: wayfinder:research
Status: resolved
Parent: ../map.md
Blocked by: none

## Question

Which exact OpenCode V2 source and Effect SDK APIs can support the accepted shared-session workflow, and what environment do they require?

Find and pin primary source revisions or official package versions. Distinguish Effect-native APIs from generated clients and internal services. Identify how to create or reopen sessions, submit ordinary messages, observe working state and tool activity, receive errors and token usage, and handle input arriving during an active turn. Establish what is public/supported versus internal or evolving.

Trace filesystem, process execution, git, database, networking, model-provider, and Effect-version dependencies far enough to support a hosting decision. Identify which services can be provided or replaced through Effect layers. Record unknowns rather than inventing a stable V2 contract. Supply evidence for [Choose the agent execution and hosting boundary](03-execution-boundary.md), not an architecture verdict.

## Answer

Resolved by source inspection on 2026-09-11. OpenCode's `v2` branch at `2df00955cb933e977427535d2505e50cbc689c69` exports the requested embedded Effect SDK, including `@opencode/sdk/workerd/effect`. Its session API already supports explicit `delivery: "queue"`; the default is `steer`, so the adapter must choose queue to match the accepted product behavior. Typed events, durable session-log cursors, errors and token usage are available.

The source supplies a Workerd replacement graph, but a usable repository execution environment still needs a decision and validation. OpenCode pins Effect `4.0.0-rc.112`; compatibility with Janitor's current prerelease pin is untested. These are research findings, not a hosting selection. The linked note specifies required no-paid-model build, persistence, recovery and tool experiments.

Context: [OpenCode V2 Effect SDK findings](../research/opencode-v2-effect.md). Research branch `research/janitor-opencode-v2-effect`, commit `436365e`, worktree `/tmp/janitor-opencode-v2-effect-research`. No production code or live platform state was changed.
