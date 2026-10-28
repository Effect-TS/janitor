# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Worker entrypoint re-exports

The PR review and chat sandboxes need `GitEgress` and `ChatEgress` on the cluster Worker's `ctx.exports`, so the Worker entry module must re-export them. `@alchemy.run/cloudflare` generates that entry module and only knows Durable Object, Workflow, and SQL migration exports. Its patch adds an `entrypointModule` export kind, which becomes `export { <exportName> as <name> } from "<module>"`, in both TypeScript and shipped JavaScript. `exportGitEgress` and `exportChatEgress` declare it. Remove the patch when upstream can re-export a named `WorkerEntrypoint`.

## Alchemy container publication

The Cloudflare patch uses `COPY --link` for the generated container bundle and its chunks, in both TypeScript and shipped JavaScript. Ordinary copies force BuildKit to download cached base layers before applying a changed bundle. Linked copies let the registry exporter reuse those layers in the same repository without downloading them. Keep the registry cache import and inline cache export.

Verified against a local registry with BuildKit 0.28.0 and Buildx 0.35.0 using the PR review sandbox preamble (`node:26-bookworm-slim`, apt packages, corepack, and photon-node). After seeding `:buildcache`, changing only `index.mjs`, and pruning all builder cache, an ordinary-copy rebuild downloaded the base layers, including the 55.85 MB Node layer and 132.35 MB apt layer. The linked-copy rebuild kept the preamble cached and downloaded no base layers. Registry access logs confirmed only image/config metadata blob GETs, not layer GETs. Both builds used `--cache-from type=registry,ref=<repo>:buildcache --cache-to type=inline --push`.

Both generated and user-Dockerfile image builds have a three-minute timeout **inside** the existing publication retry, so each attempt gets its own deadline. `retryContainerPublication` also accepts `TimeoutError` (including in its shipped declaration) and retries it alongside the two existing registry errors. The existing three-second spacing and five-retry limit stay unchanged. A continuously stalled build therefore exhausts six attempts in about 18 minutes rather than waiting indefinitely on the first one. Remote-image pulls/pushes and pre-pushed references are unchanged.

Remove this part of the Cloudflare patch when the pinned upstream version supports linked bundle copies and bounded, retryable image builds. Re-run the cold-builder local-registry check when changing BuildKit or the exporter flags; a warm builder can hide the downloads.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from a pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`). The pinned commit `2646b53aebe919d6994449d36c65a4aaaff5b974` is on `eff-698-cloudflare-cluster-4.0.7`: the PR branch rebased onto Effect `4.0.7`, with its Alchemy integration moved to `@alchemy.run/cloudflare`. The snapshot packages report version `4.0.7`, which satisfies Alchemy's `^4.0.5` peer range. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy and its `@alchemy.run/*` packages list `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
