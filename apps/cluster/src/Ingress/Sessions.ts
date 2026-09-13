import { SessionCursor, SessionDetail, SessionPage } from "@janitor/domain/Agent/Observation"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Body from "effect/unstable/http/HttpBody"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Request from "effect/unstable/http/HttpServerRequest"
import * as Response from "effect/unstable/http/HttpServerResponse"
import { DEFAULT_PAGE_SIZE, SessionObservation } from "../Agent/Observation.ts"
import { AgentSessionError, AgentSessionNotFound } from "../Agent/Sessions.ts"
import { LiveUpdates } from "../LiveUpdates.ts"
import { liveExpiry } from "./Live.ts"
import { CurrentAccessIdentity, CurrentTeammate } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"

/**
 * Session observation for the dashboard. Every route sits behind Access and
 * active membership; admins and members read the same compact facts, and
 * Slack channel membership plays no part. The reads are plain HTTP so a
 * missed invalidation can never lose authoritative data.
 */

const respondMessage = Response.schemaJson(Schema.Struct({ message: Schema.String }))
const unavailable = respondMessage(
  { message: "Session observation is not available on this deployment." },
  { status: 503 },
)

const ListQuery = Schema.Struct({
  cursor: Schema.optionalKey(Schema.fromJsonString(SessionCursor)),
  limit: Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt())),
})

const SessionPath = Schema.Struct({ sessionId: Schema.String })

const list = HttpRouter.add(
  "GET",
  "/sessions",
  Effect.gen(function* () {
    const observation = yield* Effect.serviceOption(SessionObservation)
    if (Option.isNone(observation)) return yield* unavailable
    const query = yield* Request.schemaSearchParams(ListQuery)
    const page = yield* observation.value.list({
      cursor: query.cursor ?? null,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    })
    return yield* Response.schemaJson(SessionPage)(page)
  }).pipe(
    Effect.catchIf(Schema.is(AgentSessionError), (error) =>
      Effect.logError("Session list failed", error.message).pipe(
        Effect.andThen(respondMessage({ message: "Sessions could not be read." }, { status: 503 })),
      ),
    ),
  ),
)

const detail = HttpRouter.add(
  "GET",
  "/sessions/:sessionId",
  Effect.gen(function* () {
    const { sessionId } = yield* HttpRouter.schemaPathParams(SessionPath)
    const observation = yield* Effect.serviceOption(SessionObservation)
    if (Option.isNone(observation)) return yield* unavailable
    const view = yield* observation.value.detail(sessionId)
    return yield* Response.schemaJson(SessionDetail)(view)
  }).pipe(
    Effect.catchIf(Schema.is(AgentSessionNotFound), () =>
      respondMessage({ message: "This session is unavailable." }, { status: 404 }),
    ),
    Effect.catchIf(Schema.is(AgentSessionError), (error) =>
      Effect.logError("Session detail failed", error.message).pipe(
        Effect.andThen(
          respondMessage({ message: "The session could not be read." }, { status: 503 }),
        ),
      ),
    ),
  ),
)

const live = HttpRouter.add(
  "GET",
  "/sessions/live",
  Effect.gen(function* () {
    const identity = yield* CurrentAccessIdentity
    const teammate = yield* CurrentTeammate
    const request = yield* Request.HttpServerRequest
    const service = yield* Effect.serviceOption(LiveUpdates)
    if (Option.isNone(service)) return Response.empty({ status: 503 })
    const response = yield* service.value.connectSessions(
      teammate.teammateId,
      liveExpiry(identity, request),
    )
    return Response.setBody(Response.empty({ status: response.status }), Body.raw(response))
  }),
).pipe(Layer.provide(SameOriginMiddleware))

// The live route is registered first so `/sessions/live` is never read as a session ID.
export const SessionRoutesLayer = Layer.mergeAll(live, list, detail)
