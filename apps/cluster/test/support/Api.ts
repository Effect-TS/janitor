import { JanitorApi } from "@janitor/domain/Api"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as HttpApi from "effect/http-api/HttpApi"
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiTest from "effect/http-api/HttpApiTest"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"

type Group = typeof JanitorApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never
type GroupName = HttpApiGroup.Identifier<Group>

/**
 * Provides request-time services the way the Worker's per-request context
 * does. `Effect.provideService` can't discharge a group layer's
 * `HttpRouter.Request<"Requires", …>`; a router middleware can.
 */
const requestServices = <S>(
  context: Context.Context<S>,
): Layer.Layer<HttpRouter.Request.From<"Requires", S>> =>
  // `.layer` is conditional on `S`, which stays unresolved while `S` is generic.
  HttpRouter.middleware<{ provides: S }>()((app) => Effect.provideContext(app, context))
    .layer as Layer.Layer<HttpRouter.Request.From<"Requires", S>>

/**
 * A typed client over the real `HttpApiBuilder` for the groups `groups`
 * implements; endpoints of every other group die. `context` holds what the
 * handlers read per request: cluster stubs, `CurrentAccessIdentity` or
 * `CurrentTeammate`.
 */
export const makeClient = <Name extends GroupName, R, S>(
  groups: Layer.Layer<HttpApiGroup.Service<"janitor", Name>, never, R>,
  context: Context.Context<S>,
) =>
  Effect.gen(function* () {
    const provided = yield* Effect.context<never>()
    const names = Object.values(JanitorApi.groups)
      .filter((group) => Option.isSome(Context.getOption(provided, group as never)))
      .map((group) => group.identifier as Name)
    return yield* HttpApiTest.groups(JanitorApi, names)
  }).pipe(
    Effect.provide(groups),
    Effect.provide(requestServices(context)),
    Effect.provide(HttpServer.layerServices),
  )
