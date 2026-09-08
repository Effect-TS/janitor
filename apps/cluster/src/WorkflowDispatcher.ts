import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Exit from "effect/Exit"
import type * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import { WorkflowOutbox, type WorkflowOutboxError } from "./WorkflowOutbox.ts"

/**
 * Binds an outbox workflow tag to the code that submits its execution. The
 * only expected failure is a payload that no longer decodes; engine problems
 * surface as defects and are treated as transient by the dispatcher.
 */
export interface WorkflowRegistration {
  readonly tag: string
  readonly submit: (
    payload: unknown,
  ) => Effect.Effect<void, Schema.SchemaError, WorkflowEngine.WorkflowEngine>
}

export interface DispatchSummary {
  readonly claimed: number
  readonly accepted: number
  readonly released: number
}

export interface DispatchOptions {
  readonly limit?: number | undefined
  readonly only?: { readonly workflowTag: string; readonly executionKey: string } | undefined
}

const LEASE_DURATION = Duration.seconds(60)
const UNKNOWN_TAG_RETRY = Duration.hours(1)
const MAX_BACKOFF = Duration.minutes(5)

const backoff = (attempts: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 ** Math.min(attempts, 8)), MAX_BACKOFF)

/**
 * Claims due outbox rows and submits their workflows. Every producer path
 * calls `dispatch` after its transaction commits; the cron singleton calls
 * `dispatchDue` to recover rows those attempts missed.
 */
export class WorkflowDispatcher extends Context.Service<
  WorkflowDispatcher,
  {
    readonly dispatchDue: (
      options?: DispatchOptions,
    ) => Effect.Effect<DispatchSummary, WorkflowOutboxError>
  }
>()("@janitor/cluster/WorkflowDispatcher/WorkflowDispatcher") {
  static readonly layer = (registrations: ReadonlyArray<WorkflowRegistration>) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const outbox = yield* WorkflowOutbox
        const engine = yield* WorkflowEngine.WorkflowEngine
        const byTag = new Map(registrations.map((registration) => [registration.tag, registration]))

        const dispatchDue = Effect.fn("WorkflowDispatcher.dispatchDue")(function* (
          options?: DispatchOptions,
        ) {
          let claimed = 0
          let accepted = 0
          let released = 0
          const limit = Math.max(0, options?.limit ?? 100)
          while (claimed < limit) {
            // Lease tokens must be unique across concurrently active isolates, so
            // this uses platform randomness rather than the Effect-injected PRNG.
            // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
            const leaseToken = crypto.randomUUID()
            const rows = yield* outbox.claimDue({
              leaseToken,
              leaseDuration: LEASE_DURATION,
              limit: Math.min(4, limit - claimed),
              only: options?.only,
            })

            if (rows.length === 0) break
            claimed += rows.length
            yield* Effect.forEach(
              rows,
              (row) =>
                Effect.gen(function* () {
                  const reference = {
                    workflowTag: row.workflow_tag,
                    executionKey: row.execution_key,
                    leaseToken,
                  }
                  const registration = byTag.get(row.workflow_tag)
                  if (registration === undefined) {
                    yield* Effect.logError("No workflow registered for outbox row").pipe(
                      Effect.annotateLogs({ tag: row.workflow_tag, key: row.execution_key }),
                    )
                    if (yield* outbox.release(reference, UNKNOWN_TAG_RETRY)) released++
                    return
                  }

                  const submitted = yield* registration
                    .submit(row.payload)
                    .pipe(
                      Effect.timeout("20 seconds"),
                      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
                      Effect.exit,
                    )
                  if (Exit.isSuccess(submitted)) {
                    if (yield* outbox.markAccepted(reference)) accepted++
                    return
                  }
                  yield* Effect.logError("Workflow submission failed", submitted.cause).pipe(
                    Effect.annotateLogs({
                      tag: row.workflow_tag,
                      key: row.execution_key,
                      attempts: row.attempts,
                    }),
                  )
                  if (yield* outbox.release(reference, backoff(row.attempts))) released++
                }).pipe(
                  Effect.timeout("30 seconds"),
                  // Leave an unacknowledged lease to expire. Other rows can still dispatch.
                  Effect.catchCause((cause) =>
                    Effect.logError("Outbox row dispatch failed", cause),
                  ),
                ),
              { concurrency: 4, discard: true },
            )
          }

          return { claimed, accepted, released }
        })

        return { dispatchDue }
      }),
    )
}
