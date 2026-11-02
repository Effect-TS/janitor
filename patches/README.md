# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy preview build

Alchemy comes from pkg.alchemy.run preview tarballs of alchemy-run/alchemy `main` at `52419745b5`, not from npm. The shared Cloudflare State Store `alchemy-state-store` runs protocol v8, and the newest npm release, `2.0.0-beta.84`, speaks v7. That release reads any version mismatch as an out-of-date store, so `alchemy deploy --yes` would redeploy the store at v7 over v8. Every Alchemy build from v8 onward refuses to touch a store newer than its own version.

Effect-TS/website pins `main` at `55e34d0272`. Janitor stops earlier because the commit after `52419745b5` (`9d0709d22a`) requires Effect `^4.1.0`, and the Effect snapshot below is `4.0.7`. The state store code is the same in both builds. The preview tarballs report version `2.0.0-beta.84`, so `patchedDependencies` keys stay on that version and the patch files are named for the commit. `blockExoticSubdeps: false` also covers the tarball URLs the previews use for their own dependencies.

`@alchemy.run/test` isn't published as a preview, so `apps/cluster/test/support/ScratchStack.ts` copies the `deploy` half of its `scratchStack`. Move the catalog back to npm once a release supports v8 and Effect 4.1 is available here; then replace that helper with `@alchemy.run/test`.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Worker entrypoint re-exports

The PR review and chat sandboxes need `GitEgress` and `ChatEgress` on the cluster Worker's `ctx.exports`, so the Worker entry module must re-export them. `@alchemy.run/cloudflare` generates that entry module and only knows Durable Object, Workflow, and SQL migration exports. Its patch adds an `entrypointModule` export kind, which becomes `export { <exportName> as <name> } from "<module>"`, in both TypeScript and shipped JavaScript. `exportGitEgress` and `exportChatEgress` declare it. Remove the patch when upstream can re-export a named `WorkerEntrypoint`.

## Alchemy container publication

The Cloudflare patch uses `COPY --link` for the generated container bundle and its chunks, in both TypeScript and shipped JavaScript. Ordinary copies force BuildKit to download cached base layers before applying a changed bundle. Linked copies let the registry exporter reuse those layers in the same repository without downloading them. Keep the registry cache import and inline cache export.

Verified against a local registry with BuildKit 0.28.0 and Buildx 0.35.0 using the PR review sandbox preamble (`node:26-bookworm-slim`, apt packages, corepack, and photon-node). After seeding `:buildcache`, changing only `index.mjs`, and pruning all builder cache, an ordinary-copy rebuild downloaded the base layers, including the 55.85 MB Node layer and 132.35 MB apt layer. The linked-copy rebuild kept the preamble cached and downloaded no base layers. Registry access logs confirmed only image/config metadata blob GETs, not layer GETs. Both builds used `--cache-from type=registry,ref=<repo>:buildcache --cache-to type=inline --push`.

Both generated and user-Dockerfile image builds have a three-minute timeout **inside** the publication retry, so each attempt gets its own deadline. `retryContainerPublication` accepts `TimeoutError` (including in its shipped declaration), but permits only one timeout retry per execution. Two consecutive stalls therefore fail after about six minutes and three seconds, leaving room for job setup and the Worker update within the 20-minute deploy job. The timeout counter is allocated inside `Effect.suspend`, so concurrent or repeated executions do not share it. The two existing registry errors keep their three-second spacing and five-retry schedule; registry failures do not consume the timeout counter, and the shared five-retry ceiling still applies to mixed failures. Remote-image pulls/pushes and pre-pushed references are unchanged.

Upstream `6f5e5534cc`, the commit after the pinned one, adds linked copies and a three-minute timeout per build attempt. It retries timeouts on the same five-retry schedule as registry errors, though, so five stalls would take over 15 minutes. When moving past that commit, drop the linked copies and the timeout wrapping from the patch, but keep the one-timeout-retry limit until upstream bounds timeout retries. Re-run the cold-builder local-registry check when changing BuildKit or the exporter flags; a warm builder can hide the downloads.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from a pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`). The pinned commit `2646b53aebe919d6994449d36c65a4aaaff5b974` is on `eff-698-cloudflare-cluster-4.0.7`: the PR branch rebased onto Effect `4.0.7`, with its Alchemy integration moved to `@alchemy.run/cloudflare`. The snapshot packages report version `4.0.7`, which satisfies Alchemy's `^4.0.5` peer range. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy and its `@alchemy.run/*` packages list `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
