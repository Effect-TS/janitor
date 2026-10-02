# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from the pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`) at commit `7c5525a6c2084247c262fef7c2045c94c10f0e67`. That commit is the branch rebased onto Effect `4.0.0`, so the snapshot packages report version `4.0.0`. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy lists `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.

## Alchemy preview build

**Temporary. Expires around 2026-10-08.** Published Alchemy `2.0.0-beta.79` and `@distilled.cloud/*` `1.0.0-rc.12` import `effect/unstable/*`, which Effect `4.0.0` no longer exports. Until Alchemy `2.0.0-beta.80` and a matching distilled release ship, `alchemy` and `@distilled.cloud/cloudflare` come from Alchemy's preview registry (`pkg.alchemy.run`). They're pinned to the content-addressed tarballs of the `main` build at commit `1d13bddb8b4adaf51aec2c0018678f51dc2879f1`, published 2026-10-01. The preview `alchemy` manifest pins its own `@alchemy.run/*` and `@distilled.cloud/*` dependencies to tarballs from the same build. Its manifests still report `2.0.0-beta.79` and `1.0.0-rc.12`, so the patch keys below are unchanged.

Previews expire one week after publication. After that, a fresh install can't fetch these tarballs, though existing pnpm stores keep working. Before then, switch the catalog to the published releases, or to a newer preview if they haven't shipped. Upstream tracking is in alchemy-run/alchemy#1882. The preview omits `@distilled.cloud/gcp`, which falls back to registry `1.0.0-rc.12` with the old Effect paths. Only `alchemy/GCP` loads it, and janitor doesn't import that.

## OpenAI-compatible response metadata

The pinned `@effect/ai-openai-compat` decoder rejects `service_tier: null`, which OpenRouter returns for Union Alpha. The patch normalizes null to undefined in completion responses and streaming chunks, preserving the adapter's decoded types. String values remain valid; other types still fail validation. It covers both source and shipped JavaScript. Remove it when the pinned adapter handles nullable service tiers upstream. The Slack agent-turn test covers a tool call and subsequent conversation with nullable metadata.

Streaming chunks must run through the decoder rather than `Schema.is`, so the null normalization actually runs. Otherwise the adapter classifies valid chunks as unknown events and silently drops their text and tool calls. The streamed Slack conversation test covers this path.

## Alchemy local containers

The pinned Cloudflare runtime accepts `DOCKER_BIN=podman`. Our runtime patch omits `--load` and `--provenance=false` for that explicit selection and passes the Dockerfile path directly. Podman cannot read the SDK's socket-backed stdin as `/dev/stdin`. It also omits Workerd's unsupported memory-swappiness field from Podman container requests on cgroup v2. Docker retains its existing BuildKit invocation and container settings. The patch covers the shipped Node bundle and its TypeScript source. Remove it when the pinned runtime supports this path upstream; validate with `vp run dev` and a Slack repository operation using the selected engine.

## Cloudflare container namespace readiness

Alchemy publishes existing Durable Object namespace IDs early to break Worker/Container dependency cycles. Container creation can then reach Cloudflare before the concurrent Worker upload enables container support for that namespace. The Alchemy patch retries `DurableObjectNotContainerEnabled` during creation with a namespace binding every three seconds, at most 20 retries. Other errors keep their existing handling; persistent enablement errors still fail deployment after the retry budget.

The patch covers TypeScript and shipped JavaScript. `ContainerDeployment.test.ts` exercises the live provider with simulated Cloudflare HTTP responses for recovery, exhaustion, and unrelated errors. `SandboxBindings.test.ts` checks that both sandbox classes appear in the compiled Worker's container metadata. Remove the patch when the pinned Alchemy version handles this deployment race upstream.

Numeric container sizing (`memoryMib`) shipped upstream in Alchemy 2.0.0-beta.79, so that part of the earlier patch is gone. `ContainerSizing.test.ts` still checks the serialized create, update, and rollout bodies.
