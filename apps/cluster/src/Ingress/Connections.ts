import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Request from "effect/unstable/http/HttpServerRequest"
import * as Response from "effect/unstable/http/HttpServerResponse"
import { ConnectionInventory } from "@janitor/domain/GitHub/Connection"
import { RepositoryConnections } from "../RepositoryConnections.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"
const handled = <E, R>(effect: Effect.Effect<Response.HttpServerResponse, E, R>) =>
  effect.pipe(
    Effect.catch((error) => {
      const known =
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "ConnectionError"
      return Response.schemaJson(Schema.Struct({ message: Schema.String }))(
        {
          message:
            known && "message" in error
              ? String(error.message)
              : "The request could not be completed. Please retry.",
        },
        { status: known ? 409 : 503 },
      )
    }),
  )
const reads = HttpRouter.add(
  "GET",
  "/repository-connections/available",
  Effect.gen(function* () {
    return yield* Response.schemaJson(ConnectionInventory)(
      yield* (yield* RepositoryConnections).inventory,
    )
  }).pipe(handled),
)
const writes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/repository-connections/refresh",
    Effect.gen(function* () {
      yield* (yield* RepositoryConnections).refresh
      return Response.empty({ status: 202 })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "POST",
    "/repository-connections/github",
    Effect.gen(function* () {
      const { installationId } = yield* Request.schemaBodyJson(
        Schema.Struct({ installationId: Schema.NullOr(Schema.String) }),
      )
      const url = yield* (yield* RepositoryConnections).github(
        installationId,
        yield* CurrentAccessIdentity,
      )
      return yield* Response.schemaJson(Schema.Struct({ url: Schema.String }))({ url })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "POST",
    "/repository-connections/return",
    Effect.gen(function* () {
      const { state } = yield* Request.schemaBodyJson(Schema.Struct({ state: Schema.String }))
      yield* (yield* RepositoryConnections).returned(state, yield* CurrentAccessIdentity)
      return Response.empty({ status: 204 })
    }).pipe(handled),
  ),
  ...(["PUT", "DELETE", "PATCH"] as const).map((method) =>
    HttpRouter.route(
      method,
      "/repositories/:repositoryId/connection",
      Effect.gen(function* () {
        const { repositoryId } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({ repositoryId: Schema.String }),
        )
        const action =
          method === "DELETE"
            ? "disconnect"
            : method === "PUT"
              ? "connect"
              : (yield* Request.schemaBodyJson(Schema.Struct({ enabled: Schema.Boolean }))).enabled
                ? "resume"
                : "pause"
        yield* (yield* RepositoryConnections).change(
          repositoryId,
          action,
          yield* CurrentAccessIdentity,
        )
        return Response.empty({ status: 204 })
      }).pipe(handled),
    ),
  ),
]).pipe(Layer.provide(SameOriginMiddleware))
export const ConnectionRoutesLayer = Layer.mergeAll(reads, writes)
