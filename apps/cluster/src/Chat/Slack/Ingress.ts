import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/http/HttpClient"
import type * as HttpRouter from "effect/http/HttpRouter"
import type { ChatMessage, ChatThread } from "../Platform.ts"
import type { SlackConfig } from "./Config.ts"

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
    /** Whether the session remembers the user as admitted within the hour. */
    readonly cachedAdmission: (
      thread: ChatThread,
      userId: string,
    ) => Effect.Effect<boolean, SlackSessionError>
    readonly rememberAdmission: (
      thread: ChatThread,
      userId: string,
    ) => Effect.Effect<void, SlackSessionError>
  }
>()("@janitor/cluster/Chat/Slack/Ingress/SlackSessions") {}

/**
 * `POST /webhooks/slack` (under `/api/v1`): the Events API webhook. It checks
 * the signature and the envelope, filters the event, admits its author with
 * `users.info` and hands the message to its session, then answers 200.
 * Without an answer inside 2.5 seconds it returns 503, so Slack retries.
 *
 * Not implemented yet (EFF-3019): it adds no route.
 */
export const SlackWebhookRoutesLayer: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter | HttpClient.HttpClient | SlackConfig | SlackSessions
> = Layer.empty
