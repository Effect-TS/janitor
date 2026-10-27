import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ChatSandbox } from "./ChatSandbox.ts"
import {
  makeChatWorkspace,
  type ChatAcquired,
  type ChatAcquireError,
  type ChatAcquireInput,
  type ChatWorkspaceState,
} from "./Workspace.ts"

/**
 * The chat workspace Durable Object: one per chat session, named by the
 * session id, owning that session's sandbox container. `acquire` and
 * `destroy` are its RPC methods; executor RPC arrives on its `fetch` and goes
 * to the container's port. Its egress goes through the `GitEgress`
 * entrypoint PR review exports.
 */
export interface ChatWorkspaceShape {
  readonly acquire: (input: ChatAcquireInput) => Effect.Effect<ChatAcquired, ChatAcquireError>
  /** Stops the container, unless a grant newer than `lease` acquired it since. */
  readonly destroy: (input: { readonly lease: number | null }) => Effect.Effect<void>
}

export class ChatWorkspace extends Cloudflare.DurableObject<ChatWorkspace, ChatWorkspaceShape>()(
  "ChatWorkspace",
) {}

export const ChatWorkspaceLive = ChatWorkspace.make(
  Effect.gen(function* () {
    // Attaches the container application to this class. The handle alchemy
    // would start is not used: the workspace drives `ctx.container` itself.
    yield* (ChatSandbox as unknown as Record<string, Effect.Effect<unknown>>)[
      "~alchemy/Container/Binding"
    ]!
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const workspace = yield* makeChatWorkspace(state.raw as unknown as ChatWorkspaceState)
      return {
        acquire: (input: ChatAcquireInput) => workspace.acquire(input),
        destroy: ({ lease }: { readonly lease: number | null }) => workspace.destroy(lease),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const response = yield* workspace.forward(yield* HttpServerRequest.toWeb(request))
          // The Response itself as the body, so the ndjson stream passes through untouched.
          return HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: response.status }),
            HttpBody.raw(response),
          )
        }).pipe(Effect.orDie),
      }
    })
  }),
)
