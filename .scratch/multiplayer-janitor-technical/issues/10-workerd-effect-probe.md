# Verify the Workerd Effect SDK under Janitor's dependencies

Type: task
Labels: wayfinder:task
Status: resolved
Mode: AFK
Parent: ../map.md
Blocked by: 01, 02

## Question

Run the bounded local compatibility experiment needed before choosing the agent execution boundary. Can the pinned OpenCode V2 Workerd Effect SDK bundle under Janitor's toolchain, persist and reload a session, and preserve explicit queued delivery across host recreation?

Use the exact source/API identified by [Identify OpenCode V2's Effect APIs and runtime requirements](01-opencode-effect-apis.md) and the lifecycle constraints in [Establish Durable Object capabilities for agent execution](02-durable-object-feasibility.md). Work in an isolated throwaway checkout with a fake model and fake tool, no paid calls, no production deployment, no team repository execution, and no changes to the main package catalog.

Record package artifact provenance and the dependency graph actually used. Test the existing Janitor Effect pin first; if incompatible, identify the smallest controlled alignment experiment and record its effect rather than silently upgrading the project. Exercise session creation and reload with local Durable Object SQLite, two inputs queued while a turn is active, event-cursor replay, failed tool/error reporting, and usage projection. Include a return-early request and host recreation case, distinguishing local observations from production eviction guarantees.

Record commands, observed results, limitations, and artifact/branch pointers. A failed probe is useful evidence; do not expand this task into the complete runtime, repository sandbox, Slack adapter, or production architecture. The task unblocks a hosting decision and resolves when its findings are concrete enough to compare options, not only when the preferred approach succeeds.

## Answer

Completed the bounded local experiment. [Workerd Effect SDK compatibility experiment](../research/workerd-effect-probe.md) records provenance, commands, executed results, and limitations. Executable fixtures, dependency lockfiles, and result logs live on branch `probe/workerd-effect-sdk` at commit `962bcde`, in `tools/workerd-probe/`. The disposable checkout is `/tmp/janitor-workerd-probe`. The working Janitor branch's application dependencies are unchanged.

The public Workerd SDK creates and reloads sessions using real local Durable Object SQLite. With the same Workerd replacements and an injected fake model/tool, ordinary queued delivery, return-before-completion admission, cursor replay, explicit tool errors, and synthetic input-token projection work locally. An active-turn run also passes using Janitor's exact installed Workerd binary.

Two findings constrain the next decisions:

- Janitor's Effect snapshot and OpenCode's registry release share a version label but have different Config APIs. The unchanged graph emits missing-export warnings even though fake execution passes. Changing only Effect fails on the snapshot platform package's `effect/ByteSize` import. Aligning Effect and both Node platform packages to upstream `4.0.0-rc.112` passes the bounded bundle/runtime checks, but that release lacks uppercase Config APIs Janitor uses. This is evidence for a dependency boundary or adaptation decision, not permission to downgrade the application.
- Restart retains queued inputs in FIFO order, adds a synthetic restart notice, and resumes execution after a new request boots the SDK. It admits the first queued input into the resumed turn before the interrupted turn has finished. The initial stronger expectation failed and is preserved in the evidence; the final probe records the difference explicitly.

Local process recreation does not prove production eviction, automatic wakeup, provider-stream liveness without requests, real repository execution, or exactly-once external effects. Those remain part of [Choose the agent execution and hosting boundary](03-execution-boundary.md), [Decide session state ownership and recovery](04-session-durability.md), and [Decide repository access and workspace isolation](05-repository-execution.md). No architecture is selected by this task.
