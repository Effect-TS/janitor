# Dependency patches

Patches are applied by the root `pnpm-workspace.yaml` and pinned by `pnpm-lock.yaml`. Run `vp install` after editing a patch and commit the resulting lockfile. CI uses `vp install --frozen-lockfile`, which rejects a patch/lockfile mismatch.

## Alchemy worker startup

Alchemy's command memoization module imports `tinyglobby` at module scope. That reaches `fdir`, whose `createRequire(import.meta.url)` fails during Cloudflare Worker startup because the runtime supplies no module URL. The Alchemy patch loads `tinyglobby` only when deployment file hashing runs, in both TypeScript and shipped JavaScript.

`Memo.test.ts` verifies that deployment hashing still detects included file changes and ignores excluded files. Remove this patch when the pinned Alchemy version defers the import upstream.

## Alchemy Podman image lookup

Alchemy's Docker provider treats a missing image as `NotFound` only when the CLI says "no such" or "not found". Podman says "image not known", so planning fails on a fresh `.alchemy` state before the Postgres image has ever been built. The patch also matches "not known", in both TypeScript and shipped JavaScript. Remove it when upstream recognises Podman's wording.

## Effect snapshot

`@effect/platform-cloudflare` is not published yet, so every Effect package comes from the pkg.pr.new snapshot of Effect PR 7322 (`eff-698-cloudflare-cluster`) at commit `7c5525a6c2084247c262fef7c2045c94c10f0e67`. That commit is the branch rebased onto Effect `4.0.0`, so the snapshot packages report version `4.0.0`. Sharing one snapshot keeps janitor and clanka on the same Effect build. To move forward, rebase the branch onto the next release, let the Effect `Snapshot` workflow publish the new head, and update every catalog URL. Switch to registry packages once the PR is released. The root catalog and overrides keep every Effect package on one version, including `@effect/sql-d1` and `@effect/sql-sqlite-do`, which Alchemy depends on.

Alchemy lists `@effect/platform-node`, `@effect/sql-pg`, and `@effect/vitest` as optional peers. pnpm resolves a missing optional peer from the registry rather than from the catalog, so every workspace package that depends on `alchemy` also declares all three as `catalog:` dependencies.
