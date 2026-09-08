# Effect snapshot dependencies

The application uses the packages published by [Effect CI run 34166059941](https://github.com/Effect-TS/effect/actions/runs/34166059941/job/101877194926?pr=7322), pinned to commit `ec83cbdb3c0b0f89df627a7895939a359db9f4ab`.

The catalog in `pnpm-workspace.yaml` pins `effect`, `@effect/platform-cloudflare`, `@effect/platform-node`, `@effect/platform-node-shared`, `@effect/platform-browser`, `@effect/ai-openai-compat`, and `@effect/vitest` to full-commit `https://pkg.pr.new/Effect-TS/effect/<package>@<commit>` URLs. Overrides keep transitive consumers on those same packages. Frontend, backend, Foldkit, and Alchemy share one Effect resolution.

Install with `vp install --frozen-lockfile`. No sibling Effect checkout, local compilation, linking, or vendored tarballs are required. The lockfile records tarball integrity; snapshot package version strings alone do not identify their source revision.

## Compatibility pins

- Keep `@effect/sql-pg` at registry version `4.0.0-rc.112`. The snapshot introduces a native PostgreSQL driver with different decoded bigint/timestamp types. Adopting that driver requires a separate database compatibility review. The registry adapter uses the same snapshot Effect runtime as the application.
- Keep Vitest at `4.1.11`, matching Vite+ 0.3.0. The snapshot `@effect/vitest` declares a Vitest 5 peer; the override makes it use Vite+'s runner instead of installing a second runner with a separate test context. Validate this pairing with the full test suite when changing either pin.
- Alchemy and its Cloudflare runtime use `2.0.0-beta.76`. Their patches are rebased onto that release. Keep the Distilled patches at `1.0.0-rc.8`, which Alchemy still depends on. The Effect snapshot uses capitalized Config APIs; these packages still call the older lowercase APIs without the patches.
- Alchemy's SQL proxy also needs a compatibility patch for the snapshot's Effect iterator. Bind Effect methods to the underlying Effect and preserve its absent Exit marker. Otherwise queries after an asynchronous boundary can return proxies instead of rows. `AlchemyProxy.test.ts` covers this path.

The [Alchemy beta.76 release](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.76) does not include these compatibility fixes. It also still needs our Docker patch to recognize Podman's "not known" response as a missing container during cleanup. Both the source and distributed JavaScript remain patched so development, tests, and deployed bundles use the same behavior.

pnpm's `blockExoticSubdeps` is disabled because the snapshots also appear transitively. `vp run check:dependencies` checks the committed and installed lockfiles against the exact snapshot URL allowlist, requires integrity, rejects additional tarball/Git sources, and checks that installed Effect consumers resolve the same runtime inside this repository. CI runs this after its frozen installation.

## Updating the snapshot

Change all snapshot catalog entries to URLs from the same successful CI build, using its full commit hash. Run `vp install` and review the lockfile diff for unrelated upgrades. Then run:

```sh
vp run check:dependencies
vp check
vp test
vp run build:web
vp run check:worker-bundle
```

Repeat the frozen install in a fresh directory. Exercise the local API, rule testing, sync/workflow execution, and WebSocket notifications and reconnection. Before deployment, review `vp run production:plan` and confirm existing Durable Object classes, bindings, and database resources retain their identities. A dependency cutover must not recreate persisted cluster state.

The cutover updates JSON parsing to `Schema.fromJsonString(Schema.Unknown)` and WebSocket consumption to Effect's scoped reader/pull and writer APIs. Existing historical design/spike documents describe the earlier branch setup and are not installation instructions.
