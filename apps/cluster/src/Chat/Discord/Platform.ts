import { DiscordREST, type DiscordRESTError } from "dfx/DiscordREST"
import type * as Discord from "dfx/types"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ChatPlatform, ChatPlatformError, type ChatThread, readLimited } from "../Platform.ts"
import { chunkMarkdown } from "../Slack/Platform.ts"
import {
  type DiscordMessage,
  errorCode,
  MESSAGE_TYPES,
  parseAttachmentId,
  rememberBotRoleId,
  rememberBotUserId,
  SUPPRESS_EMBEDS,
  toChatMessage,
} from "./Api.ts"
import { DiscordBotConfig } from "./Config.ts"

/** Discord's limit on one message. */
const CHUNK_CHARACTERS = 2000

/** A reply that needs more messages than this is uploaded as a `.md` file instead. */
const MAX_CHUNKS = 5

/** Discord pages a channel's messages 100 at a time. */
const PAGE_SIZE = 100

/** Discord's code for "Unknown Member". */
const UNKNOWN_MEMBER = 10007

/** Discord's code for "Unknown Message". */
const UNKNOWN_MESSAGE = 10008

/** A Discord id. */
const SNOWFLAKE = /^\d+$/

/** The message a thread started from a message opens with, pointing at it. */
const THREAD_STARTER_MESSAGE = 21

/** Status messages and file uploads ping nobody. */
const noMentions = { parse: [] }

/** A reply may ping the users it names and the author it answers, never a role or `@everyone`. */
const userMentions = { parse: ["users" as const], replied_user: true }

const platformError = (error: DiscordRESTError | ChatPlatformError) =>
  error._tag === "ChatPlatformError" ? error : new ChatPlatformError({ message: error.message })

const discordThread = (
  thread: ChatThread,
): Effect.Effect<Extract<ChatThread, { readonly _tag: "Discord" }>, ChatPlatformError> =>
  thread._tag === "Discord"
    ? Effect.succeed(thread)
    : Effect.fail(new ChatPlatformError({ message: "Not a Discord thread" }))

const make = Effect.gen(function* () {
  const rest = yield* DiscordREST
  const config = yield* DiscordBotConfig
  const http = yield* HttpClient.HttpClient

  const botUserId = rememberBotUserId(rest)
  const botRoleId = rememberBotRoleId(rest, config.guildId)

  const post = (
    thread: ChatThread,
    fields: Omit<Parameters<typeof rest.createMessage>[1], "flags">,
  ) =>
    discordThread(thread).pipe(
      Effect.flatMap(({ threadId }) =>
        rest.createMessage(threadId, { ...fields, flags: SUPPRESS_EMBEDS }),
      ),
      Effect.mapError(platformError),
    )

  const upload = (
    thread: ChatThread,
    file: { readonly name: string; readonly content: string },
    fields?: Pick<
      Parameters<typeof rest.createMessage>[1],
      "content" | "allowed_mentions" | "message_reference"
    >,
  ) =>
    post(thread, {
      allowed_mentions: noMentions,
      attachments: [{ id: "0", filename: file.name }],
      ...fields,
    }).pipe(rest.withFiles([new File([file.content], file.name, { type: "text/markdown" })]))

  /**
   * The message a thread was started from. It lives in the parent channel,
   * and the thread holds only Discord's thread starter pointing at it, with
   * the message itself unless Discord left it out. Gone when it was deleted.
   */
  const openingMessage = (starter: Discord.MessageResponse) => {
    if (starter.referenced_message !== undefined) return Effect.succeed(starter.referenced_message)
    const reference = starter.message_reference
    if (reference?.message_id === undefined) return Effect.succeed(null)
    return rest.getMessage(reference.channel_id, reference.message_id).pipe(
      Effect.catchIf(
        (error) => errorCode(error) === UNKNOWN_MESSAGE,
        () => Effect.succeed(null),
      ),
    )
  }

  const history = (thread: ChatThread, limit: number) =>
    Effect.gen(function* () {
      const { guild, threadId } = yield* discordThread(thread)
      const bot = yield* botUserId
      // Newest first, a page at a time, until the limit or the thread's start.
      const messages: Array<DiscordMessage & { readonly type: number }> = []
      let starter: Discord.MessageResponse | undefined
      let reachedStart = false
      let before: string | undefined
      while (messages.length < limit) {
        const requested = Math.min(PAGE_SIZE, limit - messages.length)
        const page = (yield* rest.listMessages(threadId, { limit: requested, before })) ?? []
        starter ??= page.find((message) => message.type === THREAD_STARTER_MESSAGE)
        messages.push(...page.filter((message) => MESSAGE_TYPES.has(message.type)))
        if (page.length < requested) {
          reachedStart = true
          break
        }
        before = page.at(-1)!.id
      }
      messages.reverse()
      // The limit can stop short of the thread's start, so its oldest
      // message is read on its own: a thread starter, or the post that
      // opens a forum thread.
      if (starter === undefined && !reachedStart) {
        const [oldest] = (yield* rest.listMessages(threadId, { after: "0", limit: 1 })) ?? []
        if (oldest?.type === THREAD_STARTER_MESSAGE) starter = oldest
        else if (
          oldest !== undefined &&
          MESSAGE_TYPES.has(oldest.type) &&
          !messages.some(({ id }) => id === oldest.id)
        )
          messages.unshift(oldest)
      }
      const opening = starter === undefined ? null : yield* openingMessage(starter)
      if (opening !== null && MESSAGE_TYPES.has(opening.type)) messages.unshift(opening)
      const managedRole = messages.some((message) => message.mention_roles.length > 0)
        ? yield* botRoleId(bot)
        : undefined
      // REST messages carry no member, so each person's roles are read once.
      const people = new Set(
        messages.filter((message) => message.author.bot !== true).map(({ author }) => author.id),
      )
      const members = new Map(
        yield* Effect.forEach(
          people,
          (id) =>
            rest.getGuildMember(guild, id).pipe(
              Effect.map((member) => [id, member] as const),
              Effect.catchIf(
                (error) => errorCode(error) === UNKNOWN_MEMBER,
                () => Effect.succeed([id, undefined] as const),
              ),
            ),
          { concurrency: 5 },
        ),
      )
      return messages.map((message) =>
        toChatMessage(message, members.get(message.author.id), config.roleId, bot, managedRole),
      )
    }).pipe(Effect.mapError(platformError))

  return ChatPlatform.of({
    postStatus: (thread, text) =>
      post(thread, { content: text, allowed_mentions: noMentions }).pipe(
        Effect.map(({ id }) => id),
      ),
    editStatus: (thread, messageId, text) =>
      discordThread(thread).pipe(
        Effect.flatMap(({ threadId }) =>
          rest.updateMessage(threadId, messageId, {
            content: text,
            allowed_mentions: noMentions,
          }),
        ),
        Effect.asVoid,
        Effect.mapError(platformError),
      ),
    deleteStatus: (thread, messageId) =>
      discordThread(thread).pipe(
        Effect.flatMap(({ threadId }) => rest.deleteMessage(threadId, messageId)),
        Effect.mapError(platformError),
      ),
    postReply: (thread, text, options) => {
      const replyTo = options?.replyTo
      // A thread started from a message shares its id, and that message
      // lives in the parent channel, where a reply from inside the thread
      // can't point: it would show "Message could not be loaded". An
      // approval's id (EFF-3163) is no message's, and Discord refuses it.
      // The author is mentioned instead, so they are still pinged.
      const starter =
        thread._tag === "Discord" &&
        replyTo !== undefined &&
        (replyTo.messageId === thread.threadId || !SNOWFLAKE.test(replyTo.messageId))
          ? replyTo
          : undefined
      const reference =
        replyTo === undefined || starter !== undefined
          ? undefined
          : { message_id: replyTo.messageId, fail_if_not_exists: false }
      const mention = starter === undefined ? undefined : `<@${starter.authorId}>`
      const chunks = chunkMarkdown(
        // A fence opening the reply must stay at the start of its line.
        mention === undefined ? text : `${mention}${/^\s*```/.test(text) ? "\n" : " "}${text}`,
        CHUNK_CHARACTERS,
      )
      if (chunks.length > MAX_CHUNKS)
        return upload(
          thread,
          { name: "reply.md", content: text },
          {
            content: mention,
            allowed_mentions:
              starter === undefined ? noMentions : { parse: [], users: [starter.authorId] },
            message_reference: reference,
          },
        ).pipe(Effect.map(({ timestamp }) => DateTime.makeUnsafe(timestamp)))
      return Effect.forEach(chunks, (chunk, index) =>
        post(thread, {
          content: chunk,
          allowed_mentions: userMentions,
          message_reference: index === 0 ? reference : undefined,
        }),
      ).pipe(
        Effect.flatMap((posted) => {
          const last = posted.at(-1)
          return last === undefined
            ? DateTime.now
            : Effect.succeed(DateTime.makeUnsafe(last.timestamp))
        }),
      )
    },
    uploadFile: (thread, file) => Effect.asVoid(upload(thread, file)),
    download: (_thread, attachment, maxBytes) =>
      Effect.gen(function* () {
        const ids = parseAttachmentId(attachment.id)
        if (ids === undefined)
          return yield* new ChatPlatformError({ message: "Not a Discord attachment" })
        // CDN links expire, so the message is read again for a fresh one.
        const message = yield* rest.getMessage(ids.channelId, ids.messageId)
        const file = message.attachments.find(({ id }) => id === ids.attachmentId)
        if (file === undefined)
          return yield* new ChatPlatformError({ message: "The attachment is gone" })
        const response = yield* http.execute(HttpClientRequest.get(file.url)).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(() => new ChatPlatformError({ message: "The download failed" })),
        )
        return yield* readLimited(response.stream, maxBytes)
      }).pipe(Effect.mapError(platformError)),
    history,
  })
})

/**
 * Discord's `ChatPlatform`, over dfx's REST client, which waits out rate
 * limits itself. Replies go out in messages of at most 2,000 characters with
 * code fences kept balanced, the first answering the message that started
 * the turn, or mentioning its author when that message started the thread;
 * one that needs more than five messages is uploaded as `reply.md`. Replies
 * may ping users only, and no post unfurls links. The backfill reads each
 * author's roles, since REST messages carry no member, and always includes
 * the message that opened the thread, even one in the parent channel.
 */
export const layer: Layer.Layer<
  ChatPlatform,
  never,
  DiscordREST | DiscordBotConfig | HttpClient.HttpClient
> = Layer.effect(ChatPlatform, make)
