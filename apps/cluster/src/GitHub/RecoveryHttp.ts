import * as Context from "effect/Context"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "@janitor/domain/GitHub/Api"
import { GitHubAppAuth } from "./AppAuth.ts"
import { nextLink } from "./Link.ts"

export class RecoveryError extends Schema.TaggedError<RecoveryError>()("RecoveryError", {
  message: Schema.String,
  retryAfter: Schema.Number,
  unavailable: Schema.Boolean,
}) {}
const recoveryFailure = (error: { readonly message: string }) =>
  error instanceof RecoveryError
    ? error
    : new RecoveryError({ message: error.message, retryAfter: 30, unavailable: false })
const Id = Schema.String.check(Schema.isPattern(/^\d+$/))
export const DeliverySummary = Schema.Struct({
  id: Id,
  guid: Schema.String,
  event: Schema.String,
  action: Schema.NullOr(Schema.String),
  repository_id: Schema.NullOr(Id),
  delivered_at: Schema.String,
})
export type DeliverySummary = typeof DeliverySummary.Type
export class GitHubRecoveryApi extends Context.Service<
  GitHubRecoveryApi,
  {
    readonly list: (
      cursor: string,
    ) => Effect.Effect<
      { deliveries: ReadonlyArray<DeliverySummary>; cursor: string; retryAfter: number },
      RecoveryError
    >
    readonly payload: (
      id: string,
    ) => Effect.Effect<
      { delivery: DeliverySummary; payload: unknown; retryAfter: number },
      RecoveryError
    >
  }
>()("GitHub/RecoveryApi") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const auth = yield* GitHubAppAuth
      const http = yield* HttpClient.HttpClient
      const base = `${GITHUB_API_BASE_URL}/app/hook/deliveries`
      const request = (url: string, cursorRequest = false) =>
        Effect.gen(function* () {
          const jwt = yield* auth.appJwt
          const response = yield* http.execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.bearerToken(Redacted.value(jwt)),
              HttpClientRequest.setHeaders({
                accept: "application/vnd.github+json",
                "x-github-api-version": GITHUB_API_VERSION,
                "user-agent": GITHUB_USER_AGENT,
              }),
            ),
          )
          const reset = Number(response.headers["x-ratelimit-reset"] ?? 0) * 1000
          const rawRetry = Number(response.headers["retry-after"] ?? 0)
          const retryAfter = Math.max(
            Number.isFinite(rawRetry) ? rawRetry : 30,
            response.headers["x-ratelimit-remaining"] === "0"
              ? (reset - (yield* Clock.currentTimeMillis)) / 1000
              : 0,
            0,
          )
          if (response.status < 200 || response.status >= 300)
            return yield* new RecoveryError({
              message: `GitHub retained-delivery request failed (${response.status})`,
              retryAfter: Math.max(30, retryAfter),
              unavailable:
                response.status === 404 ||
                response.status === 410 ||
                (cursorRequest && (response.status === 400 || response.status === 422)),
            })
          const raw = yield* response.text
          // JSON reviver source preserves integer IDs before IEEE-754 rounding. The runtime is Node 24 / Workers.
          const data: unknown = yield* Effect.try({
            try: () =>
              JSON.parse(raw, (key, value, context?: { source?: string }) =>
                (key === "id" || key.endsWith("_id")) &&
                typeof value === "number" &&
                context?.source !== undefined
                  ? context.source
                  : value,
              ),
            catch: () =>
              new RecoveryError({
                message: "Invalid retained-delivery JSON",
                retryAfter: 30,
                unavailable: false,
              }),
          })
          return {
            data,
            cursor: Option.getOrElse(nextLink(response.headers.link ?? ""), () => ""),
            retryAfter,
          }
        }).pipe(Effect.timeout("20 seconds"), Effect.mapError(recoveryFailure))
      return {
        list: (cursor) =>
          Effect.gen(function* () {
            const url = cursor === "" ? `${base}?per_page=100` : cursor
            const parsed = yield* Effect.try({
              try: () => new URL(url),
              catch: () =>
                new RecoveryError({
                  message: "Invalid recovery cursor",
                  retryAfter: 300,
                  unavailable: false,
                }),
            })
            if (parsed.origin + parsed.pathname !== base || parsed.username || parsed.password)
              return yield* new RecoveryError({
                message: "Recovery cursor escaped the App delivery endpoint",
                retryAfter: 300,
                unavailable: false,
              })
            const result = yield* request(url, cursor !== "")
            const deliveries = yield* Schema.decodeUnknownEffect(Schema.Array(DeliverySummary))(
              result.data,
            )
            return { ...result, deliveries }
          }).pipe(Effect.mapError(recoveryFailure)),
        payload: (id) =>
          Effect.gen(function* () {
            const result = yield* request(`${base}/${encodeURIComponent(id)}`)
            const delivery = yield* Schema.decodeUnknownEffect(DeliverySummary)(result.data)
            const body = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ request: Schema.Struct({ payload: Schema.Unknown }) }),
            )(result.data)
            return { delivery, payload: body.request.payload, retryAfter: result.retryAfter }
          }).pipe(Effect.mapError(recoveryFailure)),
      }
    }),
  )
}
