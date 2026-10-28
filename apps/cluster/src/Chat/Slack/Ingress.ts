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
import { type ChatMessage, type ChatThread, sessionKey } from "../Platform.ts"
import { ChatSession } from "../Session.ts"
import {
  isExtShared,
  lookUpAuthor,
  MESSAGE_SUBTYPES,
  mentionsBot,
  SlackApi,
  type SlackAuthor,
  SlackMessage,
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
    const session = (thread: ChatThread) =>
      Effect.map(ChatSession.client, (client) => client(sessionKey(thread)))
    const run = <A, E>(effect: Effect.Effect<A, E, Sharding.Sharding>) =>
      provide(effect).pipe(
        Effect.mapError((error) => new SlackSessionError({ message: String(error) })),
      )
    return Layer.succeed(this, {
      receive: (thread, message) =>
        run(
          Effect.flatMap(session(thread), (client) =>
            client.Receive({ thread, message }, { discard: true }),
          ),
        ),
      exists: (thread) => run(Effect.flatMap(session(thread), (client) => client.Exists())),
      cachedAdmission: (thread, userId) =>
        run(Effect.flatMap(session(thread), (client) => client.CachedAdmission({ userId }))).pipe(
          Effect.map(Option.fromNullishOr),
        ),
      rememberAdmission: (thread, userId, name) =>
        run(
          Effect.flatMap(session(thread), (client) => client.RememberAdmission({ userId, name })),
        ),
    })
  }
}

export const MAX_SLACK_WEBHOOK_BODY_BYTES = 1024 * 1024

/** Slack retries a delivery it has no answer to within 3 seconds. */
const ANSWER_WITHIN = Duration.millis(2500)

const SLACK_CONNECT_REFUSAL =
  "I don't work in Slack Connect channels, since they're shared with other organizations."
const DIRECT_MESSAGE_POINTER = "I only work in channels. Mention me in a channel to start a thread."

const accepted = HttpServerResponse.text("Accepted")
const invalidSignature = HttpServerResponse.text("Invalid signature", { status: 401 })
const unavailable = HttpServerResponse.text("Service Unavailable", { status: 503 })

const Envelope = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
  api_app_id: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(Schema.Unknown),
})

const Event = Schema.Struct({
  ...SlackMessage.fields,
  type: Schema.String,
  channel: Schema.String,
  channel_type: Schema.optionalKey(Schema.String),
})
type Event = typeof Event.Type

const SlackHeaders = Schema.Struct({
  "x-slack-signature": Schema.String,
  "x-slack-request-timestamp": Schema.String,
})

const Routes = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* SlackConfig
    const sessions = yield* SlackSessions
    const api = yield* SlackApi
    const verifier = yield* WebhookVerifier.SlackWebhookVerifier
    const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))
    const decodeEvent = Schema.decodeUnknownOption(Event)

    const reply = (channel: string, threadTs: string | undefined, text: string) =>
      api
        .call(
          "chat.postMessage",
          { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false },
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

      const cached = yield* sessions.cachedAdmission(thread, user)
      const author: SlackAuthor = Option.isSome(cached)
        ? { class: "admitted", name: cached.value }
        : yield* lookUpAuthor(api, config.workspaceId, user)
      // Only an admitted user's mention starts a session.
      if (author.class !== "admitted" && !(yield* hasSession)) return
      // An admitted message can start or steer a turn, whose replies a Slack
      // Connect channel shows outside the workspace. A channel can become
      // shared after its session started, so every one is checked.
      if (author.class === "admitted" && (yield* isExtShared(api, event.channel))) {
        // Slack also delivers a mention as a message event; refuse once.
        if (event.type === "app_mention")
          yield* reply(event.channel, thread.threadTs, SLACK_CONNECT_REFUSAL)
        return
      }
      if (author.class === "admitted" && Option.isNone(cached))
        yield* sessions.rememberAdmission(thread, user, author.name)
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
        const valid = yield* verifier
          .verify({
            signature: headers.value["x-slack-signature"],
            timestamp: headers.value["x-slack-request-timestamp"],
            body,
          })
          .pipe(Effect.catchTag("InvalidSignatureError", () => Effect.succeed(false)))
        if (!valid) return invalidSignature

        const envelope = decodeEnvelope(new TextDecoder().decode(body))
        if (envelope._tag === "None")
          return HttpServerResponse.text("Invalid envelope", { status: 400 })
        if (envelope.value.type === "url_verification")
          return HttpServerResponse.text(envelope.value.challenge ?? "")
        if (envelope.value.type !== "event_callback") return accepted
        if (
          envelope.value.team_id !== config.workspaceId ||
          envelope.value.api_app_id !== config.appId
        )
          return HttpServerResponse.text("Wrong app or workspace", { status: 403 })
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
 * `users.info` and hands the message to its session, then answers 200.
 * Without an answer inside 2.5 seconds it returns 503, so Slack retries.
 */
export const SlackWebhookRoutesLayer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpClient.HttpClient | SlackConfig | SlackSessions
> = Routes.pipe(
  Layer.provide(SlackApi.layer),
  Layer.provide(
    Layer.unwrap(
      Effect.map(SlackConfig, (config) =>
        WebhookVerifier.slackLayerFrom({ secret: config.signingSecret }),
      ),
    ),
  ),
)
