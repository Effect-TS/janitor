# Establish Durable Object capabilities for agent execution

Type: research
Labels: wayfinder:research
Status: resolved
Assignee: maxwellbrown
Parent: ../map.md
Blocked by: none

## Question

What can a Durable Object directly host for this agent workflow, and which responsibilities would require another execution environment?

Use current first-party Cloudflare documentation and relevant source. Cover JavaScript and Node compatibility, filesystem semantics, child processes and shell/git execution, local database APIs, long-running asynchronous work, event delivery, restart/eviction and persistence, outbound calls, alarms, and streaming connections. Distinguish a Workers-compatible SDK or orchestration client from the coding-agent runtime and its tools.

Describe supported Cloudflare execution companions only where they address concrete limitations, keeping their control and data boundaries explicit. Record hard constraints separately from untested compatibility. Supply a capability matrix usable alongside the OpenCode investigation; do not assume that source imports alone prove runtime compatibility, or choose the final hosting architecture.

## Answer

OpenCode V2's pinned Workerd Effect profile supports a direct Durable Object agent loop with DO SQLite and durable event recovery. Its local filesystem, process, search and PTY services are deliberately unavailable, and VCS/snapshot services degrade to no-op results. Repository execution needs a companion or verified replacement services. Cloudflare Sandbox is one documented companion, but its container files are not durable across stop/restart.

The capability matrix also covers current Node compatibility, request lifetimes, event interleaving, alarms, outbound calls, streaming and the existing Effect cluster deployment. DO `waitUntil` does not extend lifetime; return-early work and recovery need an explicit feasibility test. This is primary-documentation and pinned-source evidence, not an executed compatibility test or final architecture selection.

Research artifact: [Durable Object capabilities for Janitor](../research/durable-object-runtime.md).

Context pointer: branch `research/janitor-durable-object-runtime`, commit `c32f412`, file `.scratch/multiplayer-janitor-technical/research/durable-object-runtime.md`. OpenCode revision `2df00955cb933e977427535d2505e50cbc689c69`; research date 2026-09-11.
