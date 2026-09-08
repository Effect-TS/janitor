import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Request from "effect/unstable/http/HttpServerRequest"
import * as Response from "effect/unstable/http/HttpServerResponse"
import * as Body from "effect/unstable/http/HttpBody"
import { LiveUpdates } from "../LiveUpdates.ts"
import { CurrentAccessIdentity } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"
import * as Layer from "effect/Layer"

export const LiveRoutesLayer = HttpRouter.add(
  "GET",
  "/repositories/:repositoryId/live",
  Effect.gen(function* () {
    const { repositoryId } = yield* HttpRouter.schemaPathParams(
      Schema.Struct({ repositoryId: Schema.String }),
    )
    const identity = yield* CurrentAccessIdentity
    const request = yield* Request.HttpServerRequest
    const service = yield* Effect.serviceOption(LiveUpdates)
    if (Option.isNone(service)) return Response.empty({ status: 503 })
    const expiresAt =
      request.headers.upgrade?.toLowerCase() === "websocket"
        ? Math.min(DateTime.toEpochMillis(identity.expiresAt), Date.now() + 3600000)
        : 0
    const response = yield* service.value.connect(repositoryId, expiresAt)
    return Response.setBody(Response.empty({ status: response.status }), Body.raw(response))
  }),
).pipe(Layer.provide(SameOriginMiddleware))
