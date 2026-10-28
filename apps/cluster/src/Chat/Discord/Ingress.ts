import type { DiscordREST } from "dfx/DiscordREST"
import type * as Discord from "dfx/types"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { ChatMessage, ChatThread } from "../Platform.ts"
import type { DiscordBotConfig } from "./Config.ts"

export class DiscordSessionError extends Schema.TaggedError<DiscordSessionError>()(
  "DiscordSessionError",
  { message: Schema.String },
) {}

/** What Discord ingress asks of the chat session entities. */
export class DiscordSessions extends Context.Service<
  DiscordSessions,
  {
    /** Hands a message to its thread's session. */
    readonly receive: (
      thread: ChatThread,
      message: ChatMessage,
    ) => Effect.Effect<void, DiscordSessionError>
    /** Whether the thread has a session, so a reply without a mention reaches it. */
    readonly exists: (thread: ChatThread) => Effect.Effect<boolean, DiscordSessionError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordSessions") {}

/**
 * The message ids the gateway has handed on, kept in the gateway Durable
 * Object's storage. A RESUME replays what arrived while the socket was dark,
 * and a rebuilt instance reads the same storage, so a replayed message is
 * dropped.
 */
export class SeenMessages extends Context.Service<
  SeenMessages,
  {
    /** Records the id; succeeds with false when it was already recorded. */
    readonly claim: (messageId: string) => Effect.Effect<boolean>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/SeenMessages") {}

/**
 * The gateway Durable Object's ingress: it filters a `MESSAGE_CREATE`,
 * admits its author by `member.roles` and hands the message to its thread's
 * session, creating the thread for a channel mention.
 */
export class DiscordIngress extends Context.Service<
  DiscordIngress,
  {
    readonly handle: (
      message: Discord.GatewayMessageCreateDispatchData,
    ) => Effect.Effect<void, DiscordSessionError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordIngress") {}

/** Not implemented yet: the tests in `test/Chat/Discord` describe it. */
export const layer: Layer.Layer<
  DiscordIngress,
  never,
  DiscordBotConfig | DiscordSessions | SeenMessages | DiscordREST
> = Layer.succeed(DiscordIngress, {
  handle: () => Effect.die("Discord ingress is not implemented"),
})
