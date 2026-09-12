import {
  AccountView,
  LinkedAccount,
  LinkPlatform,
  LinkReturnRequest,
  SetRoleRequest,
  TeammateId,
} from "@janitor/domain/Team/Account"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Request from "effect/unstable/http/HttpServerRequest"
import * as Response from "effect/unstable/http/HttpServerResponse"
import { AccountLinking } from "../AccountLinking.ts"
import {
  isTeammateError,
  type TeammateError,
  type TeammateErrorReason,
  Teammates,
} from "../Teammates.ts"
import { CurrentTeammate } from "./Middleware.ts"
import { SameOriginMiddleware } from "./Sync.ts"

/**
 * Account screens: the signed-in teammate's identity and connected accounts,
 * and the admin-only team roster. Roles are enforced by `Teammates`; these
 * routes only translate outcomes into responses.
 */

const respondMessage = Response.schemaJson(Schema.Struct({ message: Schema.String }))

const STATUS_BY_REASON: Record<TeammateErrorReason, number> = {
  forbidden: 403,
  removed: 403,
  "not-found": 404,
  "last-admin": 409,
  conflict: 409,
  expired: 410,
  rejected: 422,
  unavailable: 503,
}

/** Teammate outcomes become responses; request-shape errors keep their own status. */
const handled = <E, R>(effect: Effect.Effect<Response.HttpServerResponse, E | TeammateError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error: E | TeammateError): error is TeammateError => isTeammateError(error),
      (error) =>
        respondMessage({ message: error.message }, { status: STATUS_BY_REASON[error.reason] }),
    ),
  )

const PlatformPath = Schema.Struct({ platform: LinkPlatform })
const LinkPath = Schema.Struct({ linkId: Schema.String })
const TeammatePath = Schema.Struct({ teammateId: TeammateId })

const reads = HttpRouter.add(
  "GET",
  "/account",
  Effect.gen(function* () {
    const teammate = yield* CurrentTeammate
    const linking = yield* AccountLinking
    const view = yield* (yield* Teammates).account(teammate.teammateId, linking.availability)
    return yield* Response.schemaJson(AccountView)(view)
  }).pipe(handled),
)

const writes = HttpRouter.addAll([
  HttpRouter.route(
    "POST",
    "/account/links/:platform/start",
    Effect.gen(function* () {
      const { platform } = yield* HttpRouter.schemaPathParams(PlatformPath)
      const teammate = yield* CurrentTeammate
      const url = yield* (yield* AccountLinking).start(teammate.teammateId, platform)
      return yield* Response.schemaJson(Schema.Struct({ url: Schema.String }))({ url })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "POST",
    "/account/links/:platform/return",
    Effect.gen(function* () {
      const { platform } = yield* HttpRouter.schemaPathParams(PlatformPath)
      const body = yield* Request.schemaBodyJson(LinkReturnRequest)
      const teammate = yield* CurrentTeammate
      const linked = yield* (yield* AccountLinking).complete(teammate.teammateId, platform, body)
      return yield* Response.schemaJson(LinkedAccount)(linked)
    }).pipe(handled),
  ),
  HttpRouter.route(
    "DELETE",
    "/account/links/:linkId",
    Effect.gen(function* () {
      const { linkId } = yield* HttpRouter.schemaPathParams(LinkPath)
      const teammate = yield* CurrentTeammate
      yield* (yield* Teammates).disconnect(teammate.teammateId, linkId)
      return Response.empty({ status: 204 })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "PUT",
    "/team/:teammateId/role",
    Effect.gen(function* () {
      const { teammateId } = yield* HttpRouter.schemaPathParams(TeammatePath)
      const { role } = yield* Request.schemaBodyJson(SetRoleRequest)
      const actor = yield* CurrentTeammate
      yield* (yield* Teammates).setRole(actor.teammateId, teammateId, role)
      return Response.empty({ status: 204 })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "DELETE",
    "/team/:teammateId",
    Effect.gen(function* () {
      const { teammateId } = yield* HttpRouter.schemaPathParams(TeammatePath)
      const actor = yield* CurrentTeammate
      yield* (yield* Teammates).remove(actor.teammateId, teammateId)
      return Response.empty({ status: 204 })
    }).pipe(handled),
  ),
  HttpRouter.route(
    "POST",
    "/team/:teammateId/restore",
    Effect.gen(function* () {
      const { teammateId } = yield* HttpRouter.schemaPathParams(TeammatePath)
      const actor = yield* CurrentTeammate
      yield* (yield* Teammates).restore(actor.teammateId, teammateId)
      return Response.empty({ status: 204 })
    }).pipe(handled),
  ),
]).pipe(Layer.provide(SameOriginMiddleware))

export const AccountRoutesLayer = Layer.mergeAll(reads, writes)
