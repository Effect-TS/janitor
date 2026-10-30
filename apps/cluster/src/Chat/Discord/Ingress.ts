import { DiscordREST, type DiscordRESTError } from "dfx/DiscordREST"
import type * as Discord from "dfx/types"
import type * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { APPROVAL_TEXT, approvalMessageId, type ChatMessage, type ChatThread } from "../Platform.ts"
import { sessionClient } from "../Session.ts"
import {
  errorCode,
  MESSAGE_TYPES,
  rememberBotRoleId,
  rememberBotUserId,
  SUPPRESS_EMBEDS,
  THREAD_PARENT_TYPES,
  THREAD_TYPES,
  toAuthor,
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

/** A message ingress couldn't hand on for now; the gateway resumes and gets it again. */
export class DiscordIngressError extends Schema.TaggedError<DiscordIngressError>()(
  "DiscordIngressError",
  { message: Schema.String },
) {}

/**
 * The gateway Durable Object's ingress: it filters a `MESSAGE_CREATE`,
 * admits its author by `member.roles` and hands the message to its thread's
 * session, creating the thread for a channel mention. A `MESSAGE_REACTION_ADD`
 * of 👍 on the bot's message becomes an approval (EFF-3163).
 */
export class DiscordIngress extends Context.Service<
  DiscordIngress,
  {
    readonly handle: (
      message: Discord.GatewayMessageCreateDispatchData,
    ) => Effect.Effect<void, DiscordIngressError>
    readonly handleReaction: (
      reaction: Discord.GatewayMessageReactionAddDispatchData,
    ) => Effect.Effect<void, DiscordIngressError>
  }
>()("@janitor/cluster/Chat/Discord/Ingress/DiscordIngress") {}

/** The message ingress logs at Debug for each message it drops, with the reason. */
export const DROPPED = "Discord ingress dropped a message"

/**
 * 👍 with any skin tone. Discord sends a Unicode emoji with a null id,
 * though dfx types a reaction's emoji as a custom one, which has an id.
 */
const isThumbsUp = (emoji: { readonly id: string | null; readonly name: string | null }) =>
  emoji.id === null && emoji.name?.startsWith("👍") === true

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
  const botRoleId = rememberBotRoleId(rest, config.guildId)
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

  const drop = (reason: string) => Effect.logDebug(DROPPED).pipe(Effect.annotateLogs({ reason }))

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
    const chatMessage = toChatMessage(
      message,
      message.member,
      config.roleId,
      bot,
      message.mention_roles.length > 0 ? yield* botRoleId(bot) : undefined,
    )
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
  const routeReaction = Effect.fnUntraced(function* (
    reaction: Discord.GatewayMessageReactionAddDispatchData,
    id: string,
  ) {
    const bot = yield* botUserId
    if (reaction.message_author_id !== bot) return yield* drop("a reaction to another's message")
    if (reaction.guild_id !== config.guildId) return yield* drop("a reaction outside the guild")
    if (reaction.member === undefined) return yield* drop("no member")
    const author = toAuthor(reaction.member.user, reaction.member, config.roleId)
    if (author.class !== "admitted") return yield* drop(`a reaction from a ${author.class}`)
    if (!THREAD_TYPES.has(yield* channelType(reaction.channel_id)))
      return yield* drop("a reaction outside a thread")
    const thread: ChatThread = {
      _tag: "Discord",
      guild: reaction.guild_id,
      threadId: reaction.channel_id,
    }
    if (!(yield* sessions.exists(thread)))
      return yield* drop("a reaction in a thread with no session")
    yield* sessions.receive(thread, {
      id,
      author,
      text: APPROVAL_TEXT,
      mentionsBot: true,
      sentAt: yield* DateTime.now,
      attachments: [],
    })
    yield* seen.add(id)
    yield* Effect.logInfo("Discord ingress handed an approval to its session").pipe(
      Effect.annotateLogs({ threadId: thread.threadId }),
    )
  })

  /** A refusal from Discord won't change on a replay: it's logged and the message dropped. */
  const refused = (error: DiscordRESTError) =>
    Effect.logWarning("Discord refused a request for an inbound message").pipe(
      Effect.annotateLogs({ reason: error.message }),
    )

  /** Routes, dropping what Discord refuses; any other failure is for the replay. */
  const attempt = (routed: Effect.Effect<void, DiscordRESTError | DiscordSessionError>) =>
    routed.pipe(
      Effect.catchTags({ ErrorResponse: refused, RatelimitedResponse: refused }),
      Effect.mapError((error) => new DiscordIngressError({ message: error.message })),
    )

  return DiscordIngress.of({
    handle: (message) =>
      Effect.gen(function* () {
        if (yield* seen.has(message.id)) return yield* drop("already handled")
        yield* attempt(route(message))
        yield* seen.add(message.id)
      }).pipe(Effect.annotateLogs({ discordMessageId: message.id })),
    handleReaction: (reaction) =>
      Effect.gen(function* () {
        if (!isThumbsUp(reaction.emoji)) return yield* drop("a reaction other than a thumbs up")
        const id = approvalMessageId(reaction.message_id, reaction.user_id)
        if (yield* seen.has(id)) return yield* drop("already handled")
        yield* attempt(routeReaction(reaction, id))
      }).pipe(Effect.annotateLogs({ discordMessageId: reaction.message_id })),
  })
})

/**
 * Discord ingress for the gateway: a message from another guild, without a
 * member or of another type is dropped. In a channel, an admitted user's
 * mention starts a thread from the message and hands it to that thread's
 * session; in a thread, a message reaches the session when it has one or
 * when an admitted user mentions the bot. A direct message gets a pointer.
 * An admitted user's 👍 on the bot's message in a thread with a session is
 * handed to it as an approval that counts as a mention.
 */
export const layer: Layer.Layer<
  DiscordIngress,
  never,
  DiscordBotConfig | DiscordSessions | SeenMessages | DiscordREST
> = Layer.effect(DiscordIngress, make)
