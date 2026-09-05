import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as AccessJwt from "./AccessJwt.ts"
import { type IngressSecrets, makeGitHubWebHookRoutesLayer } from "./GitHubWebhook.ts"
import {
  type AccessMiddlewareOptions,
  makeAccessMiddlewareLayer,
  RateLimitMiddlewareLayer,
} from "./Middleware.ts"
import { RulesRoutesLayer } from "./Rules.ts"
import { ConnectionRoutesLayer } from "./Connections.ts"
import { SyncRoutesLayer } from "./Sync.ts"

const ApiRouterLayer = Layer.effect(
  HttpRouter.HttpRouter,
  Effect.map(HttpRouter.HttpRouter, (router) => router.prefixed("/api/v1")),
)

/**
 * The webhook route stays outside Access and relies on the GitHub signature.
 * Every human route sits behind the Access assertion check.
 */
export const makeRoutesLayer = (
  secrets: IngressSecrets,
  access: AccessJwt.AccessVerifierConfig,
  middleware: AccessMiddlewareOptions,
) =>
  Layer.mergeAll(
    makeGitHubWebHookRoutesLayer(secrets),
    Layer.mergeAll(SyncRoutesLayer, RulesRoutesLayer, ConnectionRoutesLayer).pipe(
      Layer.provide(makeAccessMiddlewareLayer(middleware)),
      Layer.provide(AccessJwt.layerFrom(access)),
    ),
  ).pipe(Layer.provide(RateLimitMiddlewareLayer), Layer.provide(ApiRouterLayer))
