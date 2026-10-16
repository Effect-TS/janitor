import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { type EgressContainer, makeTailnetEgress } from "./TailnetEgress.ts"
import { TailnetEgressContainer } from "./TailnetEgressContainer.ts"

/**
 * The tailnet egress Durable Object: one instance, named
 * `TAILNET_EGRESS_NAME`, owning the tailnet egress container. Model requests
 * arrive on its `fetch` and go to the container's port.
 */
export class TailnetEgress extends Cloudflare.DurableObject<TailnetEgress, {}>()(
  "PullRequestReviewTailnetEgress",
) {}

export const TailnetEgressLive = TailnetEgress.make(
  Effect.gen(function* () {
    // Attaches the container application to this class. The handle alchemy
    // would start is not used: the egress drives `ctx.container` itself.
    yield* (TailnetEgressContainer as unknown as Record<string, Effect.Effect<unknown>>)[
      "~alchemy/Container/Binding"
    ]!
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const raw = state.raw as unknown as { readonly container: EgressContainer }
      const egress = yield* makeTailnetEgress(raw.container)
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const response = yield* egress.forward(yield* HttpServerRequest.toWeb(request))
          // The Response itself as the body, so streamed completions pass
          // through untouched, as the workspace's executor stream does.
          return HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: response.status }),
            HttpBody.raw(response),
          )
        }).pipe(Effect.orDie),
      }
    })
  }),
)
