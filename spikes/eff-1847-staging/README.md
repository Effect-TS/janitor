# EFF-1847: staging smoke test of the PR review hosting design

Throwaway harness. Not for merging. The report is on EFF-1847.

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
