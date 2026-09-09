import * as Effect from "effect/Effect"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Response from "effect/unstable/http/HttpServerResponse"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/** A read-only schema probe; never runs migrations or contacts GitHub. */
export const readiness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Resolve required tables and columns even on an empty database.
  yield* sql`SELECT r.connected, r.sync_enabled, r.disconnected_at, r.automation_ready_at,
    p.published_version_id, t.completed_generation, t.automation_event_at
    FROM github_repository r
    LEFT JOIN labeling_policy p ON p.repository_id = r.repository_id
    LEFT JOIN sync_target t ON t.scope->>'repositoryId' = r.repository_id
    LIMIT 0`
  yield* sql`SELECT state, expires_at FROM repository_connection_attempt LIMIT 0`
  return Response.jsonUnsafe({ status: "ready" })
}).pipe(
  Effect.timeout("5 seconds"),
  Effect.catch(() =>
    Effect.succeed(Response.jsonUnsafe({ status: "unavailable" }, { status: 503 })),
  ),
)

// Registered inside the human API's Access middleware.
export class Readiness extends Context.Service<
  Readiness,
  { readonly check: Effect.Effect<Response.HttpServerResponse> }
>()("Readiness") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return { check: readiness.pipe(Effect.provideService(SqlClient.SqlClient, sql)) }
    }),
  )
}
export const ReadinessRoutesLayer = HttpRouter.add(
  "GET",
  "/ready",
  Effect.flatMap(Readiness, (service) => service.check),
)
