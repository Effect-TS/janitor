# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy preview build

Alchemy comes from pkg.alchemy.run preview tarballs of alchemy-run/alchemy `main` at `55e34d0272`, the same commit Effect-TS/website pins, not from npm. The shared Cloudflare State Store `alchemy-state-store` runs protocol v8, and the newest npm release, `2.0.0-beta.84`, speaks v7. That release reads any version mismatch as an out-of-date store, so `alchemy deploy --yes` would redeploy the store at v7 over v8. Every Alchemy build from v8 onward refuses to touch a store newer than its own version.

The preview tarballs report version `2.0.0-beta.84`, so `patchedDependencies` keys stay on that version and the patch files are named for the commit. `blockExoticSubdeps: false` also covers the tarball URLs the previews use for their own dependencies.

`@alchemy.run/test` isn't published as a preview, so `apps/cluster/test/support/ScratchStack.ts` copies the `deploy` half of its `scratchStack`. Move the catalog back to npm once a release supports v8, then replace that helper with `@alchemy.run/test`.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Worker entrypoint re-exports

The PR review and chat sandboxes need `GitEgress` and `ChatEgress` on the cluster Worker's `ctx.exports`, so the Worker entry module must re-export them. `@alchemy.run/cloudflare` generates that entry module and only knows Durable Object, Workflow, and SQL migration exports. Its patch adds an `entrypointModule` export kind, which becomes `export { <exportName> as <name> } from "<module>"`, in both TypeScript and shipped JavaScript. `exportGitEgress` and `exportChatEgress` declare it. Remove the patch when upstream can re-export a named `WorkerEntrypoint`.

## Alchemy container publication

Upstream builds container images with linked bundle copies and a three-minute timeout per attempt, and retries a timeout on the same three-second, five-retry schedule as transient registry errors. Six stalled attempts would take over 18 minutes, too long for the 20-minute deploy job once setup and the Worker update are counted. The Cloudflare patch limits `retryContainerPublication` to one timeout retry per execution, in both TypeScript and shipped JavaScript, so two consecutive stalls fail after about six minutes and three seconds. The timeout counter is allocated inside `Effect.suspend`, so concurrent or repeated executions do not share it. Registry failures don't consume the timeout counter, and the shared five-retry ceiling still applies to mixed failures.

Remove this part of the patch when upstream bounds timeout retries.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from a pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`). The pinned commit `111d7cfdd4fb15079fcb0b56b98d2290e40cd5b8` is the head of `eff-698-cloudflare-cluster-4.1.2`: the PR branch as of `2646b53` (the earlier `eff-698-cloudflare-cluster-4.0.7` pin) rebased onto Effect `4.1.2`, plus one commit adapting it to 4.1. The snapshot packages report version `4.1.2`, which satisfies Alchemy's and Foldkit's `4.1` peer ranges. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy and its `@alchemy.run/*` packages list `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
