import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import type { OutboxRequest } from "../WorkflowOutbox.ts"

export const SLACK_PROCESSING_TAG = "Janitor/SlackProcessingV1"
export const processingRequest = (sessionId: string, revision: string): OutboxRequest => ({
  workflowTag: SLACK_PROCESSING_TAG,
  executionKey: `${sessionId}:${revision}`,
  payload: { sessionId, revision },
})

/** Called after repository changes commit; unavailable dispatch is recovered from durable rows. */
export const resumeRepositorySessions = (repositoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const outbox = yield* WorkflowOutbox
    const requests = yield* sql.withTransaction(
      Effect.gen(function* () {
        const threads = yield* sql<{
          session_id: string
          input_revision: string
        }>`UPDATE slack_thread SET input_revision=input_revision+1,due_at=CLOCK_TIMESTAMP(),retry_count=0
      WHERE repository_id=${repositoryId} AND startup_phase='repository' AND state<>'redirected' AND repository_block_reason(repository_id) IS NULL RETURNING session_id,input_revision`
        const requests = threads.map((thread) =>
          processingRequest(thread.session_id, thread.input_revision),
        )
        for (const request of requests) yield* outbox.enqueue(request)
        return requests
      }),
    )
    const dispatcher = yield* Effect.serviceOption(WorkflowDispatcher)
    if (Option.isSome(dispatcher))
      for (const request of requests)
        yield* dispatcher.value.dispatchDue({ only: request, limit: 1 })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Slack repository resumption will be recovered", cause),
    ),
  )
