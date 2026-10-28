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
  errorCode,
  MESSAGE_TYPES,
  parseAttachmentId,
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

  /**
   * Answers the message that started the turn. A thread started from a
   * message shares its id, and that message lives in the parent channel,
   * where a reply from inside the thread can't point; a reference to it
   * would show "Message could not be loaded", so none is set.
   */
  const reference = (thread: ChatThread, replyTo: string | undefined) =>
    replyTo === undefined || (thread._tag === "Discord" && replyTo === thread.threadId)
      ? undefined
      : { message_id: replyTo, fail_if_not_exists: false }

  const upload = (
    thread: ChatThread,
    file: { readonly name: string; readonly content: string },
    replyTo?: string,
  ) =>
    post(thread, {
      allowed_mentions: noMentions,
      attachments: [{ id: "0", filename: file.name }],
      message_reference: reference(thread, replyTo),
    }).pipe(rest.withFiles([new File([file.content], file.name, { type: "text/markdown" })]))

  const history = (thread: ChatThread, limit: number) =>
    Effect.gen(function* () {
      const { guild, threadId } = yield* discordThread(thread)
      const bot = yield* botUserId
      // Newest first, a page at a time.
      const messages: Array<Discord.MessageResponse> = []
      let before: string | undefined
      while (messages.length < limit) {
        const page =
          (yield* rest.listMessages(threadId, {
            limit: Math.min(PAGE_SIZE, limit - messages.length),
            before,
          })) ?? []
        messages.push(...page.filter((message) => MESSAGE_TYPES.has(message.type)))
        if (page.length < PAGE_SIZE) break
        before = page.at(-1)!.id
      }
      messages.reverse()
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
        toChatMessage(message, members.get(message.author.id), config.roleId, bot),
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
    postReply: (thread, text, options) => {
      const chunks = chunkMarkdown(text, CHUNK_CHARACTERS)
      if (chunks.length > MAX_CHUNKS)
        return upload(thread, { name: "reply.md", content: text }, options?.replyTo).pipe(
          Effect.map(({ timestamp }) => DateTime.makeUnsafe(timestamp)),
        )
      return Effect.forEach(chunks, (chunk, index) =>
        post(thread, {
          content: chunk,
          allowed_mentions: userMentions,
          message_reference: index === 0 ? reference(thread, options?.replyTo) : undefined,
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
 * the turn; one that needs more than five messages is uploaded as
 * `reply.md`. Replies may ping users only, and no post unfurls links. The
 * backfill reads each author's roles, since REST messages carry no member.
 */
export const layer: Layer.Layer<
  ChatPlatform,
  never,
  DiscordREST | DiscordBotConfig | HttpClient.HttpClient
> = Layer.effect(ChatPlatform, make)
