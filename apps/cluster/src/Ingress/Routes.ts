import { JanitorApi } from "@janitor/domain/Api"
import { LiveRoutesLayer } from "./Live.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpRouter from "effect/http/HttpRouter"
import { type IngressSecrets, makeGitHubWebHookRoutesLayer } from "./GitHubWebhook.ts"
import {
  type AccessMiddlewareOptions,
  makeAccessMiddlewareLayer,
  makeApiMiddlewareLayer,
  makeAuthenticatedMiddlewareLayer,
  RateLimitMiddlewareLayer,
} from "./Middleware.ts"
import { AccountGroupLayer } from "./Account.ts"
import { RulesRoutesLayer } from "./Rules.ts"
import { ConnectionsGroupLayer } from "./Connections.ts"
import { SyncGroupLayer } from "./Sync.ts"
import { ReadinessRoutesLayer } from "./Readiness.ts"
import { PullRequestReviewGroupLayer } from "./PullRequestReview.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

/**
 * The `HttpApi` carries its own `/api/v1` prefix, so it stays outside
 * `ApiRouterLayer`, which would add it twice. Its middleware is provided to
 * the builder layer: provided to a group layer it type-checks but never wraps
 * the routes.
 */
const makeHttpApiLayer = (middleware: AccessMiddlewareOptions) =>
  HttpApiBuilder.layer(JanitorApi).pipe(
    Layer.provide(
      Layer.mergeAll(
        SyncGroupLayer,
        AccountGroupLayer,
        ConnectionsGroupLayer,
        PullRequestReviewGroupLayer,
      ),
    ),
    Layer.provide(makeApiMiddlewareLayer(middleware)),
  )

/**
 * The webhook route stays outside Access and relies on the GitHub signature,
 * Every human route sits behind the Access assertion check, which alone
 * decides who may use Janitor. The readiness probe needs Access only: a probe
 * is not a person, and must not be admitted as a teammate.
 */
export const makeRoutesLayer = (secrets: IngressSecrets, middleware: AccessMiddlewareOptions) =>
  Layer.mergeAll(
    Layer.mergeAll(
      makeGitHubWebHookRoutesLayer(secrets),
      Layer.mergeAll(LiveRoutesLayer, RulesRoutesLayer).pipe(
        Layer.provide(makeAuthenticatedMiddlewareLayer(middleware)),
      ),
      ReadinessRoutesLayer.pipe(Layer.provide(makeAccessMiddlewareLayer(middleware))),
    ).pipe(Layer.provide(ApiRouterLayer)),
    makeHttpApiLayer(middleware),
  ).pipe(Layer.provide(RateLimitMiddlewareLayer))
