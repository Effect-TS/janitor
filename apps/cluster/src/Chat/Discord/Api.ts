import * as DiscordConfig from "dfx/DiscordConfig"
import { type DiscordREST, type DiscordRESTError, DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import type * as Discord from "dfx/types"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import type * as HttpClient from "effect/http/HttpClient"
import type { ChatMessage } from "../Platform.ts"

/**
 * What Discord ingress and Discord's `ChatPlatform` share (EFF-3020): dfx's
 * REST client, the bot's own id and how a Discord message becomes a
 * `ChatMessage`.
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

/** The bot's own user id, read once; a failed read is tried again next time. */
export const rememberBotUserId = (
  rest: DiscordREST["Service"],
): Effect.Effect<string, DiscordRESTError> => {
  let botId: string | undefined
  return Effect.suspend(() =>
    botId !== undefined
      ? Effect.succeed(botId)
      : Effect.map(rest.getMyUser(), (user) => (botId = user.id)),
  )
}

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
  readonly mention_roles: ReadonlyArray<string>
  /** The message a reply answers; null once it is deleted. */
  readonly referenced_message?: { readonly author: { readonly id: string } } | null | undefined
}

/** The author's membership: `member` on a gateway message, a guild member read over REST, or none. */
export interface DiscordMember {
  readonly nick?: string | null | undefined
  readonly roles?: ReadonlyArray<string> | undefined
}

/**
 * The author is admitted with the role in `member.roles`; a bot account,
 * the janitor bot included, is context only whatever its roles. The name is
 * the server nickname, else the display name, else the username.
 */
export const toAuthor = (
  user: Pick<Discord.UserResponse, "id" | "username" | "global_name" | "bot">,
  member: DiscordMember | undefined,
  roleId: string,
): ChatMessage["author"] => ({
  id: user.id,
  name: member?.nick ?? user.global_name ?? user.username,
  class:
    user.bot === true ? "bot" : member?.roles?.includes(roleId) === true ? "admitted" : "outsider",
})

/** Mentions of the bot, `<@id>` or the older `<@!id>`. */
const botMention = (botUserId: string) => new RegExp(`<@!?${botUserId}>`, "g")

/**
 * The author as `toAuthor` classes them. A reply to one of the bot's
 * messages counts as a mention: it is addressed to the bot whether or not
 * the reply pings (EFF-3137).
 */
export const toChatMessage = (
  message: DiscordMessage,
  member: DiscordMember | undefined,
  roleId: string,
  botUserId: string,
  botRoleId?: string,
): ChatMessage => {
  const mentionsBotRole = botRoleId !== undefined && message.mention_roles.includes(botRoleId)
  const answers = message.referenced_message?.author.id
  return {
    id: message.id,
    author: toAuthor(message.author, member, roleId),
    text: (mentionsBotRole ? message.content.replaceAll(`<@&${botRoleId}>`, "") : message.content)
      .replace(botMention(botUserId), "")
      .trim(),
    mentionsBot:
      message.mentions.some((user) => user.id === botUserId) ||
      mentionsBotRole ||
      answers === botUserId,
    sentAt: DateTime.makeUnsafe(message.timestamp),
    attachments: message.attachments.map((attachment) => ({
      id: attachmentId(message.channel_id, message.id, attachment.id),
      name: attachment.filename,
      mediaType: attachment.content_type ?? "application/octet-stream",
      size: attachment.size,
    })),
    ...(answers === undefined ? {} : { answers }),
  }
}
