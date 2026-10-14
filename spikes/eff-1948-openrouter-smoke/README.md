# EFF-1948: clanka on `openai/gpt-6.1-sol` through OpenRouter

Throwaway smoke-test harness. Nothing here is for merging; the report lives on
EFF-1948. It drives clanka's agent loop the way janitor's PR review (EFF-1996)
will, on the model EFF-1929 chose, and records every model request so the
reasoning round-trip can be checked in the requests themselves.

## What runs

- **clanka** `master` at `9d0da00` (PR #219 "bounded retries, command limits
  and history events" and PR #220 "caller-selected tools, instructions, skills
  and loop-side tools", both merged), built and packed into
  `vendor/clanka-0.8.6-9d0da00.tgz` with `pnpm pack` (`scripts/pack-clanka.sh`
  reproduces it).
- **Every Effect package** clanka loads is overridden to the #7322 snapshot
  commit janitor pinned in EFF-1937, `667feb75dcf5259c4d9eafe51476487b18b8de01`
  (`pnpm-workspace.yaml` overrides, verified in `pnpm-lock.yaml`). The
  `reasoning_details` round trip is a property of that `@effect/ai-openrouter`.
- **Model**: `openai/gpt-6.1-sol`, `reasoning: { effort: "medium" }`, through
  `OpenRouterLanguageModel.model` + `OpenRouterClient.layer`. `--provider
  openai` switches to clanka's `@effect/ai-openai` Responses path with a direct
  key (`store: false`, `include: ["reasoning.encrypted_content"]`).
- **Executor**: `AgentExecutor.layerRpcServer` behind a local Node HTTP server,
  `AgentExecutor.layerRpc` + `RpcClient.layerProtocolHttp` on the loop side.
  `gh`, `webSearch`, `fetchMarkdown` and `delegate` excluded; `commandTimeout`
  3 minutes, `scriptTimeout` 8 minutes, `commandOutputChars` 30 000.
- **Agent**: `Agent.makeWith` with `instructions` from the base branch's
  `.agents/AGENTS.md` (`HEAD~1` of the squash-merge commit), `skills: []`, and
  two loop-side tools, `reportFinding` and `updateThread` (`src/tools.ts`).
  `reportFinding` rejects anchors outside the diff hunks, files the PR does not
  change, and duplicate anchors, with a model-facing message. `MaxRetries` 3,
  `TurnTimeout` 5 minutes.
- **Review target**: a scratch checkout of a merged Effect-TS/effect PR at its
  squash-merge commit (`scripts/checkout-pr.sh <pr>`), with dependencies
  installed so `pnpm test --run <file>` works inside the 3-minute cap.

## Layout

- `src/run.ts` one review run; writes `results/<provider>/run-<n>-pr<pr>/`
  with `summary.json`, `events.ndjson` (every clanka output event),
  `turns.md` (reasoning, script and output per turn) and `http/` (every model
  request and streamed response; `Authorization` and similar headers are
  replaced with `<redacted>` before anything is written).
- `src/evidence.ts` reads a run's `http/` and reports, per request, which
  `reasoning_details` the response produced and whether the following
  requests carried them back.
- `src/summarize.ts` the cross-run tables in `results/<provider>/summary.md`.
- `src/turns.ts` per-turn timing from the event log. One turn is: model
  streams reasoning and a script (`ScriptStart`), the executor runs it
  (`ScriptOutput`), and the model stream's `finish` part arrives (`Usage`),
  because clanka runs `execute` inside the model stream.
- `scripts/run-all.sh` drives several runs in sequence.

## Running

```sh
nix develop ../.. -c pnpm install          # harness deps (janitor's flake shell)
scripts/checkout-pr.sh 9161                # scratch checkout + its own install
OPENROUTER_API_KEY=… scripts/run-all.sh openrouter "1:9161 2:9161"
node src/summarize.ts results/openrouter
```

The key came from Infisical (`janitor` / `development`) through a machine
identity; it is never written to the results. The sandbox commands run with the
Effect checkout's toolchain because `run-all.sh` starts `node` inside
`nix develop ./scratch/pr-<n>`.

## Results (2026-10-14)

Five runs, all `taskComplete`, no retries, no provider errors. The full
tables are in `results/openrouter/summary.md`; the report is on EFF-1948.

- Reasoning round trip holds: every `reasoning.encrypted` block
  (`openai-responses-v1`) a response produced was sent back, byte for byte,
  on the assistant message of its tool call in every later request
  (`evidence.md` per run; "missing" and "altered" are 0 everywhere).
- Both loop-side tools were called in every run; the rejected
  `reportFinding` calls (duplicate anchor) were corrected on the next script.
- Provider-reported cost $0.06–0.08 per run, against $0.19–0.30 at list
  prices because 85–95 % of input tokens were cache reads.
