import * as Cloudflare from "alchemy/Cloudflare"
import * as RuntimeContext from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { type AccessIdentity, AccessVerifier } from "./AccessJwt.ts"

const RateLimitHeaders = Schema.Struct({
  "cf-connecting-ip": Schema.OptionFromOptional(Schema.String),
})

export const RateLimitMiddlewareLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const rateLimit = yield* Cloudflare.RateLimit("WebhookRateLimit", {
      namespaceId: 1,
      simple: { limit: 300, period: 60 },
    })

    return Effect.fnUntraced(function* (app) {
      const headers = yield* HttpServerRequest.schemaHeaders(RateLimitHeaders)
      const ip = headers["cf-connecting-ip"]
      return yield* Option.match(ip, {
        onNone: () => app,
        onSome: Effect.fnUntraced(function* (ip) {
          const limit = yield* rateLimit.limit({ key: ip })
          if (limit.success) {
            return yield* app
          }
          return HttpServerResponse.text("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "60" },
          })
        }),
      })
    })
  }),
  { global: true },
)

/** The verified Access identity of the current request. */
export class CurrentAccessIdentity extends Context.Service<CurrentAccessIdentity, AccessIdentity>()(
  "@janitor/cluster/Ingress/Middleware/CurrentAccessIdentity",
) {}

const unauthorizedResponse = HttpServerResponse.empty({ status: 401 })

export interface AccessMiddlewareOptions {
  /**
   * The audience of the Access context `alchemy dev` simulates. Set only by
   * the bind phase when it runs under `alchemy dev`; every deployed Worker
   * passes `undefined`, which makes the local fallback unreachable.
   */
  readonly localDevAudience: string | undefined
}

/** How the middleware learns whether a local audience exists. */
export class AccessMiddlewareConfig extends Context.Service<
  AccessMiddlewareConfig,
  AccessMiddlewareOptions
>()("@janitor/cluster/Ingress/Middleware/AccessMiddlewareConfig") {}

/** Local identities are attributed to this issuer so they stand out in audit. */
export const LOCAL_DEV_ISSUER = "local-dev"
const LOCAL_DEV_SESSION = Duration.hours(1)

let warnedLocalDev = false

/**
 * Without an assertion header there is one way in: the Worker was built
 * under `alchemy dev` with a local audience, and the simulated Access
 * context on this request carries exactly that audience. Real audiences are
 * hex tags, so a stub can never collide with one.
 *
 * The execution context is captured when the layer is built. Alchemy provides
 * a deferred one at init whose `access` resolves the live per-request context
 * from the calling fiber, so a route middleware can read it without declaring
 * a per-request dependency. `RuntimeContext` on `access` is a type-level
 * colour only (its phantom layer is empty); the handler fiber carries the
 * real one.
 */
const localDevIdentity = (
  audience: string,
  execution: Cloudflare.Workers.WorkerExecutionContext["Service"],
): Effect.Effect<AccessIdentity | undefined> =>
  Effect.gen(function* () {
    const access = yield* execution.access
    if (access === undefined || access.aud !== audience) {
      return undefined
    }
    const identity = yield* access.getIdentity().pipe(Effect.orElseSucceed(() => undefined))
    const email = identity?.email
    if (!warnedLocalDev) {
      warnedLocalDev = true
      yield* Effect.logWarning("Access is simulated: requests are attributed to a local identity")
    }
    const now = yield* DateTime.now
    return {
      issuer: LOCAL_DEV_ISSUER,
      subject: email ?? LOCAL_DEV_ISSUER,
      email,
      expiresAt: DateTime.addDuration(now, LOCAL_DEV_SESSION),
    }
  }).pipe(Effect.provide(RuntimeContext.RuntimeContext.phantom))

/**
 * Admits a request only when it carries an assertion the `AccessVerifier`
 * accepts, and makes the identity available to the route. Failures answer
 * 401 with an empty body: the browser is redirected to the Access login by
 * Cloudflare before it ever reaches here, so anything that arrives without a
 * valid assertion is not a person who needs a hint. A header, when present,
 * is always verified; the local fallback only applies when there is none.
 */
export const AccessMiddleware = HttpRouter.middleware<{ provides: CurrentAccessIdentity }>()(
  Effect.gen(function* () {
    const verifier = yield* AccessVerifier
    const options = yield* AccessMiddlewareConfig
    const execution = yield* Cloudflare.Workers.WorkerExecutionContext

    return Effect.fnUntraced(function* (app) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const assertion = request.headers["cf-access-jwt-assertion"]
      const localDevAudience = options.localDevAudience
      const identity =
        assertion === undefined
          ? localDevAudience === undefined || localDevAudience.length === 0
            ? yield* Effect.logWarning("Access assertion missing").pipe(Effect.as(undefined))
            : yield* localDevIdentity(localDevAudience, execution)
          : yield* verifier.verify(assertion).pipe(
              Effect.catchTags({
                AccessAssertionRejected: (error) =>
                  Effect.logWarning("Access assertion rejected", error.reason).pipe(
                    Effect.as(undefined),
                  ),
                AccessKeysUnavailable: (error) =>
                  Effect.logError("Access signing keys unavailable", error.cause).pipe(
                    Effect.as(undefined),
                  ),
              }),
            )
      if (identity === undefined) {
        return unauthorizedResponse
      }
      return yield* app.pipe(
        Effect.provideService(CurrentAccessIdentity, identity),
        Effect.annotateLogs({ accessIssuer: identity.issuer, accessSubject: identity.subject }),
      )
    })
  }),
)

export const makeAccessMiddlewareLayer = (options: AccessMiddlewareOptions) =>
  AccessMiddleware.layer.pipe(Layer.provide(Layer.succeed(AccessMiddlewareConfig, options)))

/** The production shape: no local audience, so a missing header is a 401. */
export const AccessMiddlewareLayer = makeAccessMiddlewareLayer({ localDevAudience: undefined })
