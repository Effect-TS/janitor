# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy release

Alchemy and its `@alchemy.run/*` packages are on npm `2.0.0-beta.85`, the release Effect-TS/website pins. It speaks protocol v8 of the shared Cloudflare State Store `alchemy-state-store`, which earlier npm releases didn't, so they had to come from preview tarballs. The new Effect Cloudflare snapshot also needs `@alchemy.run/cloudflare` `>=2.0.0-beta.85`.

The patches below apply to `2.0.0-beta.85`; none of their fixes is upstream yet. `@alchemy.run/test` is now published at the same version, so `apps/cluster/test/support/ScratchStack.ts` can be replaced with its `scratchStack`.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Worker entrypoint re-exports

The PR review and chat sandboxes need `GitEgress` and `ChatEgress` on the cluster Worker's `ctx.exports`, so the Worker entry module must re-export them. `@alchemy.run/cloudflare` generates that entry module and only knows Durable Object, Workflow, and SQL migration exports. Its patch adds an `entrypointModule` export kind, which becomes `export { <exportName> as <name> } from "<module>"`, in both TypeScript and shipped JavaScript. `exportGitEgress` and `exportChatEgress` declare it. Remove the patch when upstream can re-export a named `WorkerEntrypoint`.

## Alchemy container publication

Upstream builds container images with linked bundle copies and a three-minute timeout per attempt, and retries a timeout on the same three-second, five-retry schedule as transient registry errors. Six stalled attempts would take over 18 minutes, too long for the 20-minute deploy job once setup and the Worker update are counted. The Cloudflare patch limits `retryContainerPublication` to one timeout retry per execution, in both TypeScript and shipped JavaScript, so two consecutive stalls fail after about six minutes and three seconds. The timeout counter is allocated inside `Effect.suspend`, so concurrent or repeated executions do not share it. Registry failures don't consume the timeout counter, and the shared five-retry ceiling still applies to mixed failures.

Remove this part of the patch when upstream bounds timeout retries.

## Alchemy container change detection

An Effect-native container (one with `main`) keeps its program as an Effect in `props.exports`. The container provider's `diff` returns early when `isResolved(news)` is false, and that Effect always makes it false. The engine then compares props without Effects, finds them equal, and plans `noop`. So a change to guest code alone never rebuilt the chat or PR review sandbox image: both stayed on the image from 2026-10-28 until this patch. The Cloudflare patch runs `stripEffects` on `news` before that check, as the Worker provider already does, so the bundle hash reaches the image comparison. It covers both TypeScript and shipped JavaScript.

Remove this part of the patch when upstream strips Effects in the container `diff`.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from a pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`). The pinned commit `6e155f1c771c5329feccdbd631144b2484dd44dd` is that branch's head on 2026-11-05, rebased onto a newer Effect `main`. It carries the Cloudflare queue, workflow, entity and initializer fixes made since the earlier `eff-698-cloudflare-cluster-4.1.2` pin (`111d7cfdd`), and raises its Alchemy peer to `2.0.0-beta.85`. The snapshot packages report version `4.1.2`, which satisfies Alchemy's, Foldkit's and clanka's peer ranges. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, let the Effect `Snapshot` workflow publish the branch's new head and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy and its `@alchemy.run/*` packages list `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
