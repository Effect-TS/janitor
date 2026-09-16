# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## OpenCode 2.0.2

Janitor uses the Effect snapshot at `ec83cbdb3c0b0f89df627a7895939a359db9f4ab` for both Alchemy and the runner. Although it reports `4.0.0-rc.112`, it differs from that registry release. Keep `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/opentelemetry` on the same snapshot through the root catalog and overrides.

The AI package patch changes `Config.redacted` to `Config.Redacted`. Without it, the Workerd bundle fails during module initialization. The simulation package patch changes its remaining `Config.string` calls to `Config.String`. These changes adapt the published JavaScript to the snapshot's exported API; their public declarations do not change.

The AI patch also adapts the native OpenRouter request encoder. It omits OpenAI's `store` and `prompt_cache_key` fields and translates `max_completion_tokens` to `max_tokens`. This preserves the explicitly configured output limit under OpenRouter's strict provider routing. Provider options and reasoning history retain the SDK's behavior. The runner uses `OpenRouter.route` directly.

The core package patch adapts the schema bootstrap in `dist/chunks/location-services-fx8h9evn.js`. The runner hosts OpenCode in the session Durable Object, whose SQLite is shared with the Cloudflare Sandbox SDK; the SDK's `container_schedules` table exists before the first turn because the coordinator schedules its drive callback on admission. Upstream refuses to bootstrap into any database holding a table outside its own naming, so every production session failed with "Database is not empty and has no session table". The patch allows that one shared table and keeps refusing any other foreign table, naming it in the error. `apps/runner/test/Database.test.ts` runs the real bootstrap against a seeded database; extend `SHARED_TABLES` in the patch and the test's seed when a pinned SDK upgrade adds tables.

The existing native HTTP tests exercise request parameters, streaming tool arguments, usage, compaction, credential rotation, session restarts and repository checkpoint recovery. Run them without provider credentials:

```sh
vp run runner:check
vp run runner:build
vp run runner:test
```

When upgrading OpenCode or Effect, inspect the upstream implementations and remove each patch when that release implements the required behavior. Reinstall and run the native tests before accepting the upgrade. Startup alone does not establish compatibility. No upstream fix or support guarantee is implied by these local patches.

## Alchemy local containers

The pinned Cloudflare runtime accepts `DOCKER_BIN=podman`. Our runtime patch omits `--load` and `--provenance=false` for that explicit selection and passes the Dockerfile path directly. Podman cannot read the SDK's socket-backed stdin as `/dev/stdin`. It also omits Workerd's unsupported memory-swappiness field from Podman container requests on cgroup v2. Docker retains its existing BuildKit invocation and container settings. The patch covers the shipped Node bundle and its TypeScript source. Remove it when the pinned runtime supports this path upstream; validate with `vp run dev` and `vp run runner:smoke` using the selected engine.

## OpenAI-compatible response metadata

The pinned `@effect/ai-openai-compat` decoder rejects `service_tier: null`, which OpenRouter returns for Union Alpha. The patch normalizes null to undefined in completion responses and streaming chunks, preserving the adapter's decoded types. String values remain valid; other types still fail validation. It covers both source and shipped JavaScript. Remove it when the pinned adapter handles nullable service tiers upstream. The Slack agent-turn test covers a tool call and subsequent conversation with nullable metadata.
