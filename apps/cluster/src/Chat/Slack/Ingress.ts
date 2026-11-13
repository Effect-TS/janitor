import * as SlackChat from "@effect/chat-slack/SlackChat"
import * as Chat from "effect/chat/Chat"
import type * as ChatEvent from "effect/chat/ChatEvent"
import * as ChatHandler from "effect/chat/ChatHandler"
import { mentionsSelf } from "effect/chat/ChatMessage"
import type * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import { failureCategory } from "../../Ingress/Webhooks.ts"
import type { ChatMessage, ChatThread } from "@janitor/domain/Chat/Session"
import { APPROVAL_TEXT, approvalMessageId, sessionMessage } from "../Message.ts"
import { sessionClient } from "../Session.ts"
import {
  isBotMessage,
  isDirectMessage,
  isEdited,
  isNewMessage,
  lookUpAuthor,
  type SlackAuthor,
  threadTs,
} from "./Api.ts"
import { SlackConfig } from "./Config.ts"

export class SlackSessionError extends Schema.TaggedError<SlackSessionError>()(
  "SlackSessionError",
  { message: Schema.String },
) {}

/** What Slack ingress asks of the chat session entities. */
export class SlackSessions extends Context.Service<
  SlackSessions,
  {
    /** Hands a message to its thread's session. */
    readonly receive: (
      thread: ChatThread,
      message: ChatMessage,
    ) => Effect.Effect<void, SlackSessionError>
    /** Whether the thread has a session, so a reply without a mention reaches it. */
    readonly exists: (thread: ChatThread) => Effect.Effect<boolean, SlackSessionError>
    /** The user's name, when the session remembers them as admitted within the hour. */
    readonly cachedAdmission: (
      thread: ChatThread,
      userId: string,
    ) => Effect.Effect<Option.Option<string>, SlackSessionError>
    readonly rememberAdmission: (
      thread: ChatThread,
      userId: string,
      name: string,
    ) => Effect.Effect<void, SlackSessionError>
  }
>()("@janitor/cluster/Chat/Slack/Ingress/SlackSessions") {
  /**
   * The session entities, through the cluster's client. `provide` is the
   * cluster handle's: routes are built before any request brings `Sharding`.
   */
  static readonly fromCluster = (
    provide: <A, E>(effect: Effect.Effect<A, E, Sharding.Sharding>) => Effect.Effect<A, E>,
  ): Layer.Layer<SlackSessions> => {
    const session = sessionClient(
      provide,
      (error) => new SlackSessionError({ message: String(error) }),
    )
    return Layer.succeed(this, {
      receive: (thread, message) =>
        session(thread, (client) => client.Receive({ thread, message }, { discard: true })),
      exists: (thread) => session(thread, (client) => client.Exists()),
      cachedAdmission: (thread, userId) =>
        session(thread, (client) => client.CachedAdmission({ userId })).pipe(
          Effect.map(Option.fromNullishOr),
        ),
      rememberAdmission: (thread, userId, name) =>
        session(thread, (client) => client.RememberAdmission({ userId, name })),
    })
  }
}

const DIRECT_MESSAGE_POINTER = "I only work in channels. Mention me in a channel to start a thread."

/** 👍 with any skin tone, as `effect/chat` writes Slack's `+1` and `thumbsup`. */
const isThumbsUp = (emoji: string) => emoji.startsWith("👍")

/**
 * The `ChatHandler` behind Slack's webhook: it filters a message, admits
 * its author and hands the message to its session; an admitted user's 👍
 * on the bot's message becomes an approval. A failure refuses the event, so
 * Slack retries it, and only the failure's category is logged: errors can
 * quote the message.
 */
const handler = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* SlackConfig
    const sessions = yield* SlackSessions
    const slack = yield* SlackChat.SlackChat
    const chat = yield* Chat.Chat

    const reply = (channel: string, text: string) =>
      chat.post(SlackChat.thread({ team: config.workspaceId, channel }), { markdown: text }).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("Couldn't reply in Slack").pipe(
            Effect.annotateLogs({ reason: error.message }),
          ),
        ),
      )

    /** Admits a Slack user, from the session's memory or `users.info`, and remembers an admission. */
    const admit = Effect.fnUntraced(function* (thread: ChatThread, user: string) {
      const cached = yield* sessions.cachedAdmission(thread, user)
      if (Option.isSome(cached))
        return { class: "admitted", name: cached.value } satisfies SlackAuthor
      const author = yield* lookUpAuthor(slack, config.workspaceId, user)
      if (author.class === "admitted") yield* sessions.rememberAdmission(thread, user, author.name)
      return author
    })

    /**
     * Hands an admitted user's 👍 on the bot's message in a thread with a
     * session to it as an approval (EFF-3163). A reaction never starts a
     * session, and anyone else's is ignored, not kept as context. The event
     * names the message but not its thread, which reading the message gives.
     */
    const handleReaction = Effect.fnUntraced(function* (event: ChatEvent.ReactionAdded) {
      if (!isThumbsUp(event.emoji)) return
      const botUserId = yield* slack.botUserId
      if (event.messageAuthorId !== botUserId || event.userId === botUserId) return
      const message = yield* chat.fetchMessage(event.thread, event.messageId).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.retry === "denied",
          (error) =>
            Effect.logWarning("Couldn't read a Slack message's thread").pipe(
              Effect.annotateLogs({ reason: error.message }),
              Effect.as(Option.none()),
            ),
        ),
      )
      const root = Option.flatMap(message, threadTs)
      if (Option.isNone(root)) return
      const thread: ChatThread = { _tag: "Slack", team: config.workspaceId, ...root.value }
      if (!(yield* sessions.exists(thread))) return
      const author = yield* admit(thread, event.userId)
      if (author.class !== "admitted") return
      yield* sessions.receive(thread, {
        id: approvalMessageId(event.messageId, event.userId),
        author: { id: event.userId, ...author },
        text: APPROVAL_TEXT,
        mentionsBot: true,
        sentAt: event.timestamp ?? (yield* DateTime.now),
        attachments: [],
      })
    })

    /** Filters the message, admits its author and hands the message to its session. */
    const handleMessage = Effect.fnUntraced(function* (event: ChatEvent.MessageCreated) {
      const message = event.message
      // `ChatHandler` drops the bot's own messages before they get here.
      if (isBotMessage(message) || isEdited(message) || !isNewMessage(message)) return
      if (event.kind === "direct") {
        if (isDirectMessage(message)) {
          const channel = Option.map(threadTs(message), ({ channel }) => channel)
          if (Option.isSome(channel)) yield* reply(channel.value, DIRECT_MESSAGE_POINTER)
        }
        return
      }
      const root = threadTs(message)
      if (Option.isNone(root)) return
      const mentioned = mentionsSelf(message)
      if (!mentioned && event.kind !== "thread") return
      const thread: ChatThread = { _tag: "Slack", team: config.workspaceId, ...root.value }
      const hasSession = yield* Effect.cached(sessions.exists(thread))
      if (!mentioned && !(yield* hasSession)) return

      const user = message.author.id
      const author = yield* admit(thread, user)
      // Only an admitted user's mention starts a session.
      if (author.class !== "admitted" && !(yield* hasSession)) return
      yield* sessions.receive(thread, sessionMessage(message, { id: user, ...author }))
    })

    return ChatHandler.layer((event) =>
      (event._tag === "MessageCreated"
        ? handleMessage(event)
        : event._tag === "ReactionAdded"
          ? handleReaction(event)
          : Effect.void
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Slack webhook failed").pipe(
            Effect.annotateLogs({ error: failureCategory(cause) }),
            Effect.andThen(Effect.fail(new ChatHandler.NotAccepted())),
          ),
        ),
      ),
    )
  }),
)

/**
 * `POST /webhooks/slack` (under `/api/v1`): `@effect/chat-slack`'s Events
 * API webhook. It checks the signature, its timestamp and the envelope, then
 * hands the events to janitor's handler, which filters them, admits each
 * author with `users.info` and hands the message to its session. A
 * `reaction_added` of 👍 on the bot's message is handed on as an approval.
 * Without an answer inside 2.5 seconds, the body's reading included, or when
 * the handler refuses the event, it returns 503, so Slack retries; sessions
 * dedupe the retry.
 */
/**
 * Logs each 503 the webhook answers, so a request Slack has to retry shows up
 * in the logs. The status alone doesn't say why: the handler refused the
 * event (logged before as "Slack webhook failed", with its error), the bot
 * user couldn't be read, or no answer came within the deadline, the body's
 * reading included. Nothing from the request is logged.
 */
const logUnavailable = HttpRouter.middleware((response) =>
  Effect.tap(response, (answer) =>
    answer.status === 503 ? Effect.logError("Slack webhook answered 503") : Effect.void,
  ),
).layer

export const SlackWebhookRoutesLayer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpClient.HttpClient | SlackConfig | SlackSessions
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* SlackConfig
    return SlackChat.layerWebhook({
      path: "/webhooks/slack",
      signingSecret: config.signingSecret,
      appId: config.appId,
    }).pipe(
      Layer.provide([handler, logUnavailable]),
      Layer.provideMerge(
        SlackChat.layer({ botToken: config.botToken, teamId: config.workspaceId }),
      ),
      Layer.provide(Chat.layer),
    )
  }),
)
