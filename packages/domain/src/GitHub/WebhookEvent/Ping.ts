import * as Schema from "effect/Schema"
import { GitHubWebhookHookIdFromStringOrNumber } from "../Id.ts"
import { BaseGitHubWebhookEvent } from "./Base.ts"

export const PingWebhookPayload = Schema.Struct({
  hookId: GitHubWebhookHookIdFromStringOrNumber,
  zen: Schema.NonEmptyString,
})
  .pipe(Schema.encodeKeys({ hookId: "hook_id" }))
  .annotate({ identifier: "PingWebhookPayload" })
export type PingWebhookPayload = typeof PingWebhookPayload.Type

export const PingWebhookEvent = Schema.Struct({
  ...BaseGitHubWebhookEvent.fields,
  name: Schema.Literal("ping"),
  payload: PingWebhookPayload,
}).annotate({ identifier: "PingWebhookEvent" })
export type PingWebhookEvent = typeof PingWebhookEvent.Type
