import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { GitHubHttpCache } from "../../src/GitHub/HttpCache.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"

const CacheLayer = GitHubHttpCache.layer.pipe(Layer.provideMerge(MigratedPostgresLayer))

const cacheKey = {
  scopeKey: "installation:1",
  method: "GET",
  url: "https://api.github.com/repos/a/b/labels?per_page=100",
}

layer(CacheLayer, { timeout: "2 minutes" })("GitHubHttpCache against Postgres", (it) => {
  it.effect("stores a page and returns it with its etag and next link", () =>
    Effect.gen(function* () {
      const cache = yield* GitHubHttpCache

      yield* cache.put({
        ...cacheKey,
        etag: 'W/"1"',
        body: [{ id: 1, name: "secret" }],
        next: Option.some("https://api.github.com/repos/a/b/labels?per_page=100&page=2"),
        repositoryId: Option.some(GitHubRepositoryDatabaseId.make("7")),
      })

      const stored = yield* cache.get(cacheKey)
      assert.deepStrictEqual(
        stored,
        Option.some({
          etag: 'W/"1"',
          body: [{ id: 1, name: "secret" }],
          next: Option.some("https://api.github.com/repos/a/b/labels?per_page=100&page=2"),
        }),
      )

      yield* cache.put({
        ...cacheKey,
        etag: 'W/"2"',
        body: [],
        next: Option.none(),
        repositoryId: Option.none(),
      })
      const replaced = yield* cache.get(cacheKey)
      assert.strictEqual(Option.getOrThrow(replaced).etag, 'W/"2"')
    }),
  )

  it.effect("purges by repository and by scope", () =>
    Effect.gen(function* () {
      const cache = yield* GitHubHttpCache
      const repoKey = { ...cacheKey, url: "https://api.github.com/repos/a/b/issues" }
      const scopeKey = { ...cacheKey, scopeKey: "installation:2", url: "https://api.github.com/x" }
      yield* cache.put({
        ...repoKey,
        etag: "a",
        body: {},
        next: Option.none(),
        repositoryId: Option.some(GitHubRepositoryDatabaseId.make("7")),
      })
      yield* cache.put({
        ...scopeKey,
        etag: "b",
        body: {},
        next: Option.none(),
        repositoryId: Option.none(),
      })

      yield* cache.purgeRepository(GitHubRepositoryDatabaseId.make("7"))
      yield* cache.purgeScope("installation:2")

      assert.isTrue(Option.isNone(yield* cache.get(repoKey)))
      assert.isTrue(Option.isNone(yield* cache.get(scopeKey)))
    }),
  )
})
