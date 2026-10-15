import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { makeContainerApp } from "../../../src/PullRequestReview/Sandbox/ContainerApp.ts"

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
})
