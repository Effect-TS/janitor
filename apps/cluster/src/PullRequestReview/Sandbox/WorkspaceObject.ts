import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { GitHubAppAuth } from "../../GitHub/AppAuth.ts"
import { SandboxContainer } from "./SandboxContainer.ts"
import {
  makeWorkspace,
  type AcquireError,
  type AcquireInput,
  type WorkspaceState,
} from "./Workspace.ts"

/**
 * The workspace Durable Object: one per run, named by the run id, owning
 * that run's sandbox container. `acquire` and `release` are its RPC methods;
 * executor RPC arrives on its `fetch` and goes to the container's port.
 */
export interface ReviewWorkspaceShape {
  readonly acquire: (input: AcquireInput) => Effect.Effect<void, AcquireError>
  readonly release: () => Effect.Effect<void>
}

export class ReviewWorkspace extends Cloudflare.DurableObject<
  ReviewWorkspace,
  ReviewWorkspaceShape
>()("PullRequestReviewWorkspace") {}

/**
 * Re-exports `GitEgress` from the Worker's entry module, so
 * `ctx.exports.GitEgress` exists for the intercepts. The patched alchemy
 * entry turns an `entrypointModule` export into
 * `export { GitEgress } from "<module>"`; the module itself is only ever
 * loaded in the Worker, where `cloudflare:workers` exists.
 */
export const exportGitEgress = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return
  const worker = yield* Cloudflare.Worker
  yield* worker.export("GitEgress", {
    kind: "entrypointModule",
    module: decodeURIComponent(new URL("./GitEgress.ts", import.meta.url).pathname),
    exportName: "GitEgress",
  })
})

export const ReviewWorkspaceLive = ReviewWorkspace.make(
  Effect.gen(function* () {
    // Attaches the container application to this class. The handle alchemy
    // would start is not used: the workspace drives `ctx.container` itself.
    yield* (SandboxContainer as unknown as Record<string, Effect.Effect<unknown>>)[
      "~alchemy/Container/Binding"
    ]!
    const state = yield* Cloudflare.DurableObjectState
    const auth = yield* GitHubAppAuth

    return Effect.gen(function* () {
      const workspace = yield* makeWorkspace(state.raw as unknown as WorkspaceState).pipe(
        Effect.provideService(GitHubAppAuth, auth),
      )
      return {
        acquire: (input: AcquireInput) => workspace.acquire(input),
        release: () => workspace.release,
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const web = yield* HttpServerRequest.toWeb(request)
          const response = yield* workspace.forward(web)
          // The Response itself as the body, so the ndjson stream passes
          // through untouched, as EFF-1875 ran it.
          return HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: response.status }),
            HttpBody.raw(response),
          )
        }).pipe(Effect.orDie),
      }
    })
  }),
)
