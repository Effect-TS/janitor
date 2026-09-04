import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  type GitHubApiScope,
  GitHubRateLimitHeaders,
  type GitHubRequestPriority,
  gitHubApiScopeKey,
} from "@janitor/domain/GitHub/Api"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { GitHubAppAuth, type GitHubAppAuthError } from "./AppAuth.ts"
import { GitHubBudget, type GitHubBudgetError } from "./RateBudget.ts"

export class GitHubTransportError extends Data.TaggedError("GitHubTransportError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** The shared budget says not to call GitHub before `until`. Callers wait durably. */
export class GitHubRateLimited extends Data.TaggedError("GitHubRateLimited")<{
  readonly scopeKey: string
  readonly until: DateTime.Utc
  readonly reason: string
}> {}

export interface GitHubRequest {
  readonly scope: GitHubApiScope
  readonly priority: GitHubRequestPriority
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  /** Path and query relative to the API base, or an absolute URL for `Link` pagination. */
  readonly url: string
  readonly body?: unknown
  /** Sent as `If-None-Match`; a `304` yields `NotModified`. */
  readonly etag?: string | undefined
  /** Which GitHub resource bucket the endpoint draws from. Defaults to "core". */
  readonly resource?: string | undefined
}

export type GitHubResponse =
  | {
      readonly _tag: "Ok"
      readonly status: number
      readonly body: unknown
      readonly etag: Option.Option<string>
      readonly link: Option.Option<string>
      readonly requestId: Option.Option<string>
    }
  | { readonly _tag: "NotModified"; readonly requestId: Option.Option<string> }
  /** A non-2xx status the caller must interpret (404, 403 without limit headers, 422...). */
  | {
      readonly _tag: "Failed"
      readonly status: number
      readonly body: unknown
      readonly requestId: Option.Option<string>
    }

export type GitHubTransportFailure =
  | GitHubTransportError
  | GitHubRateLimited
  | GitHubAppAuthError
  | GitHubBudgetError

/**
 * The one client every GitHub call goes through. It attaches App or
 * installation credentials, consults the shared budget before sending, and
 * records every response's rate headers afterwards.
 */
export class GitHubTransport extends Context.Service<
  GitHubTransport,
  {
    readonly request: (
      request: GitHubRequest,
    ) => Effect.Effect<GitHubResponse, GitHubTransportFailure>
  }
>()("@janitor/cluster/GitHub/Transport/GitHubTransport") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const auth = yield* GitHubAppAuth
      const budget = yield* GitHubBudget
      const decodeHeaders = Schema.decodeUnknownEffect(GitHubRateLimitHeaders)

      const readBody = (response: HttpClientResponse.HttpClientResponse) =>
        response.json.pipe(
          Effect.catch(() => response.text.pipe(Effect.orElseSucceed(() => undefined))),
        )

      const credential = (scope: GitHubApiScope) =>
        scope._tag === "App" ? auth.appJwt : auth.installationToken(scope.installationId)

      const send = Effect.fn("GitHubTransport.send")(function* (
        request: GitHubRequest,
        attempt: number,
      ): Generator<Effect.Effect<unknown, GitHubTransportFailure>, GitHubResponse> {
        const scopeKey = gitHubApiScopeKey(request.scope)
        const resource = request.resource ?? "core"
        // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
        const leaseToken = crypto.randomUUID()

        const decision = yield* budget.acquire({
          scopeKey,
          resource,
          priority: request.priority,
          leaseToken,
        })
        if (decision._tag === "Wait") {
          return yield* new GitHubRateLimited({
            scopeKey,
            until: decision.until,
            reason: decision.reason,
          })
        }

        return yield* Effect.gen(function* () {
          const token = yield* credential(request.scope)
          const url = request.url.startsWith("https://")
            ? request.url
            : `${GITHUB_API_BASE_URL}${request.url}`
          let httpRequest = HttpClientRequest.make(request.method)(url).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setHeaders({
              accept: "application/vnd.github+json",
              "x-github-api-version": GITHUB_API_VERSION,
              "user-agent": GITHUB_USER_AGENT,
              ...(request.etag === undefined ? {} : { "if-none-match": request.etag }),
            }),
          )
          if (request.body !== undefined) {
            httpRequest = yield* HttpClientRequest.bodyJson(httpRequest, request.body).pipe(
              Effect.mapError(
                (cause) => new GitHubTransportError({ message: "Request body is not JSON", cause }),
              ),
            )
          }

          const response = yield* http
            .execute(httpRequest)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubTransportError({ message: `GitHub request failed: ${url}`, cause }),
              ),
            )

          const observedAt = yield* DateTime.now
          const headers = yield* decodeHeaders(response.headers).pipe(
            Effect.orElseSucceed((): GitHubRateLimitHeaders => ({})),
          )
          const observedResource = headers["x-ratelimit-resource"] ?? resource

          const requestId = Headers.get(response.headers, "x-github-request-id")

          const record = (cooldown?: { until: DateTime.Utc; kind: "retry-after" | "secondary" }) =>
            budget.record({
              scopeKey,
              resource: observedResource,
              headers,
              observedAt,
              leaseToken,
              successful: response.status >= 200 && response.status < 400,
              ...(cooldown === undefined ? {} : { cooldown }),
            })
          if (response.status === 304) {
            yield* record()
            return { _tag: "NotModified" as const, requestId }
          }

          if (response.status === 401 && request.scope._tag === "Installation" && attempt === 0) {
            yield* record()
            yield* auth.invalidateInstallationToken(request.scope.installationId)
            return yield* send(request, attempt + 1)
          }

          const body = yield* readBody(response)
          const secondary =
            response.status === 429 ||
            (typeof body === "object" &&
              body !== null &&
              "message" in body &&
              /secondary rate|abuse/i.test(String(body.message)))
          const retryAfter = headers["retry-after"]
          const exhausted = headers["x-ratelimit-remaining"] === 0
          if (
            (response.status === 403 || response.status === 429) &&
            (retryAfter !== undefined || exhausted || secondary)
          ) {
            const until =
              retryAfter !== undefined
                ? DateTime.addDuration(observedAt, Duration.seconds(retryAfter))
                : exhausted && headers["x-ratelimit-reset"] !== undefined
                  ? DateTime.makeUnsafe(headers["x-ratelimit-reset"] * 1000)
                  : DateTime.addDuration(observedAt, Duration.minutes(1))
            yield* record({ until, kind: secondary || !exhausted ? "secondary" : "retry-after" })
            return yield* new GitHubRateLimited({
              scopeKey,
              until,
              reason: retryAfter !== undefined ? "retry-after" : "primary limit",
            })
          }

          yield* record()
          if (response.status >= 200 && response.status < 300) {
            return {
              _tag: "Ok" as const,
              status: response.status,
              body,
              etag: Headers.get(response.headers, "etag"),
              link: Headers.get(response.headers, "link"),
              requestId,
            }
          }
          return { _tag: "Failed" as const, status: response.status, body, requestId }
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(25),
            orElse: () =>
              Effect.fail(
                new GitHubTransportError({
                  message: "GitHub request exceeded its rate-budget lease",
                }),
              ),
          }),
          Effect.ensuring(budget.release(leaseToken).pipe(Effect.ignore)),
        )
      })

      return { request: (request: GitHubRequest) => send(request, 0) }
    }),
  )
}
