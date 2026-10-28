import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * The platform-neutral side of a chat thread (EFF-3018). The session entity
 * and its status presenter talk to Slack and Discord only through
 * `ChatPlatform`; "Slack ingress for the chat bot" (EFF-3019) and "Discord
 * ingress for the chat bot" (EFF-3020) implement it.
 */

/** One Slack thread or one Discord thread: what a chat session is for. */
export const ChatThread = Schema.TaggedUnion({
  Slack: { team: Schema.String, channel: Schema.String, threadTs: Schema.String },
  Discord: { guild: Schema.String, threadId: Schema.String },
})
export type ChatThread = typeof ChatThread.Type

/** The session key, and the session entity's id: `slack/{team}/{channel}/{thread_ts}` or `discord/{guild}/{thread_id}`. */
export const sessionKey = (thread: ChatThread): string =>
  thread._tag === "Slack"
    ? `slack/${thread.team}/${thread.channel}/${thread.threadTs}`
    : `discord/${thread.guild}/${thread.threadId}`

/**
 * Who wrote a message, as ingress classified it: an admitted user, an
 * outsider (no role, a guest, a Slack Connect user) or any bot account,
 * janitor's included. Only admitted messages start or steer a turn.
 */
export const AuthorClass = Schema.Literals(["admitted", "outsider", "bot"])
export type AuthorClass = typeof AuthorClass.Type

/** A file attached to a thread message; `download` fetches its bytes. */
export const ChatAttachment = Schema.Struct({
  /** The platform's file id: the Slack file id or the Discord attachment id. */
  id: Schema.String,
  name: Schema.String,
  mediaType: Schema.String,
  /** In bytes, as the platform reports it. */
  size: Schema.Int,
})
export type ChatAttachment = typeof ChatAttachment.Type

/** A thread message, as ingress hands it to the session. */
export const ChatMessage = Schema.Struct({
  /** The platform's message id: the Slack `ts` or the Discord snowflake. Sessions dedupe on it. */
  id: Schema.String,
  author: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    class: AuthorClass,
  }),
  /** The message text, with mentions of the bot removed. */
  text: Schema.String,
  mentionsBot: Schema.Boolean,
  sentAt: Schema.DateTimeUtc,
  attachments: Schema.Array(ChatAttachment),
})
export type ChatMessage = typeof ChatMessage.Type

export class ChatPlatformError extends Schema.TaggedError<ChatPlatformError>()(
  "ChatPlatformError",
  { message: Schema.String },
) {}

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
    postStatus: () =>
      Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" })),
    editStatus: () =>
      Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" })),
    postReply: () =>
      Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" })),
    uploadFile: () =>
      Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" })),
    download: () =>
      Effect.fail(new ChatPlatformError({ message: "No chat platform is connected" })),
    history: () => Effect.succeed([]),
  })
}
