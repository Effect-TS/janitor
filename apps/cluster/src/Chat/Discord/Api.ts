import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import * as DiscordConfig from "dfx/DiscordConfig"
import { DiscordREST, type DiscordRESTError, DiscordRESTLive } from "dfx/DiscordREST"
import { MemoryRateLimitStoreLive } from "dfx/RateLimit"
import * as Chat from "effect/chat/Chat"
import type * as ChatMessages from "effect/chat/ChatMessage"
import type * as ChatThreads from "effect/chat/ChatThread"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"
import type * as HttpClient from "effect/http/HttpClient"
import type { ChatMessage } from "@janitor/domain/Chat/Session"
import { sessionMessage } from "../Message.ts"
import type { Backfill } from "../Session.ts"
import type { DiscordBotConfig } from "./Config.ts"

/**
 * What Discord ingress and the sessions share (EFF-3020): dfx's REST
 * client, the admission rule, the bot's managed role and the backfill of a
 * thread.
 */

/** dfx's REST client with the bot token, rate limited in memory. */
export const restLayer = (
  token: Redacted.Redacted<string>,
): Layer.Layer<DiscordREST, never, HttpClient.HttpClient> =>
  DiscordRESTLive.pipe(Layer.provide([DiscordConfig.layer({ token }), MemoryRateLimitStoreLive]))

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
 * Mentions of the bot: of its user, or of its managed role `botRoleId`.
 * A session's message is read without them.
 */
export const isBotMention =
  (botRoleId: string | undefined) =>
  (mention: ChatMessages.Mention): boolean =>
    mention.isSelf || (mention.kind === "role" && mention.id === botRoleId)

/** Whether the message mentions a role: only then is the bot's managed role read. */
export const mentionsRole = (message: ChatMessages.ChatMessage): boolean =>
  message.mentions.some((mention) => mention.kind === "role")

/** Discord's code for "Unknown Member". */
const UNKNOWN_MEMBER = 10007

/**
 * Connects Discord to `Chat`, registering its adapter,, on dfx's REST client, and returns
 * the sessions' backfill for Discord threads: the latest messages, and
 * always the message that opened the thread, even one in the parent
 * channel. REST messages carry no member, so each author's roles are read.
 */
export const connect = Effect.fnUntraced(function* (config: DiscordBotConfig["Service"]) {
  const services = yield* Layer.build(
    DiscordChat.layer.pipe(Layer.provideMerge(restLayer(config.botToken))),
  )
  const discord = Context.get(services, DiscordChat.DiscordChat)
  const rest = Context.get(services, DiscordREST)
  const chat = yield* Chat.Chat
  const botRoleId = rememberBotRoleId(rest, config.guildId)

  /** A guild member's nick and roles; none for one who left. */
  const member = (id: string) =>
    rest.getGuildMember(config.guildId, id).pipe(
      Effect.map((member): DiscordMember | undefined => member),
      Effect.catchIf(
        (error) => errorCode(error) === UNKNOWN_MEMBER,
        () => Effect.undefined,
      ),
    )

  return ((thread: ChatThreads.ChatThread, limit: number) =>
    Effect.gen(function* () {
      const bot = yield* discord.botUserId
      const latest = yield* chat.history(thread, { direction: "backward" }).pipe(
        Stream.take(limit),
        Stream.runCollect,
        Effect.map((messages) => Array.from(messages).reverse()),
      )
      // The limit can stop short of the thread's start, so the message that
      // opened it, in the parent channel or a forum post's own, is read on its own.
      const opener = yield* chat.opener(thread)
      const messages =
        Option.isSome(opener) && !latest.some(({ id }) => id === opener.value.id)
          ? [opener.value, ...latest]
          : latest
      const managedRole = messages.some(mentionsRole) ? yield* botRoleId(bot) : undefined
      const people = new Set(
        messages.filter((message) => !message.author.isBot).map(({ author }) => author.id),
      )
      const members = new Map(
        yield* Effect.forEach(
          people,
          (id) => Effect.map(member(id), (found) => [id, found] as const),
          { concurrency: 5 },
        ),
      )
      return messages.map((message) =>
        sessionMessage(
          message,
          toAuthor(message.author, members.get(message.author.id), config.roleId),
          { isBot: isBotMention(managedRole), botUserId: bot },
        ),
      )
    })) satisfies Backfill
})
