import * as DiscordChat from "@effect/chat-discord/DiscordChat"
import { DiscordREST } from "dfx/DiscordREST"
import * as Chat from "effect/chat/Chat"
import { type ChatError, isChatError } from "effect/chat/ChatError"
import type * as ChatEvent from "effect/chat/ChatEvent"
import * as ChatHandler from "effect/chat/ChatHandler"
import type * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import type { ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"
import { APPROVAL_TEXT, approvalMessageId, sessionMessage } from "../Message.ts"
import { sessionClient } from "../Session.ts"
import { isBotMention, mentionsRole, rememberBotRoleId, restLayer, toAuthor } from "./Api.ts"
import { DiscordBotConfig } from "./Config.ts"

export class DiscordSessionError extends Schema.TaggedError<DiscordSessionError>()(
  "DiscordSessionError",
  { message: Schema.String },
) {}

/** What Discord ingress asks of the chat session entities. */
export class DiscordSessions extends Context.Service<
  DiscordSessions,
  {
    /** Hands a message to its thread's session. */
    readonly receive: (
      thread: ChatThread,
      message: ChatMessage,
    ) => Effect.Effect<void, DiscordSessionError>
    /** Whether the thread has a session, so a reply without a mention reaches it. */
    readonly exists: (thread: ChatThread) => Effect.Effect<boolean, DiscordSessionError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordSessions") {
  /** The session entities, through the cluster's client. `provide` is the cluster handle's. */
  static readonly fromCluster = (
    provide: <A, E>(effect: Effect.Effect<A, E, Sharding.Sharding>) => Effect.Effect<A, E>,
  ): Layer.Layer<DiscordSessions> => {
    const session = sessionClient(
      provide,
      (error) => new DiscordSessionError({ message: String(error) }),
    )
    return Layer.succeed(this, {
      receive: (thread, message) =>
        session(thread, (client) => client.Receive({ thread, message }, { discard: true })),
      exists: (thread) => session(thread, (client) => client.Exists()),
    })
  }
}

/**
 * The message ids the gateway has handed on, approvals' included, kept in
 * the gateway Durable Object's storage. A RESUME replays what arrived while
 * the socket was dark, and a rebuilt instance reads the same storage, so a
 * replayed message is dropped.
 */
export class SeenMessages extends Context.Service<
  SeenMessages,
  {
    readonly has: (messageId: string) => Effect.Effect<boolean>
    /** Recorded once the message is handled, so a failure leaves it for the replay. */
    readonly add: (messageId: string) => Effect.Effect<void>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/SeenMessages") {}

/** A dispatch ingress couldn't hand on for now; the gateway resumes and gets it again. */
export class DiscordIngressError extends Schema.TaggedError<DiscordIngressError>()(
  "DiscordIngressError",
  { message: Schema.String },
) {}

/**
 * The gateway Durable Object's ingress: it feeds each dispatch to
 * `@effect/chat-discord`'s `DiscordChat.dispatch`, which normalises
 * `MESSAGE_CREATE` and `MESSAGE_REACTION_ADD` into `effect/chat` events for
 * janitor's `ChatHandler`. The handler filters a message, admits its author
 * by `member.roles` and hands the message to its thread's session, creating
 * the thread for a channel mention. A 👍 on the bot's message becomes an
 * approval (EFF-3163).
 */
export class DiscordIngress extends Context.Service<
  DiscordIngress,
  {
    readonly dispatch: (payload: {
      readonly t: string
      readonly d: unknown
    }) => Effect.Effect<void, DiscordIngressError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordIngress") {}

/** The message ingress logs at Debug for each message it drops, with the reason. */
export const DROPPED = "Discord ingress dropped a message"

/** 👍 with any skin tone; a custom emoji is `custom:{name}`. */
const isThumbsUp = (emoji: string) => emoji.startsWith("👍")

/** Plain messages and replies; slash commands and the like aren't. */
const MESSAGE_TYPES: ReadonlySet<unknown> = new Set([0, 19])

const DIRECT_MESSAGE_POINTER = "I only work in servers. Mention me in a channel to start a thread."

/** Threads keep a day of quiet before Discord archives them. */
const AUTO_ARCHIVE_MINUTES = 1440

const threadName = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "janitor"

const rawField = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined

const drop = (reason: string) => Effect.logDebug(DROPPED).pipe(Effect.annotateLogs({ reason }))

/** A refusal from Discord won't change on a replay: it's logged and the event dropped. */
const refused = (error: ChatError) =>
  Effect.logWarning("Discord refused a request for an inbound message").pipe(
    Effect.annotateLogs({ reason: error.message }),
  )

const handler = Effect.gen(function* () {
  const config = yield* DiscordBotConfig
  const sessions = yield* DiscordSessions
  const seen = yield* SeenMessages
  const rest = yield* DiscordREST
  const chat = yield* Chat.Chat
  const discord = yield* DiscordChat.DiscordChat
  const botRoleId = rememberBotRoleId(rest, config.guildId)

  /** Hands the message on, or drops it; fails only with what a replay could fix. */
  const route = Effect.fnUntraced(function* (event: ChatEvent.MessageCreated) {
    const message = event.message
    if (!MESSAGE_TYPES.has(rawField(event.raw, "type")))
      return yield* drop(`message type ${String(rawField(event.raw, "type"))}`)
    if (event.kind === "direct") {
      if (!message.author.isBot)
        yield* chat.post(event.thread, { markdown: DIRECT_MESSAGE_POINTER })
      else yield* drop("a direct message from a bot")
      return
    }
    const guild = DiscordChat.guildId(event)
    if (Option.getOrUndefined(guild) !== config.guildId) return yield* drop("another guild")
    // Webhooks and system messages have no member.
    const member = DiscordChat.member(event)
    if (Option.isNone(member)) return yield* drop("no member")
    const bot = yield* discord.botUserId
    const chatMessage = sessionMessage(
      message,
      toAuthor(message.author, member.value, config.roleId),
      {
        isBot: isBotMention(mentionsRole(message) ? yield* botRoleId(bot) : undefined),
        botUserId: bot,
      },
    )
    // Only an admitted user's mention starts a session.
    const starts = chatMessage.mentionsBot && chatMessage.author.class === "admitted"
    const notStarting = chatMessage.mentionsBot ? "the author lacks the role" : "no bot mention"
    let thread: ChatThread
    if (event.kind === "thread") {
      thread = { _tag: "Discord", guild: config.guildId, threadId: event.thread.id }
      if (!starts && !(yield* sessions.exists(thread)))
        return yield* drop(`a thread with no session, and ${notStarting}`)
    } else {
      if (!starts) return yield* drop(notStarting)
      // A replay finds the message's thread already there, with its id.
      const started = yield* chat
        .startThread(event.thread, message.id, { name: threadName(chatMessage.text) })
        .pipe(DiscordChat.withPostOptions({ autoArchiveDuration: AUTO_ARCHIVE_MINUTES }))
      thread = { _tag: "Discord", guild: config.guildId, threadId: started.id }
    }
    yield* sessions.receive(thread, chatMessage)
    yield* Effect.logInfo("Discord ingress handed a message to its session").pipe(
      Effect.annotateLogs({ threadId: thread.threadId, author: chatMessage.author.class }),
    )
  })

  /**
   * Hands an admitted member's 👍 on the bot's message in a thread with a
   * session to it as an approval, or drops it. A reaction never starts a
   * session, and anyone else's is dropped, not kept as context. Only an
   * approval handed on is recorded as seen: a dropped reaction, an
   * outsider's say, mustn't suppress a later 👍 from the same user.
   */
  const routeReaction = Effect.fnUntraced(function* (event: ChatEvent.ReactionAdded, id: string) {
    const bot = yield* discord.botUserId
    if (event.messageAuthorId !== bot) return yield* drop("a reaction to another's message")
    if (Option.getOrUndefined(DiscordChat.guildId(event)) !== config.guildId)
      return yield* drop("a reaction outside the guild")
    const member = DiscordChat.member(event)
    if (Option.isNone(member)) return yield* drop("no member")
    const user = rawField(rawField(event.raw, "member"), "user")
    const author = toAuthor(
      {
        id: event.userId,
        name: (rawField(user, "global_name") ?? rawField(user, "username")) as string | undefined,
        isBot: rawField(user, "bot") === true,
      },
      member.value,
      config.roleId,
    )
    if (author.class !== "admitted") return yield* drop(`a reaction from a ${author.class}`)
    // Sessions live in threads only, so a reaction elsewhere finds none.
    const thread: ChatThread = { _tag: "Discord", guild: config.guildId, threadId: event.thread.id }
    if (!(yield* sessions.exists(thread)))
      return yield* drop("a reaction in a thread with no session")
    yield* sessions.receive(thread, {
      id,
      author,
      text: APPROVAL_TEXT,
      mentionsBot: true,
      sentAt: event.timestamp ?? (yield* DateTime.now),
      attachments: [],
    })
    yield* seen.add(id)
    yield* Effect.logInfo("Discord ingress handed an approval to its session").pipe(
      Effect.annotateLogs({ threadId: thread.threadId }),
    )
  })

  /** Routes, dropping what Discord refuses; any other failure is for the replay. */
  const attempt = <E>(routed: Effect.Effect<void, E>) =>
    routed.pipe(
      Effect.catch((error) =>
        isChatError(error) && error.retry === "denied"
          ? refused(error)
          : Effect.logWarning("Discord ingress couldn't hand an event on").pipe(
              Effect.annotateLogs({
                reason: error instanceof Error ? error.message : String(error),
              }),
              Effect.andThen(Effect.fail(new ChatHandler.NotAccepted())),
            ),
      ),
    )

  return ChatHandler.layer((event) => {
    switch (event._tag) {
      case "MessageCreated": {
        const id = event.message.id
        return Effect.gen(function* () {
          if (yield* seen.has(id)) return yield* drop("already handled")
          yield* attempt(route(event))
          yield* seen.add(id)
        }).pipe(Effect.annotateLogs({ discordMessageId: id }))
      }
      case "ReactionAdded": {
        if (!isThumbsUp(event.emoji)) return drop("a reaction other than a thumbs up")
        const id = approvalMessageId(event.messageId, event.userId)
        return Effect.gen(function* () {
          if (yield* seen.has(id)) return yield* drop("already handled")
          yield* attempt(routeReaction(event, id))
        }).pipe(Effect.annotateLogs({ discordMessageId: event.messageId }))
      }
      default:
        return Effect.void
    }
  })
})

const make = Effect.gen(function* () {
  const discord = yield* DiscordChat.DiscordChat
  const context = yield* Effect.context<ChatHandler.ChatHandler>()
  return DiscordIngress.of({
    dispatch: (payload) =>
      discord.dispatch(payload).pipe(
        Effect.provideContext(context),
        Effect.mapError(
          () => new DiscordIngressError({ message: `Discord ingress refused ${payload.t}` }),
        ),
      ),
  })
})

/**
 * Discord ingress for the gateway: a message from another guild, without a
 * member or of another type is dropped. In a channel, an admitted user's
 * mention starts a thread from the message and hands it to that thread's
 * session; in a thread, a message reaches the session when it has one or
 * when an admitted user mentions the bot. A direct message gets a pointer.
 * An admitted user's 👍 on the bot's message in a thread with a session is
 * handed to it as an approval that counts as a mention. The bot's own
 * messages never reach the handler.
 */
export const layer: Layer.Layer<
  DiscordIngress,
  never,
  DiscordBotConfig | DiscordSessions | SeenMessages | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DiscordBotConfig
    return Layer.effect(DiscordIngress, make).pipe(
      Layer.provide(Layer.unwrap(handler)),
      Layer.provide(DiscordChat.layer),
      Layer.provide(Chat.layer),
      Layer.provide(restLayer(config.botToken)),
    )
  }),
)
