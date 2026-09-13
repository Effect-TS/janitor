import * as Effect from "effect/Effect"
import * as Clock from "effect/Clock"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "@janitor/domain/GitHub/Api"
import { GitHubUserDatabaseIdFromStringOrNumber as Id } from "@janitor/domain/GitHub/Id"
import { RepositoryAccess } from "../Agent/RepositoryAccess.ts"
import { withRepositoryActivity } from "../RepositoryActivity.ts"
import { FeedbackError, GitHubFeedbackApi } from "./Feedback.ts"
import { GitHubCommentApi, GitHubCommentError } from "./FeedbackDelivery.ts"
import { nextLink } from "./Link.ts"
import { GitHubAppAuth } from "./AppAuth.ts"

const Posted = Schema.Struct({ id: Id })
const Published = Schema.Struct({
  id: Id,
  body: Schema.String,
  user: Schema.Struct({ type: Schema.String, id: Schema.optionalKey(Id) }),
  performed_via_github_app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Id }))),
  in_reply_to_id: Schema.optionalKey(Id),
  issue_url: Schema.optionalKey(Schema.String),
  pull_request_url: Schema.optionalKey(Schema.String),
})
const problem = (
  message: string,
  disposition: "retry" | "uncertain" | "missing" = "retry",
  retryAfter = 30,
) => new GitHubCommentError({ message, disposition, retryAfter })

/** Scoped credentials and exact endpoint checks apply to every page and write. */
export const GitHubFeedbackHttpLayer = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const authority = yield* RepositoryAccess
    const http = yield* HttpClient.HttpClient
    const appAuth = yield* Effect.serviceOption(GitHubAppAuth)
    const botIdentities = new Map<string, string>()
    const access = (sessionId: string, write: boolean) =>
      Effect.gen(function* () {
        const [session] = yield* sql<{
          generation: string
          repository_id: string
        }>`SELECT generation,repository_id FROM agent_session WHERE session_id=${sessionId}`
        if (!session) return yield* problem("Session no longer exists")
        const credential = yield* authority.authorize({
          sessionId,
          generation: Number(session.generation),
          repositoryId: session.repository_id,
          token: true,
          permission: write ? "pull_request" : "read",
          publication: write,
        })
        if (!credential.token || !credential.pullRequestNumber)
          return yield* problem("Associated PR credential is unavailable")
        return {
          ...credential,
          token: credential.token,
          base: `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(credential.owner)}/${encodeURIComponent(credential.repo)}`,
          number: credential.pullRequestNumber,
        }
      }).pipe(Effect.mapError((error) => problem(error.message)))
    type Access = Effect.Success<ReturnType<typeof access>>
    const request = (credential: Access, url: string, body?: unknown) =>
      Effect.gen(function* () {
        let req = HttpClientRequest.make(body === undefined ? "GET" : "POST")(url).pipe(
          HttpClientRequest.bearerToken(Redacted.value(credential.token)),
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": GITHUB_USER_AGENT,
          }),
        )
        if (body !== undefined) req = yield* HttpClientRequest.bodyJson(req, body)
        const response = yield* http.execute(req)
        const retry = Number(response.headers["retry-after"] ?? 30)
        const delay = Number.isFinite(retry) && retry > 0 ? retry : 30
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers["retry-after"] !== undefined ||
              response.headers["x-ratelimit-remaining"] === "0"))
        ) {
          const reset = Number(response.headers["x-ratelimit-reset"] ?? 0) * 1000
          return yield* problem(
            "GitHub rate limited feedback delivery",
            "retry",
            Math.max(delay, (reset - (yield* Clock.currentTimeMillis)) / 1000),
          )
        }
        if (response.status === 404 || response.status === 410)
          return yield* problem("GitHub reply target is missing or inaccessible", "missing", 300)
        if (response.status < 200 || response.status >= 300)
          return yield* problem(
            `GitHub feedback request failed (${response.status})`,
            body !== undefined && response.status >= 500 ? "uncertain" : "retry",
            delay,
          )
        const data = yield* response.json
        return { data, next: Option.getOrElse(nextLink(response.headers.link ?? ""), () => "") }
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError((error) =>
          error instanceof GitHubCommentError
            ? error
            : problem(error.message, body === undefined ? "retry" : "uncertain"),
        ),
      )
    const botIdentity = (credential: Access) =>
      Effect.gen(function* () {
        const cached = botIdentities.get(credential.appId!)
        if (cached) return cached
        if (Option.isNone(appAuth))
          return yield* problem("App authentication is unavailable for bot identity verification")
        const jwt = yield* appAuth.value.appJwt
        const appResponse = yield* request(
          { ...credential, token: jwt },
          `${GITHUB_API_BASE_URL}/app`,
        )
        const app = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: Id, slug: Schema.NonEmptyString }),
        )(appResponse.data)
        if (app.id !== credential.appId)
          return yield* problem("Authenticated App does not match the publication App")
        const login = `${app.slug}[bot]`
        const userResponse = yield* request(
          credential,
          `${GITHUB_API_BASE_URL}/users/${encodeURIComponent(login)}`,
        )
        const user = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ id: Id, login: Schema.String, type: Schema.Literal("Bot") }),
        )(userResponse.data)
        if (user.login.toLowerCase() !== login.toLowerCase())
          return yield* problem("GitHub bot identity does not match the authenticated App")
        botIdentities.set(app.id, user.id)
        return user.id
      }).pipe(
        Effect.mapError((error) =>
          error instanceof GitHubCommentError ? error : problem(error.message),
        ),
      )
    const page = (credential: Access, path: string, cursor: string) =>
      Effect.gen(function* () {
        const expected = `${credential.base}${path}`
        const url = cursor === "" ? `${expected}?per_page=100` : cursor
        const parsed = new URL(url)
        if (parsed.origin + parsed.pathname !== expected)
          return yield* problem("GitHub pagination escaped the feedback destination")
        return yield* request(credential, url)
      })
    const feedbackFailure = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new FeedbackError({
              message: error.message,
              ...(error instanceof GitHubCommentError ? { retryAfter: error.retryAfter } : {}),
            }),
        ),
      )
    return Layer.mergeAll(
      Layer.succeed(GitHubFeedbackApi, {
        review: (sessionId, reviewId) =>
          feedbackFailure(
            Effect.gen(function* () {
              const credential = yield* access(sessionId, false)
              return (yield* request(
                credential,
                `${credential.base}/pulls/${credential.number}/reviews/${encodeURIComponent(reviewId)}`,
              )).data
            }),
          ),
        comments: (sessionId, reviewId, cursor) =>
          feedbackFailure(
            Effect.gen(function* () {
              const credential = yield* access(sessionId, false)
              const result = yield* page(
                credential,
                `/pulls/${credential.number}/reviews/${encodeURIComponent(reviewId)}/comments`,
                cursor,
              )
              const comments = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown))(
                result.data,
              )
              return { comments, next: result.next }
            }),
          ),
      }),
      Layer.succeed(GitHubCommentApi, {
        post: (sessionId, target, text, marker) =>
          Effect.gen(function* () {
            const [session] = yield* sql<{
              repository_id: string
            }>`SELECT repository_id FROM agent_session WHERE session_id=${sessionId}`
            if (!session) return yield* problem("Session no longer exists")
            const result = yield* withRepositoryActivity(
              sql,
              session.repository_id,
              Effect.gen(function* () {
                const credential = yield* access(sessionId, true)
                const path =
                  target === null
                    ? `/issues/${credential.number}/comments`
                    : `/pulls/${credential.number}/comments/${encodeURIComponent(target)}/replies`
                const result = yield* request(credential, `${credential.base}${path}`, {
                  body: `${text}\n\n<!-- janitor-feedback:${marker} -->`,
                })
                return (yield* Schema.decodeUnknownEffect(Posted)(result.data).pipe(
                  Effect.mapError((error) => problem(error.message, "uncertain")),
                )).id
              }),
            )
            if (Option.isNone(result))
              return yield* problem("Repository feedback publication is paused or unavailable")
            return result.value
          }).pipe(
            Effect.mapError((error) =>
              error instanceof GitHubCommentError ? error : problem(error.message, "uncertain"),
            ),
          ),
        reconcile: (sessionId, target, marker, cursor) =>
          Effect.gen(function* () {
            const credential = yield* access(sessionId, false)
            if (!credential.appId)
              return yield* problem("GitHub App identity is unavailable for reconciliation")
            const path =
              target === null
                ? `/issues/${credential.number}/comments`
                : `/pulls/${credential.number}/comments`
            const result = yield* page(credential, path, cursor)
            const comments = yield* Schema.decodeUnknownEffect(Schema.Array(Published))(
              result.data,
            ).pipe(Effect.mapError((error) => problem(error.message)))
            const botId = comments.some(
              (comment) => comment.user.type === "Bot" && comment.performed_via_github_app == null,
            )
              ? yield* botIdentity(credential)
              : null
            const matches = comments.filter(
              (comment) =>
                comment.user.type === "Bot" &&
                (comment.performed_via_github_app == null
                  ? comment.user.id === botId
                  : comment.performed_via_github_app.id === credential.appId) &&
                comment.body.includes(`<!-- janitor-feedback:${marker} -->`) &&
                (target === null
                  ? comment.issue_url === `${credential.base}/issues/${credential.number}`
                  : comment.pull_request_url === `${credential.base}/pulls/${credential.number}` &&
                    comment.in_reply_to_id === target),
            )
            return { id: matches.length === 1 ? matches[0]!.id : null, next: result.next }
          }),
      }),
    )
  }),
)
