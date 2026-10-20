import { JanitorApi } from "@janitor/domain/Api"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import type * as HttpApi from "effect/http-api/HttpApi"
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiTest from "effect/http-api/HttpApiTest"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"

type Group = typeof JanitorApi extends HttpApi.HttpApi<string, infer Groups> ? Groups : never
type GroupName = HttpApiGroup.Identifier<Group>

/** A service outside the scenario: fail on the first property read. */
export const unused = <I, S extends object>(tag: Context.Key<I, S>): S =>
  new Proxy({} as S, {
    get: (_target, property) => {
      throw new Error(`Unexpected use of ${tag.key}.${String(property)}`)
    },
  })

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
 * A typed client over the real `HttpApiBuilder` for the named groups, which
 * `groups` implements; endpoints of every other group die. `context` holds
 * what the handlers read per request: cluster stubs, `CurrentAccessIdentity`
 * or `CurrentTeammate`.
 */
export const makeClient = <const Names extends ReadonlyArray<GroupName>, R, S>(
  names: Names,
  groups: Layer.Layer<HttpApiGroup.Service<"janitor", Names[number]>, never, R>,
  context: Context.Context<S>,
) =>
  HttpApiTest.groups(JanitorApi, names).pipe(
    Effect.provide(groups),
    Effect.provide(requestServices(context)),
    Effect.provide(HttpServer.layerServices),
  )
