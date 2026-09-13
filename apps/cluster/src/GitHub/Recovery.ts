import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { withRepositoryActivity } from "../RepositoryActivity.ts"
import { GitHubFeedback, FeedbackError, feedbackError } from "./Feedback.ts"
import { GitHubRecoveryApi, RecoveryError } from "./RecoveryHttp.ts"

export class GitHubRecovery extends Context.Service<
  GitHubRecovery,
  {
    readonly processDue: Effect.Effect<void, FeedbackError>
  }
>()("GitHub/Recovery") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const api = yield* GitHubRecoveryApi
      const feedback = yield* GitHubFeedback
      const processDue = Effect.gen(function* () {
        const token = yield* Effect.sync(() => crypto.randomUUID())
        const [scan] = yield* sql<{
          cursor: string
        }>`UPDATE platform_recovery SET lease_token=${token},lease_until=CLOCK_TIMESTAMP()+interval '60 seconds' WHERE scan_id='github' AND due_at<=CLOCK_TIMESTAMP() AND (lease_until IS NULL OR lease_until<CLOCK_TIMESTAMP()) RETURNING cursor`
        if (!scan) return
        const ownsScan = Effect.gen(function* () {
          const rows =
            yield* sql`SELECT 1 FROM platform_recovery WHERE scan_id='github' AND lease_token=${token} FOR UPDATE`
          return rows.length > 0
        })
        yield* sql`UPDATE platform_recovery SET gap='Recovery was overdue beyond GitHub retained history; expired deliveries cannot be recovered' WHERE scan_id='github' AND completed_at<CLOCK_TIMESTAMP()-interval '3 days'`
        let delay = 1
        const result = yield* Effect.gen(function* () {
          yield* sql`UPDATE github_recovery_attempt a SET state='captured' WHERE state='pending' AND (
            EXISTS(SELECT 1 FROM github_feedback_receipt r WHERE r.delivery_id=a.delivery_guid)
            OR EXISTS(SELECT 1 FROM github_recovery_attempt captured WHERE captured.delivery_guid=a.delivery_guid AND captured.state='captured'))`
          // Drain retained summaries before advancing another page, one bounded request per lease.
          const [attempt] = yield* sql<{
            attempt_id: string
            delivery_guid: string
            event_name: string
            repository_id: string
            delivered_at: Date
          }>`SELECT * FROM github_recovery_attempt WHERE state='pending' ORDER BY delivered_at,attempt_id LIMIT 1`
          if (attempt) {
            const fetched = yield* api.payload(attempt.attempt_id).pipe(Effect.result)
            if (fetched._tag === "Failure") {
              if (!fetched.failure.unavailable) return yield* fetched.failure
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  if (!(yield* ownsScan)) return
                  yield* sql`UPDATE github_recovery_attempt SET state='unavailable',warning='Delivery payload expired or inaccessible; uncaptured content cannot be reconstructed' WHERE attempt_id=${attempt.attempt_id}`
                  yield* sql`UPDATE platform_recovery SET gap='At least one retained delivery payload expired or became inaccessible before capture' WHERE scan_id='github'`
                }),
              )
              return
            }
            const { delivery, payload, retryAfter } = fetched.success
            delay = Math.max(1, retryAfter)
            if (
              delivery.id !== attempt.attempt_id ||
              delivery.guid !== attempt.delivery_guid ||
              delivery.repository_id !== attempt.repository_id ||
              delivery.event !== attempt.event_name
            )
              return yield* new RecoveryError({
                message: "Delivery payload does not match its retained summary",
                retryAfter: 300,
                unavailable: false,
              })
            yield* sql.withTransaction(
              Effect.gen(function* () {
                if (!(yield* ownsScan)) return
                yield* sql`UPDATE platform_recovery SET due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}) WHERE scan_id='github'`
                yield* withRepositoryActivity(
                  sql,
                  attempt.repository_id,
                  feedback.record(attempt.delivery_guid, attempt.event_name, payload),
                  attempt.delivered_at,
                )
                yield* sql`UPDATE github_recovery_attempt SET state='captured',warning=NULL WHERE attempt_id=${attempt.attempt_id}`
              }),
            )
            return
          }
          const listed = yield* api.list(scan.cursor).pipe(Effect.result)
          if (listed._tag === "Failure") {
            if (!listed.failure.unavailable || scan.cursor === "") return yield* listed.failure
            delay = Math.max(300, listed.failure.retryAfter)
            yield* sql.withTransaction(
              Effect.gen(function* () {
                if (!(yield* ownsScan)) return
                yield* sql`UPDATE platform_recovery SET cursor='',gap='Saved delivery cursor is unavailable; restarting the retained window cannot recover expired history',due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}) WHERE scan_id='github'`
              }),
            )
            return
          }
          const page = listed.success
          delay = Math.max(page.cursor === "" ? 300 : 1, page.retryAfter)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (!(yield* ownsScan)) return
              yield* sql`UPDATE platform_recovery SET due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}) WHERE scan_id='github'`
              for (const summary of page.deliveries) {
                if (
                  !summary.repository_id ||
                  !(
                    (summary.event === "pull_request_review" && summary.action === "submitted") ||
                    (["pull_request_review_comment", "issue_comment"].includes(summary.event) &&
                      summary.action === "created")
                  )
                )
                  continue
                yield* sql`INSERT INTO github_recovery_attempt (attempt_id,delivery_guid,event_name,repository_id,delivered_at,state)
              SELECT ${summary.id},${summary.guid},${summary.event},${summary.repository_id},${summary.delivered_at}::timestamptz,
                CASE WHEN EXISTS(SELECT 1 FROM github_feedback_receipt WHERE delivery_id=${summary.guid})
                  OR EXISTS(SELECT 1 FROM github_recovery_attempt WHERE delivery_guid=${summary.guid} AND state='captured') THEN 'captured' ELSE 'pending' END
              WHERE EXISTS (SELECT 1 FROM slack_thread WHERE repository_id=${summary.repository_id} AND state='ready' AND pr_number IS NOT NULL)
              ON CONFLICT DO NOTHING`
              }
              yield* sql`UPDATE platform_recovery SET cursor=${page.cursor},completed_at=CASE WHEN ${page.cursor}='' THEN CLOCK_TIMESTAMP() ELSE completed_at END WHERE scan_id='github'`
              // Payload work must start even when this was the final listing page.
              const pending =
                yield* sql`SELECT 1 FROM github_recovery_attempt WHERE state='pending' LIMIT 1`
              if (pending.length > 0) delay = Math.max(1, page.retryAfter)
            }),
          )
        }).pipe(Effect.result)
        if (result._tag === "Success" && scan.cursor === "") {
          const pending =
            yield* sql`SELECT 1 FROM github_recovery_attempt WHERE state='pending' LIMIT 1`
          const [current] = yield* sql<{
            cursor: string
          }>`SELECT cursor FROM platform_recovery WHERE scan_id='github'`
          if (pending.length === 0 && current?.cursor === "") delay = Math.max(delay, 300)
        }
        const warning = result._tag === "Failure" ? result.failure.message : null
        if (result._tag === "Failure")
          delay = result.failure instanceof RecoveryError ? result.failure.retryAfter : 30
        yield* sql`UPDATE platform_recovery SET warning=${warning},due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}),lease_until=NULL,lease_token=NULL WHERE scan_id='github' AND lease_token=${token}`
      }).pipe(feedbackError)
      return { processDue }
    }),
  )
}
