import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/http/HttpBody"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ChatCredentials } from "../Egress/BotApp.ts"
import { EGRESS_CONTROL_HEADER } from "../Egress/Session.ts"
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
 * to the container's port, and the egress entrypoint's control requests
 * are answered here. Its egress goes through the `ChatEgress` entrypoint.
 */
export interface ChatWorkspaceShape {
  readonly acquire: (input: ChatAcquireInput) => Effect.Effect<ChatAcquired, ChatAcquireError>
  /** The turn holding `generation` ended. */
  readonly release: (input: { readonly generation: number }) => Effect.Effect<void>
  /** Stops the container, unless a grant newer than `generation` acquired it since. */
  readonly destroy: (input: { readonly generation: number }) => Effect.Effect<void>
}

export class ChatWorkspace extends Cloudflare.DurableObject<ChatWorkspace, ChatWorkspaceShape>()(
  "ChatWorkspace",
) {}

/**
 * Re-exports `ChatEgress` from the Worker's entry module, so
 * `ctx.exports.ChatEgress` exists for the intercepts, as `exportGitEgress`
 * does for PR review.
 */
export const exportChatEgress = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return
  const worker = yield* Cloudflare.Worker
  yield* worker.export("ChatEgress", {
    kind: "entrypointModule",
    module: decodeURIComponent(new URL("../Egress/ChatEgress.ts", import.meta.url).pathname),
    exportName: "ChatEgress",
  })
})

export const ChatWorkspaceLive = ChatWorkspace.make(
  Effect.gen(function* () {
    // Attaches the container application to this class. The handle alchemy
    // would start is not used: the workspace drives `ctx.container` itself.
    yield* (ChatSandbox as unknown as Record<string, Effect.Effect<unknown>>)[
      "~alchemy/Container/Binding"
    ]!
    const state = yield* Cloudflare.DurableObjectState
    const credentials = yield* ChatCredentials

    return Effect.gen(function* () {
      const workspace = yield* makeChatWorkspace(state.raw as unknown as ChatWorkspaceState).pipe(
        Effect.provideService(ChatCredentials, credentials),
      )
      return {
        acquire: (input: ChatAcquireInput) => workspace.acquire(input),
        release: ({ generation }: { readonly generation: number }) => workspace.release(generation),
        destroy: ({ generation }: { readonly generation: number }) => workspace.destroy(generation),
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const web = yield* HttpServerRequest.toWeb(request)
          const response = web.headers.has(EGRESS_CONTROL_HEADER)
            ? yield* workspace.egressControl(web)
            : yield* workspace.forward(web)
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
