# EFF-1847 / EFF-1875: smoke test of the PR review hosting design

Throwaway harness. Not for merging. The reports are on EFF-1847 (everything
but the container, Workers Free plan) and EFF-1875 (the container checks, on
janitor's paid account).

## EFF-1875: real container

The workspace DO now owns a real Cloudflare Container
(`src/ExecutorContainer.ts`, `src/ExecutorContainer.runtime.ts`: clanka's
`AgentExecutor.layerRpcServer` on port 3000, `node:24-bookworm-slim` + git,
ripgrep, curl, `standard-1`) and forwards executor RPC to
`ctx.container.getTcpPort(3000)`. It drives the raw `ctx.container` API, not
alchemy's `Containers.layer` (which starts the container whenever the object
is constructed), so a reconstructed object never restarts anything and
`/workspace` shows whether the container outlived the object.

- Egress: `start({ enableInternet: false })` plus `interceptAllOutboundHttp`
  and `interceptOutboundHttps("*")` to `ctx.exports.default` (needs the
  `enable_ctx_exports` flag); the front door applies the allowlist in
  `src/Egress.ts` to any request whose host is not the Worker's own. The
  container appends Cloudflare's ephemeral intercept CA to its trust bundle at
  boot.
- `provision(acquire, hold)`: `hold` is `none`, `timeout`
  (`setInactivityTimeout(15 min)`) or `alarm` (30 s alarm while running).
  Starts that fail with "no container instance" are retried.
- `limits: { cpuMs: 300_000 }` is back on the Worker.
- New probes: `egress`, `heavy`, `write`, `read`, `bash&cmd=...`;
  `fresh=0` reuses the running container.
- `scripts/idle-ladder.sh` (container survival with nothing holding the DO),
  `scripts/watch-redeploy.sh` (30 s samples across a redeploy),
  `scripts/cpu-summary.sh` (tail CPU per invocation kind).
- `bin/docker`: podman stand-in for alchemy's image build and push on the
  runtime machine (BuildKit-only flags, /var/tmp full).
- `scripts/deploy.sh` refuses to run unless it is in this directory, the stack
  keeps `localState()` and never mentions the shared state store,
  `ALCHEMY_PROFILE=dev`, and that profile points at `a5324318…`. No flags pass
  through, so `--adopt` cannot. Before the first deploy it refuses if the
  account already has anything named `eff1847`.
- Evidence is under `results/eff-1875/` (the tail log itself is not committed).

```sh
pnpm install
ALCHEMY_PROFILE=dev bash scripts/deploy.sh deploy
ALCHEMY_PROFILE=dev node scripts/tail.mjs <account> <script> results/eff-1875/tail-1875.ndjson &
source scripts/lib.sh; call probe smoke-a "kind=concurrent&transport=ws&n=3"
HOLD=alarm bash scripts/idle-ladder.sh d 150 300 600
call start run-1 "minutes=8&sleep=10&transport=http&workload=review"
ALCHEMY_PROFILE=dev bash scripts/deploy.sh destroy
```

## EFF-1847 (Workers Free plan, executor behind a tunnel)

It deploys the EFF-1651 shape to a real Cloudflare account with the #7322
snapshot at `aa48e3f` (EFF-1842 + EFF-1850):

- `src/ReviewRun.ts` — the run entity (`CloudflareCluster.toLayer`), an
  `EntityResource` holding a real clanka loop (OpenRouter model), history rows
  in the entity's DO SQLite committed at each step, resume from those rows
  after a restart, a persisted `Publish` with a `publish_steps` journal,
  `Cancel`, and executor probes.
- `src/WorkspaceObject.ts` — the per-run workspace Durable Object that owns
  the sandbox and forwards executor RPC on its `fetch`.
- `src/Worker.ts` — HTTP front door (`/start /status /cancel /publish /probe
  /workspace`).
- `executor/server.ts` — stand-in for the sandbox container: clanka's
  `AgentExecutor.layerRpcServer` over the RpcServer HTTP streaming and
  WebSocket protocols, one workspace directory per run and acquire.
- `scripts/` — `tunnel.sh` (executor + cloudflared quick tunnel), `deploy.sh`
  (account guard + deploy/destroy), `tail.mjs` (Workers tail to ndjson, with
  per-invocation `cpuTime`/`wallTime`), `lib.sh` (curl helpers).
- `results/` — captured responses and tail logs.

Why a stand-in executor: the staging account is on the Workers Free plan,
which refuses Cloudflare Containers (and `limits.cpuMs`). The entity, the
entity → workspace DO `fetch` hop on the real edge, the streaming and
WebSocket transports through it, keep-alive, redeploy recovery and `Publish`
replay are all real; only the hop from the workspace DO to the executor goes
to a tunnel instead of `ctx.container.getTcpPort(3000)`.

This directory is its own pnpm workspace (see `pnpm-workspace.yaml`) so every
Effect package is pinned to `aa48e3f`, newer than janitor's `7c5525a` catalog.

Run:

```sh
pnpm install
bash scripts/tunnel.sh                       # writes results/tunnel-url.txt
EXECUTOR_URL=$(cat results/tunnel-url.txt) bash scripts/deploy.sh deploy
node scripts/tail.mjs <account> <script> results/tail.ndjson &
source scripts/lib.sh; call start run-1 "minutes=12&sleep=10"
bash scripts/deploy.sh destroy
```
