import { LiveRoutesLayer } from "./Live.ts"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as AccessJwt from "./AccessJwt.ts"
import { type IngressSecrets, makeGitHubWebHookRoutesLayer } from "./GitHubWebhook.ts"
import {
  type AccessMiddlewareOptions,
  makeAuthenticatedMiddlewareLayer,
  RateLimitMiddlewareLayer,
} from "./Middleware.ts"
import { AccountRoutesLayer } from "./Account.ts"
import { RulesRoutesLayer } from "./Rules.ts"
import { ConnectionRoutesLayer } from "./Connections.ts"
import { SyncRoutesLayer } from "./Sync.ts"
import { ReadinessRoutesLayer } from "./Readiness.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

/**
 * The webhook route stays outside Access and relies on the GitHub signature.
 * Every human route sits behind the Access assertion check and requires an
 * active Janitor membership.
 */
export const makeRoutesLayer = (
  secrets: IngressSecrets,
  access: AccessJwt.AccessVerifierConfig,
  middleware: AccessMiddlewareOptions,
) =>
  Layer.mergeAll(
    makeGitHubWebHookRoutesLayer(secrets),
    Layer.mergeAll(
      LiveRoutesLayer,
      SyncRoutesLayer,
      RulesRoutesLayer,
      ConnectionRoutesLayer,
      ReadinessRoutesLayer,
      AccountRoutesLayer,
    ).pipe(
      Layer.provide(makeAuthenticatedMiddlewareLayer(middleware)),
      Layer.provide(AccessJwt.layerFrom(access)),
    ),
  ).pipe(Layer.provide(RateLimitMiddlewareLayer), Layer.provide(ApiRouterLayer))
