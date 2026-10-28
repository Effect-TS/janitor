import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { errorFields } from "../../PullRequestReview/Log.ts"
import { WORKSPACE_DIRECTORY } from "../../PullRequestReview/Sandbox/ContainerApp.ts"
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
 * - `PUT /files?path=<absolute path>`: writes the body to a file under
 *   `/workspace`, creating its directories, and answers 204. A path outside
 *   `/workspace` gets 400. The session writes a turn's attachments this way.
 */
/** An absolute path under `/workspace`, with no `.` or `..` segment to climb out of it. */
const insideWorkspace = (path: string) =>
  path.startsWith(`${WORKSPACE_DIRECTORY}/`) &&
  path
    .slice(WORKSPACE_DIRECTORY.length + 1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..")

export const makeChatContainerApp = (options: {
  readonly rpc: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  readonly provision: (request: ProvisionRequest) => Effect.Effect<void, unknown>
  /** Writes `content` to `path`, already checked to be under `/workspace`. */
  readonly writeFile: (path: string, content: Uint8Array) => Effect.Effect<void, unknown>
}): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
> => {
  const lock = Semaphore.makeUnsafe(1)

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://container")
    const path = url.pathname.replace(/\/+$/, "") || "/"
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
      case "/files": {
        if (request.method !== "PUT") return HttpServerResponse.empty({ status: 405 })
        const target = url.searchParams.get("path") ?? ""
        if (!insideWorkspace(target)) return HttpServerResponse.empty({ status: 400 })
        yield* options.writeFile(target, new Uint8Array(yield* request.arrayBuffer))
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
