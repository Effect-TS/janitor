import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowDispatcher } from "./WorkflowDispatcher.ts"

export const WorkflowOutboxCronName = "workflow-outbox-dispatch"

/** Woken by the Cron Trigger to recover due outbox rows that immediate dispatch missed. */
export const WorkflowOutboxCronLayer = Singleton.make(
  WorkflowOutboxCronName,
  Effect.gen(function* () {
    const dispatcher = yield* WorkflowDispatcher
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM labeling_rule_test WHERE expires_at<CLOCK_TIMESTAMP()`
    yield* sql`DELETE FROM labeling_ai_claim WHERE expires_at<CLOCK_TIMESTAMP()`
    for (let pass = 0; pass < 3; pass++) {
      const summary = yield* dispatcher.dispatchDue({ limit: 100 })
      yield* Effect.logInfo("Dispatched due workflow outbox rows").pipe(
        Effect.annotateLogs({ ...summary }),
      )
      // Service the five-second debounce in this background wake, never in a UI request.
      const [next] = yield* sql<{
        delay: number | null
      }>`SELECT GREATEST(0,EXTRACT(EPOCH FROM (MIN(due_at)-CLOCK_TIMESTAMP()))*1000)::int AS delay
        FROM workflow_outbox WHERE accepted_at IS NULL AND (lease_until IS NULL OR lease_until<=CLOCK_TIMESTAMP())
        AND due_at<=CLOCK_TIMESTAMP()+INTERVAL '5 seconds' HAVING COUNT(*)>0`
      if (next?.delay == null) break
      yield* Effect.sleep(next.delay)
    }
  }).pipe(
    Effect.catchCause(
      Effect.fnUntraced(function* (cause) {
        yield* Effect.logError("Workflow outbox dispatch failed", cause)
      }),
    ),
  ),
)
