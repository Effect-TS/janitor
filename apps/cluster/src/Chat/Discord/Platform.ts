import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { DiscordREST } from "dfx/DiscordREST"
import * as Chat from "effect/chat/Chat"
import type { ChatError } from "effect/chat/ChatError"
import type * as ChatMessages from "effect/chat/ChatMessage"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as HttpClient from "effect/http/HttpClient"
import {
  ChatPlatform,
  ChatPlatformError,
  type ChatThread,
  downloadAttachment,
  fromChatError,
  latestMessages,
  postMarkdown,
  refusedBeforePosting,
} from "../Platform.ts"
import {
  address,
  type DiscordMember,
  errorCode,
  mentionsRole,
  parseAttachmentId,
  rememberBotRoleId,
  restLayer,
  toAuthor,
  toChatMessage,
} from "./Api.ts"
import { DiscordBotConfig } from "./Config.ts"

/** A reply that needs more messages than this goes on in `reply.md`. */
const MAX_PARTS = 5

/** Discord's code for "Unknown Member". */
const UNKNOWN_MEMBER = 10007

/**
 * Discord's answer to a reply whose message is gone: an invalid form body
 * (50035) naming `message_reference`, or an unknown message.
 */
const isUnknownReference = (error: ChatError): boolean =>
  error.reason._tag === "NotFound" ||
  (error.reason._tag === "InvalidRequest" && error.reason.detail === "50035")

/** A Discord id. */
const SNOWFLAKE = /^\d+$/

/** The users a reply names, `<@id>` or the older `<@!id>`: a reply may ping them. */
const namedUsers = (text: string): ReadonlyArray<string> =>
  Array.from(new Set(Array.from(text.matchAll(/<@!?(\d+)>/g), (match) => match[1]!)))

const discordThread = (
  thread: ChatThread,
): Effect.Effect<Extract<ChatThread, { readonly _tag: "Discord" }>, ChatPlatformError> =>
  thread._tag === "Discord"
    ? Effect.succeed(thread)
    : Effect.fail(new ChatPlatformError({ message: "Not a Discord thread" }))

const make = Effect.gen(function* () {
  const chat = yield* Chat.Chat
  const discord = yield* DiscordChat.DiscordChat
  const rest = yield* DiscordREST
  const config = yield* DiscordBotConfig
  const provide = Effect.provideService(Chat.Chat, chat)
  const botUserId = Effect.mapError(discord.botUserId, fromChatError)
  const botRoleId = rememberBotRoleId(rest, config.guildId)

  /** A guild member's nick and roles; none for one who left. */
  const member = (guild: string, id: string) =>
    rest.getGuildMember(guild, id).pipe(
      Effect.map((member): DiscordMember | undefined => member),
      Effect.catchIf(
        (error) => errorCode(error) === UNKNOWN_MEMBER,
        () => Effect.undefined,
      ),
    )

  const history = (thread: ChatThread, limit: number) =>
    Effect.gen(function* () {
      const { guild, threadId } = yield* discordThread(thread)
      const to = DiscordChat.thread(threadId)
      const bot = yield* botUserId
      const latest = yield* latestMessages(to, limit)
      // The limit can stop short of the thread's start, so the message that
      // opened it, in the parent channel or a forum post's own, is read on its own.
      const opener = yield* chat.opener(to).pipe(Effect.mapError(fromChatError))
      const messages =
        Option.isSome(opener) && !latest.some(({ id }) => id === opener.value.id)
          ? [opener.value, ...latest]
          : latest
      const managedRole = messages.some(mentionsRole) ? yield* botRoleId(bot) : undefined
      // REST messages carry no member, so each person's roles are read once.
      const people = new Set(
        messages.filter((message) => !message.author.isBot).map(({ author }) => author.id),
      )
      const members = new Map(
        yield* Effect.forEach(
          people,
          (id) => Effect.map(member(guild, id), (found) => [id, found] as const),
          { concurrency: 5 },
        ),
      )
      return messages.map((message) =>
        toChatMessage(
          message,
          toAuthor(message.author, members.get(message.author.id), config.roleId),
          bot,
          managedRole,
        ),
      )
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ChatPlatformError"
          ? error
          : new ChatPlatformError({ message: error.message }),
      ),
      provide,
    )

  return ChatPlatform.of({
    postStatus: (thread, text) =>
      discordThread(thread).pipe(
        Effect.flatMap((thread) =>
          Effect.mapError(chat.post(address(thread), { markdown: text }), fromChatError),
        ),
        Effect.map(({ id }) => id),
      ),
    editStatus: (thread, messageId, text) =>
      discordThread(thread).pipe(
        Effect.flatMap((thread) =>
          Effect.mapError(chat.edit(address(thread), messageId, { markdown: text }), fromChatError),
        ),
      ),
    deleteStatus: (thread, messageId) =>
      discordThread(thread).pipe(
        Effect.flatMap((thread) =>
          Effect.mapError(chat.delete(address(thread), messageId), fromChatError),
        ),
      ),
    postReply: (thread, text, options) =>
      Effect.gen(function* () {
        const to = address(yield* discordThread(thread))
        const replyTo = options?.replyTo
        const files = options?.files ?? []
        // A reply may ping the users it names and the author it answers,
        // never a role or `@everyone`.
        const post = (
          answer:
            | { readonly lead: string }
            | { readonly replyTo: ChatMessages.ReplyTo }
            | undefined,
        ) => {
          const lead = answer !== undefined && "lead" in answer ? answer.lead : undefined
          return postMarkdown(to, text, {
            maxParts: MAX_PARTS,
            files,
            lead,
            ...(answer !== undefined && "replyTo" in answer ? { replyTo: answer.replyTo } : {}),
          }).pipe(
            DiscordChat.withPostOptions({
              notify: { users: namedUsers(`${lead ?? ""} ${text}`), repliedUser: true },
            }),
          )
        }
        if (replyTo === undefined) return yield* post(undefined)
        const mention = { lead: `<@${replyTo.authorId}>` }
        // A thread started from a message shares its id, and that message
        // lives in the parent channel, where a reply from inside the thread
        // can't point: it would show "Message could not be loaded". An
        // approval's id (EFF-3163) is no message's, and Discord refuses it.
        // The author is mentioned instead, so they are still pinged.
        if (replyTo.messageId === to.id || !SNOWFLAKE.test(replyTo.messageId))
          return yield* post(mention)
        // Discord refuses a reply to a message deleted since: the author is
        // mentioned instead, as long as nothing went out yet.
        return yield* post({ replyTo }).pipe(
          Effect.catchIf(
            (error) => refusedBeforePosting(error, isUnknownReference),
            () => post(mention),
          ),
        )
      }).pipe(Effect.mapError(fromChatError), provide),
    download: (_thread, attachment, maxBytes) =>
      Effect.gen(function* () {
        const ids = parseAttachmentId(attachment.id)
        if (ids === undefined)
          return yield* new ChatPlatformError({ message: "Not a Discord attachment" })
        // The message is read in its own channel: the opener of a thread
        // started from a message is in the parent channel.
        return yield* downloadAttachment(
          DiscordChat.thread(ids.channelId),
          { id: ids.id, size: attachment.size },
          maxBytes,
        )
      }).pipe(provide),
    history,
  })
})

/**
 * Discord's `ChatPlatform`, over `effect/chat` with `@effect/chat-discord`'s
 * adapter on dfx's REST client, which waits out rate limits itself. Replies
 * go out through `ChatMarkdown.post`, split at block boundaries into up to
 * five messages of at most 2,000 characters, the rest uploaded as
 * `reply.md`; the first answers the message that started the turn, or
 * mentions its author when that message started the thread. A reply's files
 * go with its last message. Replies may ping the users they name only, and
 * no post shows link embeds. The backfill reads each author's roles, since
 * REST messages carry no member, and always includes the message that opened
 * the thread, even one in the parent channel.
 */
export const layer: Layer.Layer<
  ChatPlatform,
  never,
  Chat.Chat | DiscordChat.DiscordChat | DiscordREST | DiscordBotConfig
> = Layer.effect(ChatPlatform, make)

/** Discord's `ChatPlatform` from its settings, with its own `Chat` and the Discord adapter. */
export const layerFrom = (
  config: DiscordBotConfig["Service"],
): Layer.Layer<ChatPlatform, never, HttpClient.HttpClient> =>
  layer.pipe(
    Layer.provide(DiscordChat.layer),
    Layer.provideMerge(Chat.layer),
    Layer.provideMerge(restLayer(config.botToken)),
    Layer.provide(DiscordBotConfig.layerFrom(config)),
  )
