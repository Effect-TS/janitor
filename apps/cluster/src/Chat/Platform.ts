import * as Chat from "effect/chat/Chat"
import type * as ChatAdapter from "effect/chat/ChatAdapter"
import type { ChatError } from "effect/chat/ChatError"
import * as ChatMarkdown from "effect/chat/ChatMarkdown"
import type * as ChatMessages from "effect/chat/ChatMessage"
import type * as ChatThreads from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { ChatAttachment, ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"

/**
 * The platform-neutral side of a chat thread (EFF-3018). The session entity
 * and its status presenter talk to Slack and Discord only through
 * `ChatPlatform`. Slack's and Discord's implement it over `effect/chat`'s
 * `Chat` router and `ChatMarkdown`, with the `@effect/chat-slack` and
 * `@effect/chat-discord` adapters registered in it.
 */

export { AuthorClass, ChatAttachment, ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"

/** The session key, and the session entity's id: `slack/{team}/{channel}/{thread_ts}` or `discord/{guild}/{thread_id}`. */
export const sessionKey = (thread: ChatThread): string =>
  thread._tag === "Slack"
    ? `slack/${thread.team}/${thread.channel}/${thread.threadTs}`
    : `discord/${thread.guild}/${thread.threadId}`

/**
 * What an admitted user's 👍 on one of the bot's messages hands the session
 * (EFF-3163): a message that counts as a mention, so a yes/no question or a
 * request for approval can be answered with a reaction.
 */
export const APPROVAL_TEXT = "👍 (reacted with a thumbs up to your message: approved)"

/** An approval's message id, unlike any platform message id, so sessions store each once. */
export const approvalMessageId = (messageId: string, userId: string): string =>
  `reaction/${messageId}/${userId}`

export class ChatPlatformError extends Schema.TaggedError<ChatPlatformError>()(
  "ChatPlatformError",
  { message: Schema.String },
) {}

/** A failed `effect/chat` call, by its reason only: a reason never quotes a message. */
export const fromChatError = (
  error: ChatError | ChatMarkdown.ChatMarkdownError | ChatPlatformError,
): ChatPlatformError =>
  error._tag === "ChatPlatformError" ? error : new ChatPlatformError({ message: error.message })

/**
 * The message's text without the mentions `isBot` picks, by their offsets,
 * so only mentions the platform resolved outside code are cut.
 */
export const withoutMentions = (
  message: ChatMessages.ChatMessage,
  isBot: (mention: ChatMessages.Mention) => boolean,
): string => {
  let text = message.text
  const cut = message.mentions.filter(isBot).sort((a, b) => b.start - a.start)
  for (const mention of cut) text = text.slice(0, mention.start) + text.slice(mention.end)
  return text
}

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
      Stream.mapError(
        (error) =>
          new ChatPlatformError({
            message: error instanceof Error ? error.message : String(error),
          }),
      ),
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

/** A file posted to a thread: its name as the thread shows it, its bytes and their content type. */
export interface ChatFile {
  readonly name: string
  readonly contentType: string
  readonly content: Uint8Array
}

/** The file the rest of a reply too long for its messages is uploaded as. */
export const REPLY_FILE = "reply.md"

/** The note naming the files that couldn't be posted with a reply. */
const unattachedNote = (files: ReadonlyArray<{ readonly name: string }>): string =>
  `(Couldn't attach ${files.map((file) => file.name).join(", ")}.)`

/** `text` ending in the note naming the files that couldn't be posted with it. */
export const notingUnattached = (text: string, files: ReadonlyArray<ChatFile>): string => {
  const note = unattachedNote(files)
  return text === "" ? note : `${text}\n\n${note}`
}

/**
 * Whether a post failed before any part went out, with a reason `refused`
 * picks, so it can be posted again differently.
 */
export const refusedBeforePosting = (
  error: ChatMarkdown.ChatMarkdownError,
  refused: (error: ChatError) => boolean,
): boolean => error.posted.length === 0 && error.cause._tag === "Chat" && refused(error.cause.error)

/**
 * Posts a reply with `ChatMarkdown.post`: split at block boundaries into at
 * most `maxParts` messages, paced by the adapter, with the rest uploaded as
 * `reply.md`. The files go with the last message, or with `reply.md`.
 * When the platform refuses them, the last message goes without them, ending
 * in `notingUnattached`'s note, and the text returned ends with it too.
 * `lead`, a mention, opens the first message and is not part of the text.
 */
export const postMarkdown = Effect.fnUntraced(function* (
  thread: ChatThreads.ChatThread,
  text: string,
  options: {
    readonly maxParts: number
    readonly files: ReadonlyArray<ChatFile>
    readonly replyTo?: ChatMessages.ReplyTo | undefined
    readonly lead?: string | undefined
  },
) {
  let unattached = false
  // A fence opening the reply must stay at the start of its line.
  const markdown =
    options.lead === undefined ? text : `${options.lead}${/^\s*```/.test(text) ? "\n" : " "}${text}`
  const result = yield* ChatMarkdown.post(thread, markdown, {
    maxParts: options.maxParts,
    overflow: { file: { name: REPLY_FILE } },
    ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
    ...(options.files.length === 0
      ? {}
      : {
          files: options.files,
          unattachedNote: (files: ReadonlyArray<ChatAdapter.File>) => {
            unattached = true
            return `\n\n${unattachedNote(files)}`
          },
        }),
  })
  if (unattached) yield* Effect.logWarning("Couldn't post a chat reply's files")
  const last = result.parts.at(-1)
  return {
    postedAt: last === undefined ? yield* DateTime.now : last.timestamp,
    text: unattached ? notingUnattached(text, options.files) : text,
  } satisfies PostedReply
})

/** An attachment's bytes through `Chat.download`, failing past `maxBytes`. */
export const downloadAttachment = (
  thread: ChatThreads.ChatThread,
  attachment: ChatMessages.Attachment,
  maxBytes: number,
): Effect.Effect<Uint8Array, ChatPlatformError, Chat.Chat> =>
  Effect.flatMap(Chat.Chat, (chat) =>
    readLimited(chat.download(thread, attachment, { maxBytes }), maxBytes),
  )

/** A thread's latest `limit` messages that `keep` passes, through `Chat.history`, oldest first. */
export const latestMessages = (
  thread: ChatThreads.ChatThread,
  limit: number,
  keep: (message: ChatMessages.ChatMessage) => boolean = () => true,
): Effect.Effect<ReadonlyArray<ChatMessages.ChatMessage>, ChatPlatformError, Chat.Chat> =>
  Effect.flatMap(Chat.Chat, (chat) =>
    chat.history(thread, { direction: "backward" }).pipe(
      Stream.filter(keep),
      Stream.take(limit),
      Stream.runCollect,
      Effect.map((messages) => Array.from(messages).reverse()),
      Effect.mapError(fromChatError),
    ),
  )

/** A posted reply: when its final part was published, and its text as posted, notes included. */
export interface PostedReply {
  readonly postedAt: DateTime.Utc
  readonly text: string
}

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
    /** Deletes a turn's status message, once the turn replied. */
    readonly deleteStatus: (
      thread: ChatThread,
      messageId: string,
    ) => Effect.Effect<void, ChatPlatformError>
    /**
     * Posts a reply and returns when its final part was published, with the
     * text that went out. On Discord it answers `replyTo`, the message that
     * started the turn, or mentions its author when that message started the
     * thread. `files` go in the same message as the reply's last part, or
     * with its `reply.md`. When the platform refuses them, the last part
     * goes without them, ending in `notingUnattached`'s note, and the text
     * returned ends with the note. Nothing already posted is posted again,
     * so a failure after a lost answer fails the reply.
     */
    readonly postReply: (
      thread: ChatThread,
      text: string,
      options?: {
        readonly replyTo?: { readonly messageId: string; readonly authorId: string } | undefined
        readonly files?: ReadonlyArray<ChatFile> | undefined
      },
    ) => Effect.Effect<PostedReply, ChatPlatformError>
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
   */
  static readonly unavailable = Layer.succeed(this, {
    postStatus: () => noPlatform,
    editStatus: () => noPlatform,
    deleteStatus: () => noPlatform,
    postReply: () => noPlatform,
    download: () => noPlatform,
    history: () => Effect.succeed([]),
  })

  /**
   * One `ChatPlatform` over Slack's and Discord's, each thread going to its
   * own. Pass `ChatPlatform.unavailable` for a platform that is off.
   */
  static readonly route = <E1, R1, E2, R2>(platforms: {
    readonly Slack: Layer.Layer<ChatPlatform, E1, R1>
    readonly Discord: Layer.Layer<ChatPlatform, E2, R2>
  }): Layer.Layer<ChatPlatform, E1 | E2, R1 | R2> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const slack = Context.get(yield* Layer.build(platforms.Slack), ChatPlatform)
        const discord = Context.get(yield* Layer.build(platforms.Discord), ChatPlatform)
        const of = (thread: ChatThread) => (thread._tag === "Slack" ? slack : discord)
        return {
          postStatus: (thread, text) => of(thread).postStatus(thread, text),
          editStatus: (thread, messageId, text) => of(thread).editStatus(thread, messageId, text),
          deleteStatus: (thread, messageId) => of(thread).deleteStatus(thread, messageId),
          postReply: (thread, text, options) => of(thread).postReply(thread, text, options),
          download: (thread, attachment, maxBytes) =>
            of(thread).download(thread, attachment, maxBytes),
          history: (thread, limit) => of(thread).history(thread, limit),
        }
      }),
    )
}
