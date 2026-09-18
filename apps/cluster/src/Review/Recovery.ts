import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { isTerminalReviewStatus } from "@janitor/domain/Review/Run"
import { ReviewAgentClient } from "./Agent.ts"
import { ReviewAction } from "./Investigation.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { IssueReviewStore } from "./Store.ts"

/** Accepted workflow deliveries can lose their runner before recording a result. */
export const recoverReviewRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const agents = yield* ReviewAgentClient
  const scheduler = yield* IssueReviewScheduler
  const store = yield* IssueReviewStore
  const minute = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 60_000)
  const runs = yield* sql<{
    run_id: string
    repository_id: string
    issue_number: number
    status: string
  }>`
    SELECT run_id, repository_id, issue_number, status FROM issue_review_run
    WHERE status IN ('queued', 'running') OR saved_publication->>'status' = 'pending'
    ORDER BY accepted_at, run_id`
  yield* Effect.forEach(
    runs,
    (run) =>
      Effect.gen(function* () {
        if (run.status === "queued") {
          yield* scheduler.advance(run.repository_id, run.issue_number)
          return
        }
        // A fresh recovery message checks deadlines and applies a saved completion.
        // Retries within this cron minute retain the same identity.
        yield* agents.start(run.run_id, `recover:${run.run_id}:${minute}`)
        const current = yield* store.run(run.run_id)
        if (
          Option.isNone(current) ||
          (isTerminalReviewStatus(current.value.status) &&
            current.value.savedPublication?.status !== "pending")
        )
          return
        const latest = (yield* store.actions(run.run_id)).at(-1)
        if (latest?.status !== "pending") return
        // Reuse the workflow identity: a live attempt is not duplicated, and
        // persisted activities are replayed without repeating completed work.
        yield* ReviewAction.execute(
          { runId: run.run_id, sequence: latest.sequence },
          { discard: true },
        )
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("Review recovery failed", cause).pipe(
            Effect.annotateLogs({ runId: run.run_id }),
          ),
        ),
      ),
    { concurrency: 4, discard: true },
  )
})
