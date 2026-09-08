import { GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import * as Schema from "effect/Schema"
import { SyncSummary } from "@janitor/domain/GitHub/Sync"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import { SyncStatus } from "../SyncStatus.ts"

const respondSummary = HttpServerResponse.schemaJson(SyncSummary)

const forbiddenResponse = HttpServerResponse.text("Forbidden", { status: 403 })
const serviceUnavailableResponse = HttpServerResponse.text("Service Unavailable", {
  status: 503,
  headers: { "Retry-After": "10" },
})

/** Additional browser origin check behind the shared Access middleware. */
const isSameOrigin = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const fetchSite = request.headers["sec-fetch-site"]
  if (fetchSite !== undefined) {
    return fetchSite === "same-origin"
  }
  const origin = request.headers["origin"]
  if (origin === undefined) {
    return false
  }
  try {
    return new URL(origin).origin === new URL(request.originalUrl).origin
  } catch {
    return false
  }
}

export const SameOriginMiddleware = HttpRouter.middleware((app) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isSameOrigin(request) ? app : Effect.succeed(forbiddenResponse),
  ),
).layer

const unavailable = (operation: string) =>
  Effect.fnUntraced(function* (cause: unknown) {
    yield* Effect.logError(`Sync ${operation} failed`, cause)
    return serviceUnavailableResponse
  })

export const SyncSummaryRoute = HttpRouter.add(
  "GET",
  "/sync",
  Effect.gen(function* () {
    const status = yield* SyncStatus
    const summary = yield* status.summary
    return yield* respondSummary(summary)
  }).pipe(Effect.catchCause(unavailable("summary"))),
)

export const SyncRequestRoute = HttpRouter.add(
  "POST",
  "/sync",
  Effect.gen(function* () {
    const status = yield* SyncStatus
    const result = yield* status.requestAll
    const dispatcher = yield* WorkflowDispatcher
    yield* dispatcher
      .dispatchDue()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Immediate manual sync dispatch failed; cron will recover it", cause),
        ),
      )
    return yield* respondSummary(result.summary, { status: 202 })
  }).pipe(Effect.catchCause(unavailable("request"))),
).pipe(Layer.provide(SameOriginMiddleware))

export const RepositorySyncRoute = HttpRouter.add(
  "PUT",
  "/repositories/:repositoryId/sync",
  Effect.gen(function* () {
    const { repositoryId } = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ repositoryId: GitHubRepositoryDatabaseId }),
    )
    const { enabled } = yield* HttpServerRequest.schemaBodyJson(
      Schema.Struct({ enabled: Schema.Boolean }),
    )
    const status = yield* SyncStatus
    const found = yield* status.setRepositorySyncEnabled(repositoryId, enabled)
    if (!found) return HttpServerResponse.empty({ status: 404 })
    return HttpServerResponse.empty({ status: 204 })
  }).pipe(
    Effect.catchTag("SchemaError", () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
    Effect.catchCause(unavailable("repository setting")),
  ),
).pipe(Layer.provide(SameOriginMiddleware))

export const SyncRoutesLayer = Layer.mergeAll(
  SyncSummaryRoute,
  SyncRequestRoute,
  RepositorySyncRoute,
)
