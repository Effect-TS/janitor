import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import * as DiscordConfig from "dfx/DiscordConfig"
import { type DiscordREST, type DiscordRESTError, DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import type * as ChatMessages from "effect/chat/ChatMessage"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import type * as HttpClient from "effect/http/HttpClient"
import { type ChatMessage, type ChatThread, withoutMentions } from "../Platform.ts"

/**
 * What Discord ingress and Discord's `ChatPlatform` share (EFF-3020): dfx's
 * REST client, the bot's managed role and how an `effect/chat` message
 * becomes a session's `ChatMessage`.
 */

/** dfx's REST client with the bot token, rate limited in memory. */
export const restLayer = (
  token: Redacted.Redacted<string>,
): Layer.Layer<DiscordREST, never, HttpClient.HttpClient> =>
  DiscordRESTLive.pipe(Layer.provide([DiscordConfig.layer({ token }), MemoryRateLimitStoreLive]))

/** A session's Discord thread as an `effect/chat` address: its channel id. */
export const address = (thread: Extract<ChatThread, { readonly _tag: "Discord" }>) =>
  DiscordChat.thread(thread.threadId)

/**
 * The bot's managed role, identified by Discord's tag rather than its display
 * name. Only a mention of it needs the role, so when Discord refuses to list
 * the roles there is none for now: a mention of the bot user still works, and
 * the next read asks again.
 */
export const rememberBotRoleId = (rest: DiscordREST["Service"], guildId: string) => {
  let roleId: string | undefined
  const unreadRoles = (error: DiscordRESTError) =>
    Effect.logWarning("Discord refused to list the guild's roles").pipe(
      Effect.annotateLogs({ reason: error.message }),
      Effect.as(undefined),
    )
  return (
    botUserId: string,
  ): Effect.Effect<
    string | undefined,
    Exclude<DiscordRESTError, { readonly _tag: "ErrorResponse" | "RatelimitedResponse" }>
  > =>
    Effect.suspend(() =>
      roleId !== undefined
        ? Effect.succeed(roleId)
        : Effect.map(
            rest.listGuildRoles(guildId),
            (roles) => (roleId = roles.find((role) => role.tags?.bot_id === botUserId)?.id),
          ).pipe(
            Effect.catchTags({ ErrorResponse: unreadRoles, RatelimitedResponse: unreadRoles }),
          ),
    )
}

/** Discord's error code for a refusal, such as 10003 for an unknown channel. */
export const errorCode = (error: DiscordRESTError): number | undefined =>
  error._tag === "ErrorResponse" ? error.data.code : undefined

/**
 * A Discord attachment's id in a `ChatAttachment`: its channel, then
 * `effect/chat`'s id, the message and attachment ids. A download reads the
 * message again, in its own channel, for a fresh CDN link.
 */
export const attachmentId = (channelId: string, id: string): string => `${channelId}/${id}`

export const parseAttachmentId = (
  id: string,
): { readonly channelId: string; readonly id: string } | undefined => {
  const [channelId, messageId, attachment, ...rest] = id.split("/")
  return channelId && messageId && attachment && rest.length === 0
    ? { channelId, id: `${messageId}/${attachment}` }
    : undefined
}

/** The author's membership: on a gateway message or reaction, a guild member read over REST, or none. */
export interface DiscordMember {
  readonly nick?: string | null | undefined
  readonly roles?: ReadonlyArray<string> | undefined
}

/**
 * The author is admitted with the role in `member.roles`; a bot account,
 * the janitor bot included, is context only whatever its roles.
 */
export const toAuthor = (
  author: { readonly id: string; readonly name?: string | undefined; readonly isBot: boolean },
  member: DiscordMember | undefined,
  roleId: string,
): ChatMessage["author"] => ({
  id: author.id,
  name: member?.nick || author.name || author.id,
  class: author.isBot ? "bot" : member?.roles?.includes(roleId) === true ? "admitted" : "outsider",
})

/**
 * An `effect/chat` Discord message as a session's, with mentions of the bot
 * and of its managed role removed. A reply to one of the bot's messages
 * counts as a mention: it is addressed to the bot whether or not the reply
 * pings (EFF-3137).
 */
export const toChatMessage = (
  message: ChatMessages.ChatMessage,
  author: ChatMessage["author"],
  botUserId: string,
  botRoleId?: string,
): ChatMessage => {
  const isBot = (mention: ChatMessages.Mention) =>
    mention.isSelf || (mention.kind === "role" && mention.id === botRoleId)
  const answers = message.replyTo?.authorId
  return {
    id: message.id,
    author,
    text: withoutMentions(message, isBot).trim(),
    mentionsBot: message.mentions.some(isBot) || answers === botUserId,
    sentAt: message.timestamp,
    attachments: message.attachments.map((attachment) => ({
      id: attachmentId(message.thread.id, attachment.id),
      name: attachment.name ?? attachment.id,
      mediaType: attachment.contentType ?? "application/octet-stream",
      size: Math.max(0, Math.floor(attachment.size ?? 0)),
    })),
    ...(answers === undefined ? {} : { answers }),
  }
}

/** Whether the message mentions a role: only then is the bot's managed role read. */
export const mentionsRole = (message: ChatMessages.ChatMessage): boolean =>
  message.mentions.some((mention) => mention.kind === "role")
