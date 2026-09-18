import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { ReviewWorkspaces } from "./Workspace.ts"

/** Delete detailed records first; failed container destruction stays queued for retry. */
export const expireReviewHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`SELECT expire_review_history()`
  const workspaces = yield* ReviewWorkspaces
  const pending = yield* sql<{
    run_id: string
  }>`SELECT run_id FROM issue_review_workspace_cleanup LIMIT 100`
  for (const { run_id: runId } of pending) {
    yield* workspaces.open(runId).release.pipe(
      Effect.andThen(sql`DELETE FROM issue_review_workspace_cleanup WHERE run_id = ${runId}`),
      Effect.catchCause((cause) =>
        Effect.logWarning("Expired review workspace cleanup failed", cause).pipe(
          Effect.annotateLogs({ runId }),
        ),
      ),
    )
  }
})

/** Recheck after remote validation, immediately before starting a GitHub mutation. */
export const reviewIsRetained = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ retained: boolean }>`SELECT EXISTS (
      SELECT 1 FROM issue_review_run WHERE run_id::text = ${runId}
        AND accepted_at > CLOCK_TIMESTAMP() - INTERVAL '14 days'
    ) AS retained`
    return row!.retained
  })
