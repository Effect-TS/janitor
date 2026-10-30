import type * as Sharding from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { failureCategory, readBodyBounded } from "../../Ingress/Webhooks.ts"
import * as WebhookVerifier from "../../Ingress/WebhookVerifier.ts"
import { APPROVAL_TEXT, approvalMessageId, type ChatMessage, type ChatThread } from "../Platform.ts"
import { sessionClient } from "../Session.ts"
import {
  decode,
  lookUpAuthor,
  MESSAGE_SUBTYPES,
  mentionsBot,
  noUnfurls,
  SlackApi,
  type SlackAuthor,
  SlackMessage,
  sentAt,
  Timestamp,
  toChatMessage,
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

export const MAX_SLACK_WEBHOOK_BODY_BYTES = 1024 * 1024

/** Slack retries a delivery it has no answer to within 3 seconds. */
const ANSWER_WITHIN = Duration.millis(2500)

const DIRECT_MESSAGE_POINTER = "I only work in channels. Mention me in a channel to start a thread."

const accepted = HttpServerResponse.text("Accepted")
const invalidSignature = HttpServerResponse.text("Invalid signature", { status: 401 })
const unavailable = HttpServerResponse.text("Service Unavailable", { status: 503 })

const Envelope = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
  api_app_id: Schema.optionalKey(Schema.String),
  authorizations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ team_id: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  event: Schema.optionalKey(Schema.Unknown),
})
type Envelope = typeof Envelope.Type

const Event = Schema.Struct({
  ...SlackMessage.fields,
  type: Schema.String,
  channel: Schema.String,
  channel_type: Schema.optionalKey(Schema.String),
})
type Event = typeof Event.Type

/**
 * A `reaction_added` of 👍, any skin tone, on a message: Slack names the
 * emoji `+1`, with `thumbsup` as its alias. The item names the message, but
 * not the message's thread.
 */
const ThumbsUp = Schema.Struct({
  type: Schema.Literal("reaction_added"),
  user: Schema.String,
  reaction: Schema.String.check(Schema.isPattern(/^(\+1|thumbsup)(::skin-tone-[2-6])?$/)),
  /** Who wrote the message; missing for one without a user, such as a webhook's. */
  item_user: Schema.optionalKey(Schema.String),
  item: Schema.Struct({ type: Schema.Literal("message"), channel: Schema.String, ts: Timestamp }),
  event_ts: Timestamp,
})
type ThumbsUp = typeof ThumbsUp.Type

const SlackHeaders = Schema.Struct({
  "x-slack-signature": Schema.String,
  "x-slack-request-timestamp": Schema.String,
})

const Routes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* SlackConfig
    const sessions = yield* SlackSessions
    const api = yield* SlackApi
    const verify = yield* WebhookVerifier.slackVerifier({ secret: config.signingSecret })
    const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))
    const decodeEvent = Schema.decodeUnknownOption(Event)
    const decodeThumbsUp = Schema.decodeUnknownOption(ThumbsUp)

    /**
     * Whether the event is for our workspace. In a Slack Connect channel the
     * other organization hosts, the envelope can carry its team, with our
     * installation in `authorizations`.
     */
    const forWorkspace = (envelope: Envelope) =>
      envelope.team_id === config.workspaceId ||
      (envelope.authorizations ?? []).some(({ team_id }) => team_id === config.workspaceId)

    const reply = (channel: string, threadTs: string | undefined, text: string) =>
      api
        .call(
          "chat.postMessage",
          { channel, thread_ts: threadTs, text, ...noUnfurls },
          { write: true },
        )
        .pipe(
          Effect.asVoid,
          Effect.catchTag("SlackApiError", (error) =>
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
      const author = yield* lookUpAuthor(api, config.workspaceId, user)
      if (author.class === "admitted") yield* sessions.rememberAdmission(thread, user, author.name)
      return author
    })

    /**
     * The root of the thread a message is in. `conversations.replies` takes
     * any message of a thread and answers with the thread, the root first;
     * each threaded message carries the root's `ts` as `thread_ts`, and a
     * message outside any thread has none. A message Slack won't show, gone
     * or in a channel the bot left, has no thread.
     */
    const threadOf = (channel: string, ts: string) =>
      api.call("conversations.replies", { channel, ts, limit: 1 }, { retry: false }).pipe(
        Effect.flatMap(
          decode(
            "conversations.replies",
            Schema.Struct({
              messages: Schema.Array(Schema.Struct({ thread_ts: SlackMessage.fields.thread_ts })),
            }),
          ),
        ),
        Effect.map(({ messages }) => messages[0]?.thread_ts),
        Effect.catchIf(
          (error) => error.disposition === "denied",
          (error) =>
            Effect.logWarning("Couldn't read a Slack message's thread").pipe(
              Effect.annotateLogs({ reason: error.message }),
              Effect.as(undefined),
            ),
        ),
      )

    /**
     * Hands an admitted user's 👍 on the bot's message in a thread with a
     * session to it as an approval (EFF-3163). A reaction never starts a
     * session, and anyone else's is ignored, not kept as context.
     */
    const handleReaction = Effect.fnUntraced(function* (event: ThumbsUp) {
      const { channel, ts } = event.item
      const botUserId = yield* api.botUserId
      if (event.item_user !== botUserId || event.user === botUserId) return
      const threadTs = yield* threadOf(channel, ts)
      if (threadTs === undefined) return
      const thread: ChatThread = { _tag: "Slack", team: config.workspaceId, channel, threadTs }
      if (!(yield* sessions.exists(thread))) return
      const author = yield* admit(thread, event.user)
      if (author.class !== "admitted") return
      yield* sessions.receive(thread, {
        id: approvalMessageId(ts, event.user),
        author: { id: event.user, ...author },
        text: APPROVAL_TEXT,
        mentionsBot: true,
        sentAt: sentAt(event.event_ts),
        attachments: [],
      })
    })

    /** Filters the event, admits its author and hands the message to its session. */
    const handle = Effect.fnUntraced(function* (event: Event) {
      if (event.type !== "message" && event.type !== "app_mention") return
      const user = event.user
      if (
        user === undefined ||
        (event.subtype !== undefined && !MESSAGE_SUBTYPES.has(event.subtype)) ||
        event.bot_id !== undefined ||
        event.app_id !== undefined ||
        event.edited !== undefined
      )
        return
      const botUserId = yield* api.botUserId
      if (user === botUserId) return
      if (event.channel_type === "im") {
        if (event.type === "message") yield* reply(event.channel, undefined, DIRECT_MESSAGE_POINTER)
        return
      }
      const mentioned = event.type === "app_mention" || mentionsBot(event.text ?? "", botUserId)
      if (!mentioned && event.thread_ts === undefined) return
      const thread: ChatThread = {
        _tag: "Slack",
        team: config.workspaceId,
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
      }
      const hasSession = yield* Effect.cached(sessions.exists(thread))
      if (!mentioned && !(yield* hasSession)) return

      const author = yield* admit(thread, user)
      // Only an admitted user's mention starts a session.
      if (author.class !== "admitted" && !(yield* hasSession)) return
      yield* sessions.receive(
        thread,
        toChatMessage(event, { id: user, ...author }, botUserId, mentioned),
      )
    })

    return HttpRouter.add(
      "POST",
      "/webhooks/slack",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const headers = Schema.decodeUnknownOption(SlackHeaders)(request.headers)
        if (headers._tag === "None") return invalidSignature
        const body = yield* readBodyBounded(request, MAX_SLACK_WEBHOOK_BODY_BYTES).pipe(
          Effect.catchTag("BodyTooLargeError", () => Effect.undefined),
        )
        if (body === undefined) return HttpServerResponse.text("Too large", { status: 413 })
        const valid = yield* verify({
          signature: headers.value["x-slack-signature"],
          timestamp: headers.value["x-slack-request-timestamp"],
          body,
        }).pipe(Effect.catchTag("InvalidSignatureError", () => Effect.succeed(false)))
        if (!valid) return invalidSignature

        const envelope = decodeEnvelope(new TextDecoder().decode(body))
        if (envelope._tag === "None")
          return HttpServerResponse.text("Invalid envelope", { status: 400 })
        if (envelope.value.type === "url_verification")
          return HttpServerResponse.text(envelope.value.challenge ?? "")
        if (envelope.value.type !== "event_callback") return accepted
        if (!forWorkspace(envelope.value) || envelope.value.api_app_id !== config.appId)
          return HttpServerResponse.text("Wrong app or workspace", { status: 403 })
        const thumbsUp = decodeThumbsUp(envelope.value.event)
        if (thumbsUp._tag === "Some")
          return yield* handleReaction(thumbsUp.value).pipe(Effect.as(accepted))
        const event = decodeEvent(envelope.value.event)
        if (event._tag === "None") return accepted
        return yield* handle(event.value).pipe(Effect.as(accepted))
      }).pipe(
        // The whole request, a slowly streamed body included.
        Effect.timeout(ANSWER_WITHIN),
        // Without an answer Slack retries, and sessions dedupe the retry. Only
        // the failure's category is logged: errors can quote the message.
        Effect.catchCause((cause) =>
          Effect.logError("Slack webhook failed").pipe(
            Effect.annotateLogs({ error: failureCategory(cause) }),
            Effect.as(unavailable),
          ),
        ),
      ),
    )
  }),
)

/**
 * `POST /webhooks/slack` (under `/api/v1`): the Events API webhook. It checks
 * the signature and the envelope, filters the event, admits its author with
 * `users.info` and hands the message to its session, then answers 200. A
 * `reaction_added` of 👍 on the bot's message is handed on as an approval.
 * Without an answer inside 2.5 seconds it returns 503, so Slack retries.
 */
export const SlackWebhookRoutesLayer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpClient.HttpClient | SlackConfig | SlackSessions
> = Routes.pipe(Layer.provide(SlackApi.layer))
