import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type { AuthorClass, ChatMessage } from "../Platform.ts"
import { SlackConfig } from "./Config.ts"

/**
 * The Slack Web API with the bot token (EFF-3019), and what ingress and the
 * platform share: the admission rule and the shape of a thread message.
 */

/**
 * How a failed call may go on: `retry` once `retryAfter` seconds pass;
 * `uncertain` for a write that may have landed, so it is never repeated;
 * `denied` when Slack refused it.
 */
export const Disposition = Schema.Literals(["retry", "uncertain", "denied"])
export type Disposition = typeof Disposition.Type

export class SlackApiError extends Schema.TaggedError<SlackApiError>()("SlackApiError", {
  method: Schema.String,
  message: Schema.String,
  disposition: Disposition,
  /** In seconds. */
  retryAfter: Schema.Finite,
}) {}

/** Errors Slack answers when it may have done the work anyway. */
const SERVER_ERRORS = new Set([
  "internal_error",
  "fatal_error",
  "request_timeout",
  "service_unavailable",
])

/** Retries of a `retry` failure before the call gives up. */
const MAX_RETRIES = 3

const Envelope = Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) })

const failure = (method: string, message: string, disposition: Disposition, retryAfter = 30) =>
  new SlackApiError({ method, message, disposition, retryAfter })

/** Slack posts never unfurl links. */
export const noUnfurls = { unfurl_links: false, unfurl_media: false }

export interface CallOptions {
  /** A write: an outcome Slack didn't confirm is `uncertain`, never retried. */
  readonly write?: boolean
  /** Retry rate limits and failed reads. On by default. */
  readonly retry?: boolean
}

export class SlackApi extends Context.Service<
  SlackApi,
  {
    /**
     * Calls a Web API method with form parameters; objects are sent as JSON.
     * Succeeds with the response body once Slack answers `ok`.
     */
    readonly call: (
      method: string,
      params: Record<string, unknown>,
      options?: CallOptions,
    ) => Effect.Effect<unknown, SlackApiError>
    /** The bot's own user id, from `auth.test`. */
    readonly botUserId: Effect.Effect<string, SlackApiError>
    /** The HTTP client with the bot token, for file transfers. */
    readonly http: HttpClient.HttpClient
  }
>()("@janitor/cluster/Chat/Slack/Api/SlackApi") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* SlackConfig
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(config.botToken))),
      )

      const once = (method: string, params: Record<string, unknown>, write: boolean) =>
        Effect.gen(function* () {
          const unconfirmed = write ? "uncertain" : "retry"
          const invalid = failure(method, "Invalid Slack response", unconfirmed)
          const body: Record<string, string> = {}
          for (const [key, value] of Object.entries(params))
            if (value !== undefined)
              body[key] =
                typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value as string | number | boolean)
          const response = yield* http
            .execute(
              HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
                HttpClientRequest.bodyUrlParams(body),
              ),
            )
            .pipe(
              Effect.timeout(Duration.seconds(10)),
              Effect.mapError(() => failure(method, "Slack request did not complete", unconfirmed)),
            )
          if (response.status === 429) {
            const delay = Number(response.headers["retry-after"] ?? 1)
            return yield* failure(
              method,
              "Slack rate limited the request",
              "retry",
              Number.isFinite(delay) && delay > 0 ? delay : 1,
            )
          }
          if (response.status < 200 || response.status >= 300)
            return yield* failure(method, `Slack HTTP ${response.status}`, unconfirmed)
          const json = yield* response.json.pipe(Effect.mapError(() => invalid))
          const result = yield* Schema.decodeUnknownEffect(Envelope)(json).pipe(
            Effect.mapError(() => invalid),
          )
          if (!result.ok) {
            const error = result.error ?? "Slack refused the request"
            return yield* error === "ratelimited"
              ? failure(method, error, "retry", 1)
              : failure(method, error, SERVER_ERRORS.has(error) ? unconfirmed : "denied")
          }
          return json
        })

      const call = (method: string, params: Record<string, unknown>, options: CallOptions = {}) => {
        const attempt = (retries: number): Effect.Effect<unknown, SlackApiError> =>
          once(method, params, options.write ?? false).pipe(
            Effect.catchTag("SlackApiError", (error) =>
              error.disposition === "retry" && options.retry !== false && retries < MAX_RETRIES
                ? Effect.sleep(Duration.seconds(error.retryAfter)).pipe(
                    Effect.andThen(attempt(retries + 1)),
                  )
                : Effect.fail(error),
            ),
          )
        return attempt(0)
      }

      let botUser: string | undefined
      const botUserId = Effect.suspend(() =>
        botUser !== undefined
          ? Effect.succeed(botUser)
          : call("auth.test", {}).pipe(
              Effect.flatMap(decode("auth.test", Schema.Struct({ user_id: Schema.String }))),
              Effect.map(({ user_id }) => (botUser = user_id)),
            ),
      )

      return { call, botUserId, http }
    }),
  )
}

/** Decodes a method's response; a body that doesn't fit is a `retry` failure. */
export const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(method: string, schema: S) =>
  (body: unknown): Effect.Effect<S["Type"], SlackApiError> =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => failure(method, "Invalid Slack response", "retry")),
    )

const SlackUser = Schema.Struct({
  team_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  real_name: Schema.optionalKey(Schema.String),
  profile: Schema.optionalKey(
    Schema.Struct({
      display_name: Schema.optionalKey(Schema.String),
      real_name: Schema.optionalKey(Schema.String),
    }),
  ),
  is_restricted: Schema.optionalKey(Schema.Boolean),
  is_ultra_restricted: Schema.optionalKey(Schema.Boolean),
  is_stranger: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean),
  is_bot: Schema.optionalKey(Schema.Boolean),
})

export interface SlackAuthor {
  readonly class: AuthorClass
  readonly name: string
}

/**
 * Admits a Slack user with `users.info`: a full member of our workspace (its
 * `team_id`), not a guest, a stranger or deleted. A missing flag counts as
 * false, but a missing `team_id` doesn't admit. Any bot account is a bot. A
 * failed lookup denies: the author is an outsider.
 */
export const lookUpAuthor = (
  api: SlackApi["Service"],
  workspaceId: string,
  userId: string,
): Effect.Effect<SlackAuthor> =>
  api.call("users.info", { user: userId }, { retry: false }).pipe(
    Effect.flatMap(decode("users.info", Schema.Struct({ user: SlackUser }))),
    Effect.map(({ user }): SlackAuthor => {
      const name = user.profile?.display_name || user.real_name || user.name || userId
      if (user.is_bot === true) return { class: "bot", name }
      const admitted =
        user.team_id === workspaceId &&
        user.is_restricted !== true &&
        user.is_ultra_restricted !== true &&
        user.is_stranger !== true &&
        user.deleted !== true
      return { class: admitted ? "admitted" : "outsider", name }
    }),
    Effect.catchTag("SlackApiError", (error) =>
      Effect.logWarning("Couldn't look up a Slack user").pipe(
        Effect.annotateLogs({ method: error.method, reason: error.message }),
        Effect.as<SlackAuthor>({ class: "outsider", name: userId }),
      ),
    ),
  )

export const SlackFile = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  mimetype: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Finite),
})

const Timestamp = Schema.String.check(Schema.isPattern(/^\d+\.\d+$/))

/** The fields of a Slack message that janitor reads, in an event or a thread's history. */
export const SlackMessage = Schema.Struct({
  ts: Timestamp,
  thread_ts: Schema.optionalKey(Timestamp),
  user: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  app_id: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  edited: Schema.optionalKey(Schema.Unknown),
  files: Schema.optionalKey(Schema.Array(SlackFile)),
})
export type SlackMessage = typeof SlackMessage.Type

/**
 * Subtypes that are still a person's new message: one with files, and a
 * thread reply also sent to the channel. Every other subtype (edits,
 * deletions, joins, bot posts) is dropped.
 */
export const MESSAGE_SUBTYPES: ReadonlySet<string> = new Set(["file_share", "thread_broadcast"])

/** `<@U123>` or `<@U123|name>`. */
const mentionPattern = (botUserId: string) => new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g")

export const mentionsBot = (text: string, botUserId: string) => mentionPattern(botUserId).test(text)

/** A Slack message as a thread message, with mentions of the bot removed. */
export const toChatMessage = (
  message: SlackMessage,
  author: { readonly id: string } & SlackAuthor,
  botUserId: string,
  mentioned: boolean,
): ChatMessage => ({
  id: message.ts,
  author: { id: author.id, name: author.name, class: author.class },
  text: (message.text ?? "").replace(mentionPattern(botUserId), "").replace(/^\s+/, ""),
  mentionsBot: mentioned,
  sentAt: DateTime.makeUnsafe(Math.floor(Number(message.ts) * 1000)),
  attachments: (message.files ?? []).map((file) => ({
    id: file.id,
    name: file.name ?? file.id,
    mediaType: file.mimetype ?? "application/octet-stream",
    size: Math.max(0, Math.floor(file.size ?? 0)),
  })),
})
