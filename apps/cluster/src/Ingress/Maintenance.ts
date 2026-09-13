// Operator control of the maintenance barrier.
//
// Deployment tooling, not a teammate or the dashboard, drives controlled
// upgrades: hold before an incompatible release, watch until every runner is
// quiescent, release after the rollout is verified. The routes authenticate
// with a dedicated service token so they work without a browser session and
// are unavailable when that token is not configured.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import {
  AgentMaintenance,
  AgentMaintenanceError,
  MaintenanceRefused,
  MaintenanceStatus,
} from "../Agent/Maintenance.ts"
import { bearerMatches } from "./Auth.ts"

const respondMessage = HttpServerResponse.schemaJson(Schema.Struct({ message: Schema.String }))
const respondStatus = HttpServerResponse.schemaJson(Schema.NullOr(MaintenanceStatus))

const HoldBody = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  expectedRelease: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
})
const EpochBody = Schema.Struct({ epoch: Schema.Int })

const withMaintenance = <A, E, R>(
  run: (maintenance: AgentMaintenance["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!(yield* bearerMatches("JANITOR_MAINTENANCE_TOKEN")))
      return HttpServerResponse.empty({ status: 401 })
    const maintenance = yield* Effect.serviceOption(AgentMaintenance)
    if (Option.isNone(maintenance))
      return yield* respondMessage(
        { message: "Agent sessions are not configured on this deployment." },
        { status: 503 },
      )
    return yield* run(maintenance.value)
  }).pipe(
    Effect.catchIf(Schema.is(MaintenanceRefused), (refused) =>
      HttpServerResponse.schemaJson(
        Schema.Struct({ message: Schema.String, reasons: Schema.Array(Schema.String) }),
      )({ message: refused.message, reasons: refused.reasons }, { status: 409 }),
    ),
    Effect.catchIf(Schema.is(AgentMaintenanceError), (error) =>
      Effect.logError("Maintenance operation failed", error.message).pipe(
        Effect.andThen(respondMessage({ message: error.message }, { status: 503 })),
      ),
    ),
  )

const status = HttpRouter.add(
  "GET",
  "/maintenance",
  withMaintenance((maintenance) =>
    maintenance.status().pipe(Effect.flatMap((current) => respondStatus(current))),
  ),
)

const hold = HttpRouter.add(
  "POST",
  "/maintenance/hold",
  withMaintenance((maintenance) =>
    HttpServerRequest.schemaBodyJson(HoldBody).pipe(
      Effect.flatMap((body) =>
        maintenance.hold({ reason: body.reason, expectedRelease: body.expectedRelease }),
      ),
      Effect.flatMap((current) => respondStatus(current)),
    ),
  ),
)

const advance = HttpRouter.add(
  "POST",
  "/maintenance/advance",
  withMaintenance((maintenance) =>
    maintenance.advance.pipe(Effect.flatMap((current) => respondStatus(current))),
  ),
)

const release = HttpRouter.add(
  "POST",
  "/maintenance/release",
  withMaintenance((maintenance) =>
    HttpServerRequest.schemaBodyJson(EpochBody).pipe(
      Effect.flatMap((body) => maintenance.release({ epoch: body.epoch })),
      Effect.flatMap((current) => respondStatus(current)),
    ),
  ),
)

export const MaintenanceRoutesLayer = Layer.mergeAll(status, hold, advance, release)
