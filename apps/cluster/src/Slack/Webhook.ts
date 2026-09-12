import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { SlackConfig } from "./Config.ts"
import { SlackConversation } from "./Conversation.ts"

const Envelope = Schema.Struct({
  type: Schema.String,
  challenge: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
  api_app_id: Schema.optionalKey(Schema.String),
  event_id: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(Schema.Unknown),
})
const Event = Schema.Struct({
  type: Schema.String,
  channel: Schema.String,
  user: Schema.String,
  ts: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
  text: Schema.String,
  thread_ts: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))),
  channel_type: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  app_id: Schema.optionalKey(Schema.String),
  edited: Schema.optionalKey(Schema.Unknown),
})
export interface SlackRequest {
  readonly body: string
  readonly signature: string
  readonly timestamp: string
  readonly retry?: string
}
export class SlackWebhook extends Context.Service<
  SlackWebhook,
  {
    readonly receive: (
      request: SlackRequest,
    ) => Effect.Effect<{ readonly status: number; readonly body: string }>
  }
>()("@janitor/cluster/Slack/Webhook") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* SlackConfig
      const conversation = yield* SlackConversation
      const key = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(Redacted.value(config.signingSecret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      )
      const receive = (request: SlackRequest) =>
        Effect.gen(function* () {
          if (new TextEncoder().encode(request.body).byteLength > 1024 * 1024)
            return { status: 413, body: "Too large" }
          const now = yield* Clock.currentTimeMillis
          if (
            !/^\d+$/.test(request.timestamp) ||
            Math.abs(now / 1000 - Number(request.timestamp)) > 300 ||
            !/^v0=[0-9a-f]{64}$/.test(request.signature)
          )
            return { status: 401, body: "Invalid signature" }
          const signature = Uint8Array.from(request.signature.slice(3).match(/../g)!, (hex) =>
            parseInt(hex, 16),
          )
          const valid = yield* Effect.promise(() =>
            crypto.subtle.verify(
              "HMAC",
              key,
              signature,
              new TextEncoder().encode(`v0:${request.timestamp}:${request.body}`),
            ),
          )
          if (!valid) return { status: 401, body: "Invalid signature" }
          const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))(
            request.body,
          ).pipe(Effect.option)
          if (parsed._tag === "None") return { status: 400, body: "Invalid envelope" }
          const envelope = parsed.value
          if (envelope.type === "url_verification")
            return { status: 200, body: envelope.challenge ?? "" }
          if (
            envelope.team_id !== config.workspaceId ||
            envelope.api_app_id !== config.appId ||
            !envelope.event_id
          )
            return { status: 403, body: "Wrong app or workspace" }
          const decoded = Schema.decodeUnknownOption(Event)(envelope.event)
          const event = decoded._tag === "Some" ? decoded.value : null
          const eligible =
            event !== null &&
            (event.type === "app_mention" ||
              (event.type === "message" && event.channel_type === "group")) &&
            !event.subtype &&
            !event.bot_id &&
            !event.app_id &&
            event.edited === undefined &&
            event.user !== config.botUserId
          yield* conversation.record(
            envelope.event_id,
            envelope,
            eligible ? event : null,
            request.retry,
          )
          return { status: 200, body: "Accepted" }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Slack receipt failed", cause).pipe(
              Effect.as({ status: 503, body: "Receipt unavailable" }),
            ),
          ),
        )
      return { receive }
    }),
  )
}
