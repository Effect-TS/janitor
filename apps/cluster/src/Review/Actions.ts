import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"

/**
 * The identity of a run's actions (ADR 0012). The agent schedules an action
 * by inserting its row and this outbox request in one transaction; the
 * action workflow is keyed the same way, so a redelivered request executes
 * nothing twice.
 */

export const REVIEW_ACTION_TAG = "Janitor/ReviewActionV1"

export const ReviewActionPayload = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Int,
})
export type ReviewActionPayload = typeof ReviewActionPayload.Type

export const reviewActionKey = ({ runId, sequence }: ReviewActionPayload) =>
  `review-action:${runId}:${sequence}`

/** Why a run ended without a conclusion, in the words the frontend shows. */
export const limitations = {
  deadline: "The 15-minute allowance ended before the review concluded.",
  workspaceLost:
    "The sandbox workspace was lost before the investigation finished. Post a new invocation.",
  noModel: "No agent model is configured for this deployment.",
  idle: "The model ended three actions in a row without investigating or recording a review.",
  provider: "The model provider failed.",
} as const

export const actionMessageId = ({ runId, sequence }: ReviewActionPayload) =>
  `action:${runId}:${sequence}`

/**
 * Starts a scheduled action as soon as its transaction committed, so a run
 * does not wait for the outbox cron between its steps. Failure only delays
 * the action: the cron dispatches it later.
 */
export class ReviewActionDispatch extends Context.Service<
  ReviewActionDispatch,
  { readonly dispatch: (payload: ReviewActionPayload) => Effect.Effect<void> }
>()("@janitor/cluster/Review/ReviewActionDispatch") {
  static readonly layer: Layer.Layer<ReviewActionDispatch, never, WorkflowDispatcher> =
    Layer.effect(
      this,
      Effect.map(WorkflowDispatcher, (dispatcher) => ({
        dispatch: (payload) =>
          dispatcher
            .dispatchDue({
              limit: 1,
              only: { workflowTag: REVIEW_ACTION_TAG, executionKey: reviewActionKey(payload) },
            })
            .pipe(
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logWarning("Review action dispatch deferred to the cron", cause).pipe(
                  Effect.annotateLogs(payload),
                ),
              ),
            ),
      })),
    )
}
