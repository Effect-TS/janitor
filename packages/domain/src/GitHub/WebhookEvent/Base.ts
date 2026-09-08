import * as Schema from "effect/Schema"
import { GitHubWebhookDeliveryId } from "../Id.ts"

export const BaseGitHubWebhookEvent = Schema.Struct({
  id: GitHubWebhookDeliveryId,
}).annotate({ identifier: "BaseGitHubWebhookEvent" })
export type BaseGitHubWebhookEvent = typeof BaseGitHubWebhookEvent.Type
