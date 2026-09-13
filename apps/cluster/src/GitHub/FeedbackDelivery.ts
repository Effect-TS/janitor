import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { feedbackError, type FeedbackError } from "./Feedback.ts"

export class GitHubCommentError extends Schema.TaggedError<GitHubCommentError>()(
  "GitHubCommentError",
  {
    message: Schema.String,
    disposition: Schema.Literals(["retry", "uncertain", "missing"]),
    retryAfter: Schema.Number,
  },
) {}
export class GitHubCommentApi extends Context.Service<
  GitHubCommentApi,
  {
    readonly post: (
      session: string,
      target: string | null,
      text: string,
      marker: string,
    ) => Effect.Effect<string, GitHubCommentError>
    readonly reconcile: (
      session: string,
      target: string | null,
      marker: string,
      cursor: string,
    ) => Effect.Effect<{ readonly id: string | null; readonly next: string }, GitHubCommentError>
  }
>()("GitHub/CommentApi") {}
export interface GitHubOutput {
  readonly output_id: string
  readonly session_id: string
  readonly inline_target: string | null
  readonly text: string
  readonly state: "pending" | "uncertain" | "sent" | "problem"
  readonly platform_id: string | null
  readonly cursor: string
  readonly error: string | null
}
export class GitHubDelivery extends Context.Service<
  GitHubDelivery,
  {
    readonly deliver: (sessionId: string) => Effect.Effect<void, FeedbackError>
    readonly inspect: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<GitHubOutput>, FeedbackError>
    readonly processDue: Effect.Effect<void, FeedbackError>
  }
>()("GitHub/Delivery") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const api = yield* GitHubCommentApi
      const inspect = (sessionId: string) =>
        sql<GitHubOutput>`SELECT * FROM github_feedback_output WHERE session_id=${sessionId} ORDER BY sequence`.pipe(
          feedbackError,
        )
      const deliver = (sessionId: string) =>
        Effect.gen(function* () {
          const output = yield* sql.withTransaction(
            Effect.gen(function* () {
              // Serialize sends across workers. Uncertainty survives lease expiry.
              const [row] = yield* sql<
                GitHubOutput & { available: boolean }
              >`SELECT o.*, (o.due_at<=CLOCK_TIMESTAMP() AND (o.lease_until IS NULL OR o.lease_until<=CLOCK_TIMESTAMP())) AS available FROM github_feedback_output o JOIN agent_session s USING(session_id) WHERE o.session_id=${sessionId} AND o.state<>'sent' AND s.runner_state<>'disconnected' ORDER BY o.sequence LIMIT 1 FOR UPDATE OF o`
              if (!row || !row.available || row.state === "problem") return null
              yield* sql`UPDATE github_feedback_output SET state='uncertain',lease_until=CLOCK_TIMESTAMP()+interval '60 seconds' WHERE output_id=${row.output_id}`
              return row
            }),
          )
          if (!output) return
          const result = yield* (
            output.state === "uncertain"
              ? api.reconcile(sessionId, output.inline_target, output.output_id, output.cursor)
              : api
                  .post(sessionId, output.inline_target, output.text, output.output_id)
                  .pipe(Effect.map((id) => ({ id, next: "" })))
          ).pipe(Effect.result)
          if (result._tag === "Success") {
            const { id, next } = result.success
            yield* sql`UPDATE github_feedback_output SET state=${id === null ? "uncertain" : "sent"},platform_id=${id},cursor=${next},error=${id === null ? "Publication uncertain; waiting for a positive App, destination and marker match" : null},lease_until=NULL,due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${id === null && next === "" ? 300 : 0}) WHERE output_id=${output.output_id}`
          } else {
            const error = result.failure
            yield* sql`UPDATE github_feedback_output SET state=${output.state === "uncertain" ? "uncertain" : error.disposition === "missing" ? "problem" : error.disposition === "uncertain" ? "uncertain" : "pending"},error=${error.message},lease_until=NULL,due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${error.retryAfter}) WHERE output_id=${output.output_id}`
          }
        }).pipe(feedbackError)
      const processDue = Effect.gen(function* () {
        const rows = yield* sql<{
          session_id: string
        }>`SELECT DISTINCT session_id FROM github_feedback_output WHERE state IN ('pending','uncertain') AND due_at<=CLOCK_TIMESTAMP() LIMIT 50`
        for (const row of rows) yield* deliver(row.session_id)
      }).pipe(feedbackError)
      return { inspect, deliver, processDue }
    }),
  )
}
