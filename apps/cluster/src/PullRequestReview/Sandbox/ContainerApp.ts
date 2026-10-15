import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as Scope from "effect/Scope"
import { checkout, CheckoutOutcome, CheckoutRequest, type Git } from "./Checkout.ts"

/** The port the container serves on, and the workspace DO forwards to. */
export const CONTAINER_PORT = 3000

/** Where clanka's executor works and the checkout lands. */
export const WORKSPACE_DIRECTORY = "/workspace"

/**
 * The container's HTTP surface on port 3000:
 *
 * - `/rpc`: clanka's executor over the RpcServer HTTP streaming protocol.
 *   `RpcClient.layerProtocolHttp` may add a trailing slash, so both forms
 *   route here.
 * - `GET /health`: answers once the server is up; the workspace DO polls it
 *   after `start()`.
 * - `POST /provision`: one checkout attempt. The workspace DO retries.
 */
export const makeContainerApp = (options: {
  readonly rpc: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  readonly git: Git
  /** Empties the workspace before each attempt, so a retry starts clean. */
  readonly reset?: Effect.Effect<void> | undefined
}): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://container").pathname.replace(/\/+$/, "") || "/"
    switch (path) {
      case "/rpc":
        return yield* options.rpc
      case "/health":
        return HttpServerResponse.empty({ status: 200 })
      case "/provision": {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 })
        const checkoutRequest = yield* HttpServerRequest.schemaBodyJson(CheckoutRequest)
        yield* options.reset ?? Effect.void
        const outcome: CheckoutOutcome = yield* checkout(options.git, checkoutRequest).pipe(
          Effect.as({ _tag: "CheckedOut" } as const),
          Effect.catch((error) => Effect.succeed(error)),
        )
        return yield* HttpServerResponse.schemaJson(CheckoutOutcome)(outcome)
      }
      default:
        return HttpServerResponse.empty({ status: 404 })
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Sandbox container request failed", cause).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  )
