# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Effect snapshot

Janitor uses the Effect snapshot at `ec83cbdb3c0b0f89df627a7895939a359db9f4ab`. Although it reports `4.0.0-rc.112`, it differs from that registry release. Keep `@effect/platform-node`, `@effect/platform-node-shared` and `@effect/opentelemetry` on the same snapshot through the root catalog and overrides.

## Alchemy local containers

The pinned Cloudflare runtime accepts `DOCKER_BIN=podman`. Our runtime patch omits `--load` and `--provenance=false` for that explicit selection and passes the Dockerfile path directly. Podman cannot read the SDK's socket-backed stdin as `/dev/stdin`. It also omits Workerd's unsupported memory-swappiness field from Podman container requests on cgroup v2. Docker retains its existing BuildKit invocation and container settings. The patch covers the shipped Node bundle and its TypeScript source. Remove it when the pinned runtime supports this path upstream; validate with `vp run dev` and a Slack repository operation using the selected engine.

## OpenAI-compatible response metadata

The pinned `@effect/ai-openai-compat` decoder rejects `service_tier: null`, which OpenRouter returns for Union Alpha. The patch normalizes null to undefined in completion responses and streaming chunks, preserving the adapter's decoded types. String values remain valid; other types still fail validation. It covers both source and shipped JavaScript. Remove it when the pinned adapter handles nullable service tiers upstream. The Slack agent-turn test covers a tool call and subsequent conversation with nullable metadata.

Streaming chunks must run through the decoder rather than `Schema.is`, so the null normalization actually runs. Otherwise the adapter classifies valid chunks as unknown events and silently drops their text and tool calls. The streamed Slack conversation test covers this path.

## Cloudflare container enablement

Alchemy publishes existing Durable Object namespace IDs early to break Worker/Container dependency cycles. Container creation can then reach Cloudflare before the concurrent Worker upload enables container support for that namespace. The Alchemy patch retries `DurableObjectNotContainerEnabled` during creation with a namespace binding every three seconds, at most 20 retries. Other errors keep their existing handling; persistent enablement errors still fail deployment after the retry budget.

The patch covers TypeScript and shipped JavaScript. `ContainerDeployment.test.ts` exercises the live provider with simulated Cloudflare HTTP responses for recovery, exhaustion, and unrelated errors. `SandboxBindings.test.ts` checks that both sandbox classes appear in the compiled Worker's container metadata. Remove the patch when the pinned Alchemy version handles this deployment race upstream.
