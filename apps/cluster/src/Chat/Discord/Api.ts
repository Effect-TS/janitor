import * as DiscordConfig from "dfx/DiscordConfig"
import { type DiscordREST, type DiscordRESTError, DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import type * as Discord from "dfx/types"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import type * as HttpClient from "effect/http/HttpClient"
import type { AuthorClass, ChatMessage } from "../Platform.ts"

/**
 * What Discord ingress and Discord's `ChatPlatform` share (EFF-3020): dfx's
 * REST client, how an author is classified and how a Discord message becomes
 * a `ChatMessage`.
 */

/** dfx's REST client with the bot token, rate limited in memory. */
export const restLayer = (
  token: Redacted.Redacted<string>,
): Layer.Layer<DiscordREST, never, HttpClient.HttpClient> =>
  DiscordRESTLive.pipe(Layer.provide([DiscordConfig.layer({ token }), MemoryRateLimitStoreLive]))

/** The channel types the bot starts a thread in: text and announcement channels. */
export const THREAD_PARENT_TYPES: ReadonlySet<number> = new Set([0, 5])
/** Announcement, public and private threads. */
export const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12])
/** Plain messages and replies; joins, pins, thread starters and the like aren't. */
export const MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19])

/** Ask Discord for no link previews on the bot's posts. */
export const SUPPRESS_EMBEDS = 1 << 2

/**
 * An admitted author has the role in `member.roles`. A bot account, the
 * janitor bot included, is context only whatever its roles.
 */
export const classify = (
  author: { readonly bot?: boolean | undefined },
  roles: ReadonlyArray<string> | undefined,
  roleId: string,
): AuthorClass =>
  author.bot === true ? "bot" : roles?.includes(roleId) === true ? "admitted" : "outsider"

/** The name the thread shows: the server nickname, else the display name, else the username. */
export const authorName = (
  author: { readonly username: string; readonly global_name: string | null },
  nick: string | null | undefined,
): string => nick ?? author.global_name ?? author.username

/** Whether a Discord error is Discord refusing the request, as opposed to a transport failure. */
export const isRefusal = (error: DiscordRESTError): boolean =>
  error._tag === "ErrorResponse" || error._tag === "RatelimitedResponse"

/** Discord's error code for a refusal, such as 10003 for an unknown channel. */
export const errorCode = (error: DiscordRESTError): number | undefined =>
  error._tag === "ErrorResponse" ? error.data.code : undefined

/**
 * A Discord attachment's id in a `ChatAttachment`: its channel, message and
 * attachment ids. CDN links expire, so a download reads the message again for
 * a fresh one.
 */
export const attachmentId = (channelId: string, messageId: string, id: string): string =>
  `${channelId}/${messageId}/${id}`

export const parseAttachmentId = (
  id: string,
):
  | { readonly channelId: string; readonly messageId: string; readonly attachmentId: string }
  | undefined => {
  const [channelId, messageId, attachment, ...rest] = id.split("/")
  return channelId && messageId && attachment && rest.length === 0
    ? { channelId, messageId, attachmentId: attachment }
    : undefined
}

/** The fields of a Discord message `toChatMessage` reads. */
export type DiscordMessage = Pick<
  Discord.MessageResponse,
  "id" | "channel_id" | "content" | "timestamp" | "attachments"
> & {
  readonly author: Discord.UserResponse
  readonly mentions: ReadonlyArray<{ readonly id: string }>
}

/** Mentions of the bot, `<@id>` or the older `<@!id>`. */
const botMention = (botUserId: string) => new RegExp(`<@!?${botUserId}>`, "g")

export const mentionsBot = (message: DiscordMessage, botUserId: string): boolean =>
  message.mentions.some((user) => user.id === botUserId)

export const toChatMessage = (
  message: DiscordMessage,
  author: { readonly name: string; readonly class: AuthorClass },
  botUserId: string,
): ChatMessage => ({
  id: message.id,
  author: { id: message.author.id, ...author },
  text: message.content.replace(botMention(botUserId), "").trim(),
  mentionsBot: mentionsBot(message, botUserId),
  sentAt: DateTime.makeUnsafe(message.timestamp),
  attachments: message.attachments.map((attachment) => ({
    id: attachmentId(message.channel_id, message.id, attachment.id),
    name: attachment.filename,
    mediaType: attachment.content_type ?? "application/octet-stream",
    size: attachment.size,
  })),
})
