import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as Activity from "effect/unstable/workflow/Activity"
import { GitHubHttpCache, type CachedPage, type PutRequest } from "../../src/GitHub/HttpCache.ts"
import {
  PAGE_SIZE,
  paginate,
  probeUrl,
  SyncActivityError,
  withRateLimitWaits,
} from "../../src/GitHub/SyncSupport.ts"
import {
  GitHubTransport,
  type GitHubRequest,
  type GitHubResponse,
} from "../../src/GitHub/Transport.ts"

const Probe = Workflow.make("Test/Paginate", {
  payload: Schema.Struct({ run: Schema.String }),
  success: Schema.Struct({ ids: Schema.Array(Schema.Int) }),
  error: Schema.String,
  idempotencyKey: ({ run }) => run,
})

const Item = Schema.Struct({ id: Schema.Int })

let runs = 0

const runPaginate = (
  respond: (request: GitHubRequest) => GitHubResponse,
  cached: ReadonlyMap<string, CachedPage>,
  puts: Array<PutRequest>,
  requests: Array<GitHubRequest>,
) =>
  Probe.execute({ run: `run-${++runs}` }).pipe(
    Effect.provide(
      Probe.toLayer(() =>
        paginate({
          name: "Test/Pages",
          firstUrl: "/items?per_page=100",
          request: { scope: { _tag: "App" }, priority: "background" },
          page: Schema.Array(Item),
          items: (items) => items,
          itemSchema: Item,
          cache: { repositoryId: Option.none() },
        }).pipe(
          Effect.flatMap((result) =>
            result._tag === "Complete"
              ? Effect.succeed({ ids: result.items.map((item) => item.id) })
              : Effect.fail(result._tag === "Failed" ? result.message : result.reason),
          ),
        ),
      ).pipe(
        Layer.provide(
          Layer.succeed(GitHubTransport, {
            request: (request) =>
              Effect.sync(() => {
                requests.push(request)
                return respond(request)
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(GitHubHttpCache, {
            get: (key) => Effect.succeed(Option.fromNullishOr(cached.get(key.url))),
            put: (request) => Effect.sync(() => void puts.push(request)),
            purgeScope: () => Effect.void,
            purgeRepository: () => Effect.void,
          }),
        ),
        Layer.provideMerge(WorkflowEngine.layerMemory),
      ),
    ),
  )

const page = (ids: ReadonlyArray<number>) => ids.map((id) => ({ id }))
const ok = (body: unknown, etag: string, link?: string): GitHubResponse => ({
  _tag: "Ok",
  status: 200,
  body,
  etag: Option.some(etag),
  link: Option.fromUndefinedOr(link),
  requestId: Option.none(),
})

describe("paginate with the HTTP cache", () => {
  it.live(
    "caps transient retries and never retries permanent failures",
    () =>
      Effect.gen(function* () {
        for (const retryable of [false, true]) {
          let attempts = 0
          const run = Probe.execute({ run: `retry-${retryable}` }).pipe(
            Effect.provide(
              Probe.toLayer(() =>
                withRateLimitWaits("retry-test", (attempt) =>
                  Activity.make({
                    name: `attempt-${attempt}`,
                    error: SyncActivityError,
                    execute: Effect.suspend(() => {
                      attempts++
                      return Effect.fail(
                        new SyncActivityError({ message: "injected failure", retryable }),
                      )
                    }),
                  }),
                ).pipe(
                  Effect.as({ ids: [] }),
                  Effect.mapError((error) => error.message),
                ),
              ).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
            ),
            Effect.result,
          )
          const result = yield* run
          assert.strictEqual(result._tag, "Failure")
          assert.strictEqual(attempts, retryable ? 4 : 1)
        }
      }),
    { timeout: 30000 },
  )
  it.effect("sends stored etags and stores fresh pages with their next link", () =>
    Effect.gen(function* () {
      const puts: Array<PutRequest> = []
      const requests: Array<GitHubRequest> = []
      const cached = new Map<string, CachedPage>([
        [
          "https://api.github.com/items?per_page=100",
          { etag: 'W/"old"', body: page([1]), next: Option.none() },
        ],
      ])

      const result = yield* runPaginate(
        (request) =>
          request.url.endsWith("per_page=100")
            ? ok(
                page([1, 2]),
                'W/"new"',
                '<https://api.github.com/items?per_page=100&page=2>; rel="next"',
              )
            : ok(page([3]), 'W/"p2"'),
        cached,
        puts,
        requests,
      )

      assert.deepStrictEqual(result.ids, [1, 2, 3])
      assert.strictEqual(requests[0]?.etag, 'W/"old"')
      assert.strictEqual(requests[1]?.etag, undefined)
      assert.deepStrictEqual(
        puts.map((put) => [put.etag, Option.getOrNull(put.next)]),
        [
          ['W/"new"', "https://api.github.com/items?per_page=100&page=2"],
          ['W/"p2"', null],
        ],
      )
    }),
  )

  it.effect("serves a 304 from the cache and probes past a formerly full last page", () =>
    Effect.gen(function* () {
      const puts: Array<PutRequest> = []
      const requests: Array<GitHubRequest> = []
      const full = Array.from({ length: PAGE_SIZE }, (_, index) => index + 1)
      const cached = new Map<string, CachedPage>([
        [
          "https://api.github.com/items?per_page=100",
          { etag: 'W/"full"', body: page(full), next: Option.none() },
        ],
      ])

      const result = yield* runPaginate(
        (request) =>
          request.url === "/items?per_page=100"
            ? { _tag: "NotModified", requestId: Option.none() }
            : ok(page([101]), 'W/"p2"'),
        cached,
        puts,
        requests,
      )

      assert.strictEqual(result.ids.length, PAGE_SIZE + 1)
      assert.strictEqual(requests[1]?.url, "https://api.github.com/items?per_page=100&page=2")
      assert.strictEqual(puts.length, 1)
    }),
  )

  it("computes the next page URL", () => {
    assert.strictEqual(
      probeUrl("/items?per_page=100"),
      "https://api.github.com/items?per_page=100&page=2",
    )
    assert.strictEqual(
      probeUrl("https://api.github.com/items?page=4&per_page=100"),
      "https://api.github.com/items?page=5&per_page=100",
    )
  })
})
