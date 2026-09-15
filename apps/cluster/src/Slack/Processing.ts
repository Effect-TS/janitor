import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type WorkflowRegistration } from "../WorkflowDispatcher.ts"
import { SlackProcessor } from "./Processor.ts"
import { SlackError, slackError } from "./Conversation.ts"
import { SLACK_PROCESSING_TAG } from "./ProcessingRequest.ts"

const Payload = Schema.Struct({ sessionId: Schema.String, revision: Schema.String })
export const SlackProcessing = Workflow.make(SLACK_PROCESSING_TAG, {
  payload: Payload,
  success: Schema.Void,
  error: SlackError,
  idempotencyKey: ({ sessionId, revision }) => `${sessionId}:${revision}`,
})

export const SlackProcessingLayer = SlackProcessing.toLayer(
  Effect.fnUntraced(function* ({ sessionId }) {
    const processor = yield* SlackProcessor
    const sql = yield* SqlClient.SqlClient
    for (let pass = 0; pass < 100; pass++) {
      const delay = yield* Activity.make({
        name: `SlackProcessing/pass-${pass}`,
        success: Schema.NullOr(Schema.Number),
        error: SlackError,
        execute: Effect.gen(function* () {
          yield* processor.process(sessionId)
          const [row] = yield* sql<{
            delay: number | null
          }>`SELECT CASE WHEN due_at='infinity'::timestamptz THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (GREATEST(due_at,COALESCE(LEAST(lease_until,CLOCK_TIMESTAMP()+interval '1 second'),due_at),COALESCE(retry_not_before,due_at))-CLOCK_TIMESTAMP())))::float8 END AS delay FROM slack_thread WHERE session_id=${sessionId} AND state<>'redirected'`
          return row?.delay ?? null
        }).pipe(slackError),
      })
      if (delay === null) return
      if (delay > 0)
        yield* DurableClock.sleep({ name: `SlackProcessing/retry-${pass}`, duration: delay * 1000 })
    }
    // The persisted due row survives this bounded execution and is recovered by the sweep.
  }),
)

export const SlackProcessingRegistration: WorkflowRegistration = {
  tag: SLACK_PROCESSING_TAG,
  submit: (payload) =>
    Schema.decodeUnknownEffect(Payload)(payload).pipe(
      Effect.flatMap((decoded) => SlackProcessing.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
