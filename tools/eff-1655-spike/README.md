# EFF-1655 spike: clanka's agent loop in a Durable Object, executor in the sandbox container

Throwaway diagnostic harness. Not for merging. See the report on EFF-1655.

- `load/` — bundles `clanka/Agent` with esbuild and runs it in bare workerd
  (`load/build.sh`, then `load/run.sh <static|probe> <compat-date>`).
- `src/` + `alchemy.run.ts` — an alchemy stack with one Worker, one Durable
  Object (`AgentObject`) running clanka's `Agent` with `AgentExecutor.layerRpc`,
  and one container (`ExecutorContainer`) serving `AgentExecutor.layerRpcServer`
  over `RpcServer` HTTP streaming (`/rpc`) and WebSocket (`/ws`) protocols on
  its plain `fetch` handler.
- `run-checks.sh [http|ws]` — drives the Worker routes and stores responses in
  `results/`.
- `bin/docker` and `bin/docker-proxy.mjs` — shims needed on this machine
  because `docker` is podman: strip BuildKit-only build flags and the
  `MemorySwappiness` field workerd sends on container create.

Run: start `node bin/docker-proxy.mjs`, then
`DOCKER_HOST=unix:///tmp/eff1655-docker.sock DOCKER_BIN=$PWD/bin/docker alchemy dev --no-input`.
