import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { ChatAttachment, ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"

/**
 * The platform-neutral side of a chat thread (EFF-3018). The session entity
 * and its status presenter talk to Slack and Discord only through
 * `ChatPlatform`; "Slack ingress for the chat bot" (EFF-3019) and "Discord
 * ingress for the chat bot" (EFF-3020) implement it.
 */

export { AuthorClass, ChatAttachment, ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"

/** The session key, and the session entity's id: `slack/{team}/{channel}/{thread_ts}` or `discord/{guild}/{thread_id}`. */
export const sessionKey = (thread: ChatThread): string =>
  thread._tag === "Slack"
    ? `slack/${thread.team}/${thread.channel}/${thread.threadTs}`
    : `discord/${thread.guild}/${thread.threadId}`

export class ChatPlatformError extends Schema.TaggedError<ChatPlatformError>()(
  "ChatPlatformError",
  { message: Schema.String },
) {}

/**
 * Reads a download's body for a transport's `download`, failing as soon
 * as more than `maxBytes` arrive, without reading or buffering the rest.
 * Pass it `HttpClientResponse.stream`.
 */
export const readLimited = <E>(
  body: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
): Effect.Effect<Uint8Array, ChatPlatformError> =>
  Effect.suspend(() => {
    let size = 0
    return body.pipe(
      Stream.mapError((error) => new ChatPlatformError({ message: String(error) })),
      Stream.mapEffect((chunk) => {
        size += chunk.length
        return size > maxBytes
          ? Effect.fail(new ChatPlatformError({ message: `larger than ${maxBytes} bytes` }))
          : Effect.succeed(chunk)
      }),
      Stream.runCollect,
      Effect.map((chunks) => {
        const content = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          content.set(chunk, offset)
          offset += chunk.length
        }
        return content
      }),
    )
  })

const noPlatform = Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" }))

export class ChatPlatform extends Context.Service<
  ChatPlatform,
  {
    /** Posts a turn's status message; succeeds with its message id. */
    readonly postStatus: (
      thread: ChatThread,
      text: string,
    ) => Effect.Effect<string, ChatPlatformError>
    readonly editStatus: (
      thread: ChatThread,
      messageId: string,
      text: string,
    ) => Effect.Effect<void, ChatPlatformError>
    /** Posts a reply, split into as many messages as the platform needs. */
    readonly postReply: (thread: ChatThread, text: string) => Effect.Effect<void, ChatPlatformError>
    readonly uploadFile: (
      thread: ChatThread,
      file: { readonly name: string; readonly content: string },
    ) => Effect.Effect<void, ChatPlatformError>
    /**
     * An attachment's bytes. Reading stops past `maxBytes`, and a longer
     * file fails, whatever size the platform reported.
     */
    readonly download: (
      thread: ChatThread,
      attachment: ChatAttachment,
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, ChatPlatformError>
    /** The thread's latest messages, oldest first, for the backfill when the bot joins it. */
    readonly history: (
      thread: ChatThread,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ChatMessage>, ChatPlatformError>
  }
>()("@janitor/cluster/Chat/Platform/ChatPlatform") {
  /**
   * No platform connected: every post fails and threads have no history.
   * The Worker binds it until Slack ingress (EFF-3019) supplies a platform.
   */
  static readonly unavailable = Layer.succeed(this, {
    postStatus: () => noPlatform,
    editStatus: () => noPlatform,
    postReply: () => noPlatform,
    uploadFile: () => noPlatform,
    download: () => noPlatform,
    history: () => Effect.succeed([]),
  })
}
