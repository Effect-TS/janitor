import { DiscordREST, type DiscordRESTError } from "dfx/DiscordREST"
import type * as Discord from "dfx/types"
import type * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { ChatMessage, ChatThread } from "../Platform.ts"
import { sessionClient } from "../Session.ts"
import {
  errorCode,
  MESSAGE_TYPES,
  rememberBotUserId,
  SUPPRESS_EMBEDS,
  THREAD_PARENT_TYPES,
  THREAD_TYPES,
  toChatMessage,
} from "./Api.ts"
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
 * The message ids the gateway has handed on, kept in the gateway Durable
 * Object's storage. A RESUME replays what arrived while the socket was dark,
 * and a rebuilt instance reads the same storage, so a replayed message is
 * dropped.
 */
export class SeenMessages extends Context.Service<
  SeenMessages,
  {
    readonly has: (messageId: string) => Effect.Effect<boolean>
    /** Recorded once the message is handled, so a failure leaves it for the replay. */
    readonly add: (messageId: string) => Effect.Effect<void>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/SeenMessages") {}

/** A message ingress couldn't hand on for now; the gateway resumes and gets it again. */
export class DiscordIngressError extends Schema.TaggedError<DiscordIngressError>()(
  "DiscordIngressError",
  { message: Schema.String },
) {}

/**
 * The gateway Durable Object's ingress: it filters a `MESSAGE_CREATE`,
 * admits its author by `member.roles` and hands the message to its thread's
 * session, creating the thread for a channel mention.
 */
export class DiscordIngress extends Context.Service<
  DiscordIngress,
  {
    readonly handle: (
      message: Discord.GatewayMessageCreateDispatchData,
    ) => Effect.Effect<void, DiscordIngressError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordIngress") {}

const DIRECT_MESSAGE_POINTER = "I only work in servers. Mention me in a channel to start a thread."

/** Threads keep a day of quiet before Discord archives them. */
const AUTO_ARCHIVE_MINUTES = 1440

/** Discord's code for "A thread has already been created for this message". */
const THREAD_ALREADY_CREATED = 160004

/** Discord's limit on a thread name. */
const THREAD_NAME_CHARACTERS = 100

const threadName = (text: string): string => {
  const line =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "janitor"
  return line.length <= THREAD_NAME_CHARACTERS
    ? line
    : `${line.slice(0, THREAD_NAME_CHARACTERS - 1)}…`
}

const make = Effect.gen(function* () {
  const config = yield* DiscordBotConfig
  const sessions = yield* DiscordSessions
  const seen = yield* SeenMessages
  const rest = yield* DiscordREST

  const botUserId = rememberBotUserId(rest)
  /** Channel types never change, so each is looked up once per instance. */
  const channelTypes = new Map<string, number>()
  const channelType = (channelId: string) =>
    Effect.suspend(() => {
      const known = channelTypes.get(channelId)
      return known !== undefined
        ? Effect.succeed(known)
        : Effect.tap(
            Effect.map(rest.getChannel(channelId), (channel) => channel.type as number),
            (type) => Effect.sync(() => channelTypes.set(channelId, type)),
          )
    })

  /** A thread from the message; replayed, the message already has one, with its id. */
  const startThread = (message: Discord.GatewayMessageCreateDispatchData, text: string) =>
    rest
      .createThreadFromMessage(message.channel_id, message.id, {
        name: threadName(text),
        auto_archive_duration: AUTO_ARCHIVE_MINUTES,
      })
      .pipe(
        Effect.map((thread) => thread.id),
        Effect.catchIf(
          (error) => errorCode(error) === THREAD_ALREADY_CREATED,
          () => Effect.succeed(message.id),
        ),
      )

  const directMessage = (message: Discord.GatewayMessageCreateDispatchData) =>
    rest.createMessage(message.channel_id, {
      content: DIRECT_MESSAGE_POINTER,
      allowed_mentions: { parse: [] },
      flags: SUPPRESS_EMBEDS,
    })

  const drop = (reason: string) =>
    Effect.logDebug("Discord ingress dropped a message").pipe(Effect.annotateLogs({ reason }))

  /** Hands the message on, or drops it; fails only with what a replay could fix. */
  const route = Effect.fnUntraced(function* (message: Discord.GatewayMessageCreateDispatchData) {
    const bot = yield* botUserId
    if (message.author.id === bot) return yield* drop("the bot's own message")
    if (!MESSAGE_TYPES.has(message.type)) return yield* drop(`message type ${message.type}`)
    if (message.guild_id === undefined) {
      if (message.author.bot !== true) yield* directMessage(message)
      else yield* drop("a direct message from a bot")
      return
    }
    if (message.guild_id !== config.guildId) return yield* drop("another guild")
    // Webhooks and system messages have no member.
    if (message.member === undefined) return yield* drop("no member")
    const chatMessage = toChatMessage(message, message.member, config.roleId, bot)
    // Only an admitted user's mention starts a session.
    const starts = chatMessage.mentionsBot && chatMessage.author.class === "admitted"
    const notStarting = chatMessage.mentionsBot ? "the author lacks the role" : "no bot mention"
    const type = yield* channelType(message.channel_id)
    let thread: ChatThread
    if (THREAD_TYPES.has(type)) {
      thread = { _tag: "Discord", guild: message.guild_id, threadId: message.channel_id }
      if (!starts && !(yield* sessions.exists(thread)))
        return yield* drop(`a thread with no session, and ${notStarting}`)
    } else {
      if (!starts) return yield* drop(notStarting)
      if (!THREAD_PARENT_TYPES.has(type)) return yield* drop(`channel type ${type}`)
      thread = {
        _tag: "Discord",
        guild: message.guild_id,
        threadId: yield* startThread(message, chatMessage.text),
      }
    }
    yield* sessions.receive(thread, chatMessage)
  })

  /** A refusal from Discord won't change on a replay: it's logged and the message dropped. */
  const refused = (error: DiscordRESTError) =>
    Effect.logWarning("Discord refused a request for an inbound message").pipe(
      Effect.annotateLogs({ reason: error.message }),
    )

  return DiscordIngress.of({
    handle: (message) =>
      Effect.gen(function* () {
        if (yield* seen.has(message.id)) return yield* drop("already handled")
        yield* route(message).pipe(
          Effect.catchTags({ ErrorResponse: refused, RatelimitedResponse: refused }),
          Effect.mapError((error) => new DiscordIngressError({ message: error.message })),
        )
        yield* seen.add(message.id)
      }).pipe(Effect.annotateLogs({ discordMessageId: message.id })),
  })
})

/**
 * Discord ingress for the gateway: a message from another guild, without a
 * member or of another type is dropped. In a channel, an admitted user's
 * mention starts a thread from the message and hands it to that thread's
 * session; in a thread, a message reaches the session when it has one or
 * when an admitted user mentions the bot. A direct message gets a pointer.
 */
export const layer: Layer.Layer<
  DiscordIngress,
  never,
  DiscordBotConfig | DiscordSessions | SeenMessages | DiscordREST
> = Layer.effect(DiscordIngress, make)
