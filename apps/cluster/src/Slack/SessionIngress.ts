import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Teammates } from "../Teammates.ts"
import { SlackConfig } from "./Config.ts"
import { sessionKey, type SessionInput } from "./Session.ts"
import { SlackTransport } from "./Transport.ts"
import { makeSlackWebhook, SlackError, SlackWebhook } from "./Webhook.ts"

export class SessionAdmission extends Context.Service<
  SessionAdmission,
  {
    readonly receive: (key: string, input: SessionInput) => Effect.Effect<void, string>
  }
>()("Slack/SessionAdmission") {}

export const SessionIngressLive = Layer.effect(
  SlackWebhook,
  Effect.gen(function* () {
    const teammates = yield* Teammates
    const admission = yield* SessionAdmission
    const config = yield* SlackConfig
    const transport = yield* SlackTransport
    return yield* makeSlackWebhook(
      Effect.fnUntraced(
        function* (message) {
          const mentioned =
            message.type === "app_mention" || message.text.includes(`<@${config.botUserId}>`)
          if (!mentioned && message.thread_ts === undefined) return undefined
          const authorized = yield* teammates.authorize({
            platform: "slack",
            workspaceId: config.workspaceId,
            accountId: message.user,
          })
          if (authorized._tag !== "Authorized") return undefined
          const channel = yield* transport.channel(message.channel)
          if (!channel.is_private || !channel.is_member) return undefined
          const input: SessionInput = {
            workspace: config.workspaceId,
            channel: message.channel,
            thread: message.thread_ts ?? message.ts,
            timestamp: message.ts,
            user: message.user,
            text: message.text.replaceAll(`<@${config.botUserId}>`, "@janitor"),
            mentioned,
          }
          yield* admission.receive(sessionKey(input), input)
          return undefined
        },
        Effect.mapError((error) => new SlackError({ message: String(error) })),
      ),
    )
  }),
)
