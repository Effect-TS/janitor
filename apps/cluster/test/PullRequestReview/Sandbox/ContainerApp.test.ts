import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { GitCommandFailed } from "../../../src/PullRequestReview/Sandbox/Checkout.ts"
import { makeContainerApp } from "../../../src/PullRequestReview/Sandbox/ContainerApp.ts"

const HEAD = "a".repeat(40)

const provision = (handler: (request: Request) => Promise<Response>) =>
  handler(
    new Request("http://container/provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: "Effect-TS",
        repo: "effect",
        prNumber: 7,
        baseSha: "b".repeat(40),
        headSha: HEAD,
      }),
    }),
  )

describe("PR review sandbox container", () => {
  it.effect("serves executor RPC with and without the trailing slash", () =>
    Effect.gen(function* () {
      const handler = HttpEffect.toWebHandler(
        makeContainerApp({
          rpc: Effect.succeed(HttpServerResponse.text("executor")),
          git: () => Effect.succeed(""),
        }),
      )
      for (const url of ["http://container/rpc", "http://container/rpc/"]) {
        const response = yield* Effect.promise(() =>
          handler(new Request(url, { method: "POST", body: "{}" })),
        )
        assert.strictEqual(yield* Effect.promise(() => response.text()), "executor", url)
      }
    }),
  )

  it.effect("stops a stalled checkout before the next attempt empties the workspace", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const stalled = yield* Deferred.make<void>()
      let fetches = 0
      const handler = HttpEffect.toWebHandler(
        makeContainerApp({
          rpc: Effect.succeed(HttpServerResponse.text("executor")),
          // The first attempt's fetch never finishes; the workspace DO gave up waiting for it.
          git: (args): Effect.Effect<string, GitCommandFailed> =>
            args[0] === "fetch" && fetches++ === 0
              ? Deferred.succeed(stalled, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => events.push("stalled fetch stopped"))),
                )
              : Effect.succeed(args[0] === "rev-parse" ? `${HEAD}\n` : ""),
          reset: Effect.sync(() => events.push("reset")),
        }),
      )

      void provision(handler)
      yield* Deferred.await(stalled)
      const retry = yield* Effect.promise(() =>
        provision(handler).then((response) => response.json()),
      )

      assert.deepStrictEqual(retry, { _tag: "CheckedOut" })
      assert.deepStrictEqual(events, ["reset", "stalled fetch stopped", "reset"])
    }),
  )
})
