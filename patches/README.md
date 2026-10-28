# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Worker entrypoint re-exports

The PR review and chat sandboxes need `GitEgress` and `ChatEgress` on the cluster Worker's `ctx.exports`, so the Worker entry module must re-export them. `@alchemy.run/cloudflare` generates that entry module and only knows Durable Object, Workflow, and SQL migration exports. Its patch adds an `entrypointModule` export kind, which becomes `export { <exportName> as <name> } from "<module>"`, in both TypeScript and shipped JavaScript. `exportGitEgress` and `exportChatEgress` declare it. Remove the patch when upstream can re-export a named `WorkerEntrypoint`.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from a pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`). The pinned commit `2646b53aebe919d6994449d36c65a4aaaff5b974` is on `eff-698-cloudflare-cluster-4.0.7`: the PR branch rebased onto Effect `4.0.7`, with its Alchemy integration moved to `@alchemy.run/cloudflare`. The snapshot packages report version `4.0.7`, which satisfies Alchemy's `^4.0.5` peer range. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy and its `@alchemy.run/*` packages list `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
