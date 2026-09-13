import { GITHUB_WORKSPACE_ID } from "@janitor/domain/Team/Account"
import { GitHubUserDatabaseIdFromStringOrNumber as Id } from "@janitor/domain/GitHub/Id"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentSessions } from "../Agent/Sessions.ts"
import { Teammates } from "../Teammates.ts"

const User = Schema.Struct({ id: Id, type: Schema.String })
export const FeedbackReview = Schema.Struct({
  id: Id,
  user: User,
  body: Schema.NullOr(Schema.String),
  submitted_at: Schema.NullOr(Schema.String),
  state: Schema.String,
})
export const FeedbackComment = Schema.Struct({
  id: Id,
  user: User,
  body: Schema.String,
  pull_request_review_id: Schema.optionalKey(Schema.NullOr(Id)),
  in_reply_to_id: Schema.optionalKey(Schema.NullOr(Id)),
})
const Envelope = Schema.Struct({
  action: Schema.String,
  repository: Schema.Struct({ id: Id }),
  pull_request: Schema.optionalKey(Schema.Struct({ number: Schema.Int })),
  issue: Schema.optionalKey(
    Schema.Struct({ number: Schema.Int, pull_request: Schema.optionalKey(Schema.Unknown) }),
  ),
  review: Schema.optionalKey(FeedbackReview),
  comment: Schema.optionalKey(FeedbackComment),
})
export class FeedbackError extends Schema.TaggedError<FeedbackError>()("FeedbackError", {
  message: Schema.String,
  retryAfter: Schema.optionalKey(Schema.Number),
}) {}
export const feedbackError = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof FeedbackError ? error : new FeedbackError({ message: error.message }),
    ),
  )

export class GitHubFeedbackApi extends Context.Service<
  GitHubFeedbackApi,
  {
    readonly review: (sessionId: string, reviewId: string) => Effect.Effect<unknown, FeedbackError>
    readonly comments: (
      sessionId: string,
      reviewId: string,
      cursor: string,
    ) => Effect.Effect<
      { readonly comments: ReadonlyArray<unknown>; readonly next: string },
      FeedbackError
    >
  }
>()("GitHub/FeedbackApi") {}

export class GitHubFeedbackConfig extends Context.Service<
  GitHubFeedbackConfig,
  { readonly botLogin: string }
>()("GitHub/FeedbackConfig") {}

export interface FeedbackRow {
  readonly session_id: string
  readonly contribution_key: string
  readonly review_id: string | null
  readonly reviewer_id: string
  readonly author: { readonly teammateId?: string; readonly displayName?: string }
  readonly authorized: boolean
  readonly body: string | null
  readonly submitted: boolean
  readonly inline_target: string | null
  readonly state: "pending" | "accepted" | "context" | "empty"
  readonly cursor: string
  readonly warning: string | null
}

export class GitHubFeedback extends Context.Service<
  GitHubFeedback,
  {
    /** Called only after signature verification, within the repository intake fence. */
    readonly record: (
      deliveryId: string,
      name: string,
      body: unknown,
    ) => Effect.Effect<void, FeedbackError>
    readonly processDue: Effect.Effect<void, FeedbackError>
    readonly inspect: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<FeedbackRow>, FeedbackError>
  }
>()("GitHub/Feedback") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const teammates = yield* Teammates
      const sessions = yield* AgentSessions
      const api = yield* GitHubFeedbackApi
      const config = yield* GitHubFeedbackConfig
      const login = config.botLogin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const mentioned = (text: string) =>
        login !== "" &&
        new RegExp(`(?:^|[^A-Za-z0-9_])@${login}(?![A-Za-z0-9_\\[\\]-])`, "i").test(text)
      const inspect = (sessionId: string) =>
        sql<FeedbackRow>`SELECT * FROM github_feedback WHERE session_id=${sessionId} ORDER BY contribution_key`.pipe(
          feedbackError,
        )
      const record = (deliveryId: string, name: string, body: unknown) =>
        Effect.gen(function* () {
          if (
            !["pull_request_review", "pull_request_review_comment", "issue_comment"].includes(name)
          )
            return
          const decoded = Schema.decodeUnknownOption(Envelope)(body)
          if (decoded._tag === "None") return
          const event = decoded.value
          const review = name === "pull_request_review" ? event.review : undefined
          const comment = name !== "pull_request_review" ? event.comment : undefined
          if (review ? event.action !== "submitted" : event.action !== "created") return
          const item = review ?? comment
          if (!item || item.user.type !== "User") return
          const number =
            event.pull_request?.number ??
            (event.issue?.pull_request !== undefined ? event.issue.number : undefined)
          if (number === undefined) return
          const reviewId = review?.id ?? comment?.pull_request_review_id ?? null
          const unclassified = name === "pull_request_review_comment" && reviewId === null
          const key = unclassified
            ? `github:unclassified:${item.id}`
            : reviewId === null
              ? `github:comment:${item.id}`
              : `github:review:${reviewId}`
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [home] = yield* sql<{
                session_id: string
              }>`SELECT t.session_id FROM slack_thread t JOIN agent_session s USING(session_id) WHERE t.repository_id=${event.repository.id} AND t.pr_number=${String(number)} AND t.state='ready' AND s.runner_state<>'disconnected' FOR SHARE OF s`
              if (!home) return
              const receipt =
                yield* sql`INSERT INTO github_feedback_receipt VALUES (${deliveryId},${home.session_id}) ON CONFLICT DO NOTHING RETURNING delivery_id`
              if (receipt.length === 0) return
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([home.session_id, key])},2))`
              const [existing] =
                yield* sql<FeedbackRow>`SELECT * FROM github_feedback WHERE session_id=${home.session_id} AND contribution_key=${key}`
              if (!existing) {
                const authority = yield* teammates.authorize({
                  platform: "github",
                  workspaceId: GITHUB_WORKSPACE_ID,
                  accountId: item.user.id,
                })
                const authorized =
                  authority._tag === "Authorized" &&
                  (name !== "issue_comment" || mentioned(comment!.body))
                const author =
                  authority._tag === "Authorized"
                    ? { teammateId: authority.teammateId, displayName: authority.displayName }
                    : {}
                yield* sql`INSERT INTO github_feedback (session_id,contribution_key,review_id,reviewer_id,author,authorized,body,submitted,inline_target,warning)
            VALUES (${home.session_id},${key},${reviewId},${item.user.id},${JSON.stringify(author)}::jsonb,${authorized},${review ? (review.body ?? "") : reviewId === null ? comment!.body : null},${review ? review.submitted_at !== null : name === "issue_comment"},${comment && name !== "issue_comment" ? (comment.in_reply_to_id ?? comment.id) : null},'Review membership is pending')`
              } else if (
                review &&
                existing.reviewer_id === review.user.id &&
                existing.state === "pending"
              ) {
                yield* sql`UPDATE github_feedback SET body=COALESCE(body,${review.body ?? ""}),submitted=submitted OR ${review.submitted_at !== null},due_at=CLOCK_TIMESTAMP() WHERE session_id=${home.session_id} AND contribution_key=${key}`
              }
              if (
                comment &&
                reviewId !== null &&
                (!existing || existing.reviewer_id === comment.user.id)
              )
                yield* sql`INSERT INTO github_feedback_comment VALUES (${home.session_id},${key},${comment.id},${comment.body},${comment.in_reply_to_id ?? comment.id}) ON CONFLICT DO NOTHING`
            }),
          )
        }).pipe(feedbackError)
      const hydrate = (row: FeedbackRow) =>
        Effect.gen(function* () {
          if (row.review_id === null && !row.submitted)
            return yield* new FeedbackError({
              message: "Inline feedback has not been classified into a submitted review",
            })
          let captured = row
          if (row.review_id !== null && (!row.submitted || row.body === null)) {
            const review = yield* api
              .review(row.session_id, row.review_id)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(FeedbackReview)))
            if (
              review.id !== row.review_id ||
              review.user.id !== row.reviewer_id ||
              review.user.type !== "User" ||
              !review.submitted_at ||
              review.state.toLowerCase() === "pending"
            )
              return yield* new FeedbackError({
                message: "Review is pending or its membership cannot be classified",
              })
            yield* sql`UPDATE github_feedback SET body=COALESCE(body,${review.body ?? ""}),submitted=true WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key} AND state='pending'`
            captured = { ...row, body: row.body ?? review.body ?? "", submitted: true }
          }
          const page =
            row.review_id === null
              ? { comments: [], next: "" }
              : yield* api.comments(row.session_id, row.review_id, row.cursor)
          if (page.next !== "" && page.next === row.cursor)
            return yield* new FeedbackError({ message: "GitHub review pagination did not advance" })
          const comments = yield* Schema.decodeUnknownEffect(Schema.Array(FeedbackComment))(
            page.comments,
          )
          if (
            comments.some(
              (comment) =>
                comment.pull_request_review_id !== row.review_id ||
                comment.user.id !== row.reviewer_id ||
                comment.user.type !== "User",
            )
          )
            return yield* new FeedbackError({ message: "Review membership could not be verified" })
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [current] =
                yield* sql<FeedbackRow>`SELECT * FROM github_feedback WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key} FOR UPDATE`
              if (!current || current.state !== "pending" || current.cursor !== row.cursor) return
              for (const comment of comments)
                yield* sql`INSERT INTO github_feedback_comment VALUES (${row.session_id},${row.contribution_key},${comment.id},${comment.body},${comment.in_reply_to_id ?? comment.id}) ON CONFLICT DO NOTHING`
              if (page.next !== "") {
                yield* sql`UPDATE github_feedback SET cursor=${page.next},warning='Review membership is pending' WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key}`
                return
              }
              const members = yield* sql<{
                comment_id: string
                body: string
                reply_target: string
              }>`SELECT comment_id,body,reply_target FROM github_feedback_comment WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key} ORDER BY length(comment_id),comment_id`
              const text = [
                current.body ?? captured.body ?? "",
                ...members.map(
                  (comment) => `Inline comment ${comment.comment_id}:\n${comment.body}`,
                ),
              ]
                .filter(Boolean)
                .join("\n\n")
              const state =
                text.trim() === "" ? "empty" : current.authorized ? "accepted" : "context"
              if (state === "accepted")
                yield* sessions.accept({
                  sessionId: row.session_id,
                  contributionKey: row.contribution_key,
                  source: "github",
                  author: row.author,
                  text: `Address this GitHub feedback on the associated PR branch. Reply on GitHub.\n\n${text}`,
                })
              yield* sql`UPDATE github_feedback SET state=${state},inline_target=${(current.body ?? captured.body ?? "").trim() === "" && members.length === 1 ? members[0]!.reply_target : null},warning=NULL WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key}`
            }),
          )
        }).pipe(feedbackError)
      const processDue = Effect.gen(function* () {
        const rows =
          yield* sql<FeedbackRow>`SELECT f.* FROM github_feedback f JOIN agent_session s USING(session_id) WHERE f.state='pending' AND f.due_at<=CLOCK_TIMESTAMP() AND s.runner_state<>'disconnected' ORDER BY f.due_at LIMIT 50`
        for (const row of rows)
          yield* hydrate(row).pipe(
            Effect.catch(
              (error) =>
                sql`UPDATE github_feedback SET warning=${error.message},due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${error.retryAfter ?? 30}) WHERE session_id=${row.session_id} AND contribution_key=${row.contribution_key}`,
            ),
          )
      }).pipe(feedbackError)
      return { record, processDue, inspect }
    }),
  )
}
