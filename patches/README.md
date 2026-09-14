# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## OpenCode 2.0.2

Janitor uses the Effect snapshot at `ec83cbdb3c0b0f89df627a7895939a359db9f4ab` for both Alchemy and the runner. Although it reports `4.0.0-rc.112`, it differs from that registry release. Keep `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/opentelemetry` on the same snapshot through the root catalog and overrides.

The AI package patch changes `Config.redacted` to `Config.Redacted`. Without it, the Workerd bundle fails during module initialization. The simulation package patch changes its remaining `Config.string` calls to `Config.String`. These changes adapt the published JavaScript to the snapshot's exported API; their public declarations do not change.

The AI patch also adapts the native OpenRouter request encoder. It omits OpenAI's `store` and `prompt_cache_key` fields and translates `max_completion_tokens` to `max_tokens`. This preserves the explicitly configured output limit under OpenRouter's strict provider routing. Provider options and reasoning history retain the SDK's behavior. The runner uses `OpenRouter.route` directly.

The existing native HTTP tests exercise request parameters, streaming tool arguments, usage, compaction, credential rotation, session restarts and repository checkpoint recovery. Run them without provider credentials:

```sh
vp run runner:check
vp run runner:build
vp run runner:test
```

When upgrading OpenCode or Effect, inspect the upstream implementations and remove each patch when that release implements the required behavior. Reinstall and run the native tests before accepting the upgrade. Startup alone does not establish compatibility. No upstream fix or support guarantee is implied by these local patches.

## Alchemy local containers

The pinned Cloudflare runtime accepts `DOCKER_BIN=podman`. Our runtime patch omits `--load` and `--provenance=false` for that explicit selection and passes the Dockerfile path directly. Podman cannot read the SDK's socket-backed stdin as `/dev/stdin`. It also omits Workerd's unsupported memory-swappiness field from Podman container requests on cgroup v2. Docker retains its existing BuildKit invocation and container settings. The patch covers the shipped Node bundle and its TypeScript source. Remove it when the pinned runtime supports this path upstream; validate with `vp run dev` and `vp run runner:smoke` using the selected engine.

The local runtime also recognizes `ALCHEMY_LOCAL_ALLOW_USER_NAMESPACES=true` on an explicitly opted-in image. It sets the Docker seccomp/AppArmor options required for the bridge's nested user and PID namespaces, preserving other container settings. Only the local runner image sets this option; sidecars and production deployment are unchanged. The native test containers use the same options and preflight the real `unshare` command before the suite starts.
