// Slack interactivity: a teammate's Retry or Skip click on an interruption
// message. The payload is verified like an event, the clicker must be an
// authorized teammate, and the click is forwarded to the runner with its own
// identity so a redelivered click cannot act twice. The button message is
// updated so stale buttons cannot be pressed for newer work.
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RunnerClient } from "../Agent/RunnerClient.ts"
import { Teammates } from "../Teammates.ts"
import { SlackConfig } from "./Config.ts"
import { ButtonValue, INTERRUPTION_ACTION_PREFIX } from "./Interruption.ts"
import { SlackTransport } from "./Transport.ts"
import type { SlackRequest } from "./Webhook.ts"

const Payload = Schema.Struct({
  type: Schema.String,
  team: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  api_app_id: Schema.optionalKey(Schema.String),
  user: Schema.Struct({ id: Schema.String }),
  channel: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  message: Schema.optionalKey(
    Schema.Struct({ ts: Schema.String, thread_ts: Schema.optionalKey(Schema.String) }),
  ),
  actions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        action_id: Schema.String,
        action_ts: Schema.optionalKey(Schema.String),
        value: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
})

export class SlackInteractivity extends Context.Service<
  SlackInteractivity,
  {
    readonly receive: (
      request: SlackRequest,
    ) => Effect.Effect<{ readonly status: number; readonly body: string }>
  }
>()("@janitor/cluster/Slack/Interactivity") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* SlackConfig
      const teammates = yield* Teammates
      const runner = yield* RunnerClient
      const transport = yield* SlackTransport
      const sql = yield* SqlClient.SqlClient
      const key = yield* Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(Redacted.value(config.signingSecret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      )
      const decodeButton = Schema.decodeUnknownOption(ButtonValue)
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
          const encoded = new URLSearchParams(request.body).get("payload")
          if (encoded === null) return { status: 400, body: "Missing payload" }
          const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))(
            encoded,
          ).pipe(Effect.option)
          if (parsed._tag === "None") return { status: 400, body: "Invalid payload" }
          const payload = parsed.value
          if (payload.type !== "block_actions") return { status: 200, body: "" }
          if (payload.team?.id !== config.workspaceId || payload.api_app_id !== config.appId)
            return { status: 403, body: "Wrong app or workspace" }
          const action = payload.actions?.find((action) =>
            action.action_id.startsWith(`${INTERRUPTION_ACTION_PREFIX}_`),
          )
          if (action === undefined || action.value === undefined) return { status: 200, body: "" }
          const button = decodeButton(action.value)
          if (button._tag === "None") return { status: 200, body: "" }
          const kind = action.action_id.endsWith("_retry") ? "retry" : "skip"
          const channel = payload.channel?.id
          const message = payload.message
          const ephemeral = (text: string) =>
            channel === undefined || message?.thread_ts === undefined
              ? Effect.void
              : transport
                  .ephemeral(channel, payload.user.id, message.thread_ts, text)
                  .pipe(Effect.ignore)
          const authority = yield* teammates.authorize({
            platform: "slack",
            workspaceId: config.workspaceId,
            accountId: payload.user.id,
          })
          if (authority._tag !== "Authorized") {
            yield* ephemeral("Only authorized teammates can retry or skip agent work.")
            return { status: 200, body: "" }
          }
          const [thread] = yield* sql<{ session_id: string }>`
            SELECT session_id FROM slack_thread WHERE session_id = ${button.value.sessionId}
              AND workspace_id = ${config.workspaceId} AND channel_id = ${channel ?? ""}
          `
          if (thread === undefined) {
            yield* ephemeral("This conversation no longer belongs to an agent session.")
            return { status: 200, body: "" }
          }
          const actionId = `slack:${payload.user.id}:${(action.action_ts ?? String(now)).replace(/[^0-9.]/g, "")}`
          const result = yield* runner
            .act(button.value.sessionId, {
              generation: button.value.generation,
              inputId: button.value.inputId,
              attempt: button.value.attempt,
              action: kind,
              actionId,
              actor: {
                source: "slack",
                teammateId: authority.teammateId,
                ...(authority.displayName === undefined
                  ? {}
                  : { displayName: authority.displayName }),
              },
            })
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            yield* Effect.logWarning("Slack interruption action failed", {
              sessionId: button.value.sessionId,
              message: result.failure.message,
            })
            yield* ephemeral("The runner could not apply that action right now. Try again shortly.")
            return { status: 200, body: "" }
          }
          const answer = result.success
          if (answer.outcome === "applied" && channel !== undefined && message !== undefined) {
            // Buttons are removed once a decision applied; the update is best effort and
            // the runner's deduplication is the guarantee.
            const who = authority.displayName ?? "A teammate"
            yield* transport
              .update(
                channel,
                message.ts,
                kind === "retry" ? `${who} retried this request.` : `${who} skipped this request.`,
                `action:${actionId}`,
              )
              .pipe(Effect.ignore)
          } else if (answer.outcome !== "applied") yield* ephemeral(answer.message)
          return { status: 200, body: "" }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Slack interactivity failed", cause).pipe(
              Effect.as({ status: 503, body: "Receipt unavailable" }),
            ),
          ),
        )
      return { receive }
    }),
  )
}
