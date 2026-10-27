import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { errorFields } from "../../PullRequestReview/Log.ts"
import { ProvisionRequest } from "./Provision.ts"

/**
 * The chat sandbox's HTTP surface on port 3000, the same port and routes as
 * PR review's:
 *
 * - `/rpc`: clanka's executor over the RpcServer HTTP streaming protocol,
 *   with or without the trailing slash.
 * - `GET /health`: answers once the server is up.
 * - `POST /provision`: applies a `ProvisionRequest` and answers 204. One at a
 *   time; applying the same request again is harmless, so the workspace can
 *   retry.
 */
export const makeChatContainerApp = (options: {
  readonly rpc: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  readonly provision: (request: ProvisionRequest) => Effect.Effect<void, unknown>
}): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
> => {
  const lock = Semaphore.makeUnsafe(1)

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const path = new URL(request.url, "http://container").pathname.replace(/\/+$/, "") || "/"
    switch (path) {
      case "/rpc":
        return yield* options.rpc
      case "/health":
        return HttpServerResponse.empty({ status: 200 })
      case "/provision": {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 })
        const provisionRequest = yield* HttpServerRequest.schemaBodyJson(ProvisionRequest)
        yield* options.provision(provisionRequest).pipe(Semaphore.withPermits(lock, 1))
        return HttpServerResponse.empty({ status: 204 })
      }
      default:
        return HttpServerResponse.empty({ status: 404 })
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Chat sandbox container request failed").pipe(
        Effect.annotateLogs(errorFields(Cause.squash(cause))),
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  )
}
