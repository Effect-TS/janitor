import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import type { SyncSummary } from "@janitor/domain/GitHub/Sync"
import { SyncRoutesLayer } from "../../src/Ingress/Sync.ts"
import { SyncStatus, SyncStatusError } from "../../src/SyncStatus.ts"

const summary: SyncSummary = {
  state: "idle",
  lastVerifiedAt: DateTime.makeUnsafe("2026-09-03T12:00:00.000Z"),
  pendingTargets: 0,
  blockedTargets: 0,
  failedTargets: 0,
}

const withHandler = <A, E, R>(
  status: SyncStatus["Service"],
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(SyncRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      use((request) =>
        handler(
          request,
          Context.make(SyncStatus, status).pipe(
            Context.add(WorkflowDispatcher, {
              dispatchDue: () => Effect.succeed({ claimed: 0, accepted: 0, released: 0 }),
            }),
          ),
        ),
      ),
    ({ dispose }) => Effect.promise(dispose),
  )

const stub = (
  requestAll: Effect.Effect<number, SyncStatusError> = Effect.succeed(4),
): SyncStatus["Service"] => ({
  requestRepository: () => Effect.succeed({ summary, requested: 3 }),
  summary: Effect.succeed(summary),
  requestAll: Effect.map(requestAll, (requested) => ({
    summary: { ...summary, state: "syncing" as const, pendingTargets: requested },
    requested,
  })),
})

const request = (method: string, headers: Record<string, string> = {}) =>
  new Request("https://janitor.example/sync", { method, headers })

describe("SyncRoutes", () => {
  it.effect("returns actionable 409 for manual synchronization of a paused repository", () =>
    withHandler(
      {
        ...stub(),
        requestRepository: () =>
          Effect.fail(
            new SyncStatusError({
              operation: "repositoryUnavailable",
              message: "Repository paused. Resume it in repository settings before syncing.",
            }),
          ),
      },
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(
              new Request("https://janitor.example/repositories/701/sync", {
                method: "POST",
                headers: { "sec-fetch-site": "same-origin" },
              }),
            ),
          )
          assert.strictEqual(response.status, 409)
          assert.include(yield* Effect.promise(() => response.text()), "Resume")
        }),
    ),
  )
  it.effect("rejects the retired separate sync control with repository pause guidance", () =>
    withHandler(stub(), (handler) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("https://janitor.example/repositories/701/sync", {
              method: "PUT",
              headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
              body: JSON.stringify({ enabled: false }),
            }),
          ),
        )
        assert.strictEqual(response.status, 409)
        assert.include(yield* Effect.promise(() => response.text()), "connection")
      }),
    ),
  )

  it.effect("rejects malformed sync settings", () =>
    withHandler(stub(), (handler) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("https://janitor.example/repositories/701/sync", {
              method: "PUT",
              headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
              body: JSON.stringify({ enabled: "false" }),
            }),
          ),
        )
        assert.strictEqual(response.status, 400)
      }),
    ),
  )
  it.effect("returns the summary as JSON", () =>
    withHandler(stub(), (handler) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => handler(request("GET")))
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
          state: "idle",
          lastVerifiedAt: "2026-09-03T12:00:00.000Z",
          pendingTargets: 0,
          blockedTargets: 0,
          failedTargets: 0,
        })
      }),
    ),
  )

  it.effect("accepts a same-origin request and answers with the new state", () =>
    withHandler(stub(), (handler) =>
      Effect.gen(function* () {
        const fetchSite = yield* Effect.promise(() =>
          handler(request("POST", { "sec-fetch-site": "same-origin" })),
        )
        assert.strictEqual(fetchSite.status, 202)
        const body = yield* Effect.promise(() => fetchSite.json())
        assert.strictEqual(body.state, "syncing")
        assert.strictEqual(body.pendingTargets, 4)

        const origin = yield* Effect.promise(() =>
          handler(request("POST", { origin: "https://janitor.example" })),
        )
        assert.strictEqual(origin.status, 202)
      }),
    ),
  )

  it.effect("refuses a cross-origin or origin-less request", () =>
    withHandler(stub(Effect.die("must not run")), (handler) =>
      Effect.gen(function* () {
        const crossSite = yield* Effect.promise(() =>
          handler(request("POST", { "sec-fetch-site": "cross-site" })),
        )
        const otherOrigin = yield* Effect.promise(() =>
          handler(request("POST", { origin: "https://evil.example" })),
        )
        const bare = yield* Effect.promise(() => handler(request("POST")))
        assert.deepStrictEqual([crossSite.status, otherOrigin.status, bare.status], [403, 403, 403])
      }),
    ),
  )

  it.effect("answers 503 when the database is unavailable", () =>
    withHandler(
      stub(Effect.fail(new SyncStatusError({ operation: "requestAll", message: "down" }))),
      (handler) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            handler(request("POST", { "sec-fetch-site": "same-origin" })),
          )
          assert.strictEqual(response.status, 503)
        }),
    ),
  )
})
