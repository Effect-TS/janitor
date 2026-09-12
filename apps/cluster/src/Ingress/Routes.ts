import { LiveRoutesLayer } from "./Live.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as AccessJwt from "./AccessJwt.ts"
import { type IngressSecrets, makeGitHubWebHookRoutesLayer } from "./GitHubWebhook.ts"
import {
  type AccessMiddlewareOptions,
  makeAccessMiddlewareLayer,
  makeAuthenticatedMiddlewareLayer,
  RateLimitMiddlewareLayer,
} from "./Middleware.ts"
import { AccountRoutesLayer } from "./Account.ts"
import { RulesRoutesLayer } from "./Rules.ts"
import { ConnectionRoutesLayer } from "./Connections.ts"
import { SyncRoutesLayer } from "./Sync.ts"
import { ReadinessRoutesLayer } from "./Readiness.ts"
import { RepositoryExecutionRoutes } from "./RepositoryExecution.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

/**
 * The webhook route stays outside Access and relies on the GitHub signature.
 * Every human route sits behind the Access assertion check and requires an
 * active Janitor membership. The readiness probe needs Access only: a probe
 * is not a person, and must not be admitted as a teammate.
 */
export const makeRoutesLayer = (
  secrets: IngressSecrets,
  access: AccessJwt.AccessVerifierConfig,
  middleware: AccessMiddlewareOptions,
) =>
  Layer.mergeAll(
    makeGitHubWebHookRoutesLayer(secrets),
    RepositoryExecutionRoutes,
    Layer.mergeAll(
      LiveRoutesLayer,
      SyncRoutesLayer,
      RulesRoutesLayer,
      ConnectionRoutesLayer,
      AccountRoutesLayer,
    ).pipe(Layer.provide(makeAuthenticatedMiddlewareLayer(middleware))),
    ReadinessRoutesLayer.pipe(Layer.provide(makeAccessMiddlewareLayer(middleware))),
  )
    .pipe(Layer.provide(AccessJwt.layerFrom(access)))
    .pipe(Layer.provide(RateLimitMiddlewareLayer), Layer.provide(ApiRouterLayer))
