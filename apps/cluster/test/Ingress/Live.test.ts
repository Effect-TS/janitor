import { assert, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { LiveRoutesLayer } from "../../src/Ingress/Live.ts"
import { CurrentAccessIdentity } from "../../src/Ingress/Middleware.ts"
import { LiveUpdates } from "../../src/LiveUpdates.ts"

it.effect("checks origin and bounds websocket lifetime to the verified Access session", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(LiveRoutesLayer, { disableLogger: true })),
    ({ handler }) =>
      Effect.gen(function* () {
        const expiresAt = Date.now() + 60000
        const calls: number[] = []
        const context = Context.make(CurrentAccessIdentity, {
          issuer: "https://access.example",
          subject: "person",
          email: undefined,
          expiresAt: DateTime.makeUnsafe(expiresAt),
        }).pipe(
          Context.add(LiveUpdates, {
            flush: Effect.void,
            connect: (repositoryId, expiry) =>
              Effect.sync(() => {
                assert.include(["701", "application"], repositoryId)
                calls.push(expiry)
                return new Response(null, { status: 204 })
              }),
          }),
        )
        for (const path of ["/repositories/701/live", "/live"]) {
          for (const origin of ["https://elsewhere.example", "null"]) {
            const response = yield* Effect.promise(() =>
              handler(
                new Request(`https://janitor.example${path}`, {
                  headers: { origin, upgrade: "websocket" },
                }),
                context,
              ),
            )
            assert.strictEqual(response.status, 403)
          }
          assert.lengthOf(calls, 0)
          for (const upgrade of [false, true]) {
            const response = yield* Effect.promise(() =>
              handler(
                new Request(`https://janitor.example${path}`, {
                  headers: {
                    origin: "https://janitor.example",
                    ...(upgrade ? { upgrade: "websocket" } : {}),
                  },
                }),
                context,
              ),
            )
            assert.strictEqual(response.status, 204)
          }
          assert.deepStrictEqual(calls, [0, expiresAt])
          calls.length = 0
        }
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
)
