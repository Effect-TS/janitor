import type * as Layer from "effect/Layer"
import type * as HttpClient from "effect/http/HttpClient"
import { ChatPlatform } from "../Platform.ts"
import type { SlackConfig } from "./Config.ts"

/**
 * Slack's `ChatPlatform`, over the Slack Web API with the bot token. A
 * rate-limited call is retried after its `Retry-After`. A write whose outcome
 * is unknown (a 5xx or a broken response) is never retried, and one Slack
 * refuses fails at once.
 *
 * Not implemented yet (EFF-3019): it binds no platform.
 */
export const layer: Layer.Layer<ChatPlatform, never, SlackConfig | HttpClient.HttpClient> =
  ChatPlatform.unavailable
