# Workerd Effect SDK compatibility experiment

The pinned V2 SDK can run an embedded conversation loop in local Durable Object SQLite with Janitor's Effect snapshot. That result is narrower than compatibility with the full application. The bundle contains unresolved Effect Config APIs, and recovery admits a queued input into the resumed turn before the interrupted turn has finished.

## Provenance and reproduction

- Janitor base commit `2af7d1b`; disposable branch `probe/workerd-effect-sdk` at `962bcde`, checkout `/tmp/janitor-workerd-probe`.
- OpenCode V2 source commit `2df00955cb933e977427535d2505e50cbc689c69` from `anomalyco/opencode`. The SDK and core manifests report `1.18.4`. This is extracted source, not an assumed equivalent registry beta.
- `prepare-source.mjs` extracts twelve workspace packages at that commit. It removes dev scripts/dependencies and optional UI peers from their manifests and resolves the upstream catalog. Runtime TypeScript is unchanged. The fixture separately includes upstream `@tsconfig/bun@1.0.9` for Vite's TS transform. `results/source.json` records extraction details.
- Current Effect is Janitor's `ec83cbdb3c0b0f89df627a7895939a359db9f4ab` pkg.pr.new snapshot. The manifest says `4.0.0-rc.112`; it differs from that registry release. The committed lockfile and `results/graph-current.json` record actual package paths.
- Vite+ `0.3.0`, Node `24.19.0`, Miniflare `4.20260708.0`, bundled Workerd `1.20260708.1`; local compatibility date `2026-07-04` with `nodejs_compat`. Janitor's previously installed Workerd is `1.20260704.1`, so the initial tests do not use precisely that binary. The aligned active-turn check was also rerun with Janitor's exact `1.20260704.1` binary through `MINIFLARE_WORKERD_PATH` and passed.

The branch README contains commands. Request the probe workspace dependency closure when installing:

```sh
node tools/workerd-probe/prepare-source.mjs /path/to/opencode-clone
vp install --filter '@janitor/workerd-probe...' --ignore-scripts --no-frozen-lockfile
vp run --filter @janitor/workerd-probe bundle
vp run --filter @janitor/workerd-probe probe
vp run --filter @janitor/workerd-probe active
vp run --filter @janitor/workerd-probe recovery
node tools/workerd-probe/graph.mjs
```

`probe` uses the public `OpenCodeWorkerd.layer` with `models.fetch: false` and prompt `resume: false`. The execution checks call `OpenCode.create` with `ServerWorkerd.serverOptions` and every `ServerWorkerd.replacements` entry, plus the upstream TestLLM and model-resolution overrides. That is the Workerd execution profile with test injection; the public factory has no arbitrary override option. A plugin adds `probe_failure`, which returns a known `Tool.Error`. No model provider, credentials, repository checkout, real command execution, or deployment is involved.

## Observed results under Janitor's Effect snapshot

| Check                            | Observation                                                                                                                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve pinned source with Vite+ | Pass after explicit text loading, Workerd/browser export conditions, and a CommonJS builtin require shim. The fake-model bundle is about 17.7 MB uncompressed and 3.21 MB gzip. This is an unminified test bundle, not a deployability measurement. |
| Effect API compatibility         | Incomplete. Rolldown warns that `Config.string` and `Config.redacted` are undefined in imported paths. Direct inspection confirms the missing exports. Fake-model execution bypasses those provider/auth paths.                                     |
| Public factory and SQLite        | Health, session creation, two queued admissions, session reload after SDK disposal, and reload after full local runtime restart pass.                                                                                                               |
| Return before work completes     | Prompt admission returns while the fake model is held at a gate. Two later requests are admitted with `delivery: "queue"`.                                                                                                                          |
| Uninterrupted turn ordering      | Initial input is delivered first. Each queued input waits for the previous turn's `finish: "stop"`. Four model requests cover the fake tool attempt, its follow-up, and the two queued turns.                                                       |
| Deterministic tool failure       | `session.tool.failed` contains error type `tool.execution` and message `intentional-probe-tool-failure`. The model continues and the execution succeeds.                                                                                            |
| Event cursor                     | `after` uses the durable sequence number. Returned durable events have greater sequence numbers; `log.synced` also appears. Replay after an idle runtime restart is identical.                                                                      |
| Usage projection                 | Three successful fake text responses each report seven input tokens. The session reports 21 input tokens and keeps that total after restart. Other token buckets are zero in this fixture.                                                          |
| Restart during active turn       | Queued inputs survive and are delivered once each in FIFO order. SDK boot adds a synthetic restart notice and resumes execution, but the first queued input joins the resumed turn. See below.                                                      |

The runtime outputs and assertions are preserved in `results/runtime-public-current.json`, `results/active-current.json`, and `results/recovery-current.json`. Control snapshots keep model/messages/tool names and omit repeated system prompts. The first tool fixture encountered an incidental `import.meta.url` path failure; `active-incidental-tool-error.json` preserves it. The final fixture uses the explicit plugin failure and asserts its exact message.

## Controlled dependency alignment

| Dependency graph                                                                                       | Result                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Janitor snapshot unchanged                                                                             | Local fake execution passes, but OpenCode and registry OpenTelemetry paths call missing lowercase Config APIs.                                                                                                                                                                              |
| Change only `effect` to registry `4.0.0-rc.112`                                                        | Fails bundling. Snapshot `@effect/platform-node-shared/dist/NodeStream.js` imports `effect/ByteSize`, which the registry release does not provide. Saved at commit `4c21a5d`.                                                                                                               |
| Align `effect`, `@effect/platform-node`, and `@effect/platform-node-shared` to registry `4.0.0-rc.112` | Bundle passes without missing-import warnings. Public-factory persistence, active-turn behavior, cursor replay, controlled recovery, tool failure, and usage checks pass. The recovery boundary difference remains. Other Janitor catalog entries are unchanged in the disposable checkout. |

The last row is the smallest successful combination tested, not proof that no smaller source adaptation exists. The aligned graph reports lowercase `Config.string` and `Config.redacted` as functions and uppercase `Config.String` and `Config.Redacted` as undefined. Janitor uses those uppercase functions in `apps/cluster/src/Ingress/GitHubWebhook.ts` and `apps/cluster/src/Labeling/Classifier.ts`. A wholesale downgrade would therefore introduce a known application API mismatch. The experiment does not recommend applying it to Janitor.

Compare `results/graph-current.json`, `graph-aligned.json`, `graph-family-aligned.json`, and the corresponding bundle/API records. The baseline is committed at `7bc5fb1`; each experiment's lockfile is preserved in branch history. The successful aligned tests also pass the same assertions with the narrower recovery interpretation documented below. `active-janitor-workerd.json` records the extra active-turn check on Janitor's exact older binary, while `*-family-aligned.json` uses Miniflare's default binary.

The checkout hit inode exhaustion during installs. Reusing the existing store, clearing only disposable installed dependencies, and using the workspace filter let the experiments complete. This was a setup failure, not an SDK result. No dependency changes were made in the working Janitor branch.

## Recovery changes the turn boundary

The process is recreated while TestLLM has accepted a request but emitted no model events. Two later messages are already durable in the inbox. After restart, the log contains:

1. The original input's delivery, followed by the two queued admissions.
2. A synthetic notice saying the server restarted and work should continue.
3. A new execution start and delivery of the first queued input.
4. The resumed model/tool interaction and its final response.
5. Delivery of the second queued input and its final response.

The first model request after restart includes `queued-one`; it excludes `queued-two`. The initial expectation that the old turn would finish before either queued input was delivered failed. `recovery-strict-boundary-current.json` and its log preserve that failure. The subsequent probe records `strictPreRestartTurnBoundaryPreserved: false` and checks the narrower observed guarantees of retained FIFO inputs, the second input's turn boundary, durable replay, error events, and usage persistence.

The recovered fixture projects 14 input tokens because it produces two successful text responses. The interrupted request emits no usage in this fake model. This does not establish billing reconciliation for interrupted real provider requests.

## Local lifecycle limits

The tests dispose and recreate Miniflare against the same SQLite directory. A new request boots the SDK and triggers recovery. They do not prove production eviction behavior, automatic wakeup with no new request, a long provider stream surviving after all requests end, or exactly-once external tool effects. The test waits through an explicit endpoint after releasing its fake model; it is not evidence that a production request can simply return and abandon responsibility for a long-running turn.

The Workerd profile still has no real repository execution environment. The memory workspace fixture and plugin tool do not validate a remote execution companion. The bundle retains native-related dependencies and produces eval warnings in unused libraries. Real provider configuration, production bundling/limits, repository tools, and Janitor's application checks remain outside this probe.

## Planning consequences

The local loop and durable inbox are promising enough to compare a DO-hosted runner with a coordinator plus an external runner. This experiment does not select either architecture.

The hosting decision must choose a dependency boundary or compatibility adaptation instead of assuming equal Effect version labels mean equal APIs. The session-recovery decision must account for the resumed turn accepting the first queued input. Production liveness, wakeup, and external-effect reconciliation still need concrete contracts and appropriate evidence before an implementation-ready spec can call them settled.

## Source pointers

- [Pinned public Workerd factory](https://github.com/anomalyco/opencode/blob/2df00955cb933e977427535d2505e50cbc689c69/packages/sdk/src/effect/workerd.ts).
- [Pinned Workerd server replacements](https://github.com/anomalyco/opencode/blob/2df00955cb933e977427535d2505e50cbc689c69/packages/server/src/workerd.ts).
- [Pinned Durable Object SQLite adapter](https://github.com/anomalyco/opencode/blob/2df00955cb933e977427535d2505e50cbc689c69/packages/core/src/database/sqlite.workerd.ts).
- [Pinned embedded fake-model tests](https://github.com/anomalyco/opencode/blob/2df00955cb933e977427535d2505e50cbc689c69/packages/sdk/test/embedded.test.ts).
