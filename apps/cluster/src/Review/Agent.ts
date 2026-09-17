import { ReviewRunId, ReviewRunStatus, isTerminalReviewStatus } from "@janitor/domain/Review/Run"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as ClusterSchema from "effect/unstable/cluster/ClusterSchema"
import * as Entity from "effect/unstable/cluster/Entity"
import type { Sharding } from "effect/unstable/cluster/Sharding"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { changedReason, RepositoryEligibility } from "../RepositoryEligibility.ts"
import { flushLive } from "../LiveUpdates.ts"
import { disabledReason, IssueReviewAvailable, unavailableReason } from "./Gate.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { type Cancellation, IssueReviewStore, type RunRecord } from "./Store.ts"

/**
 * The review agent (ADR 0012): one persistent cluster Entity per review run,
 * addressed by the run ID. It receives messages, owns the run's lifecycle
 * and persists its state explicitly in the run record; every message is
 * recorded by the identity its sender chose, so a redelivery is applied
 * once. Later tickets add the investigation as embedded action workflows;
 * this slice owns admission into execution and cancellation.
 */

/** Installation, investigation and testing share this single allowance. */
export const EXECUTION_ALLOWANCE = Duration.minutes(15)

export const RunSnapshot = Schema.Struct({
  runId: ReviewRunId,
  status: ReviewRunStatus,
  cancelReason: Schema.NullOr(Schema.String),
})
export type RunSnapshot = typeof RunSnapshot.Type

export class ReviewRunMissing extends Schema.TaggedError<ReviewRunMissing>()(
  "@janitor/cluster/Review/ReviewRunMissing",
  { runId: Schema.String },
) {}

export const ReviewAgent = Entity.make("ReviewAgent", [
  /** The scheduler made this run the issue's active run. */
  Rpc.make("Start", {
    payload: { messageId: Schema.String },
    primaryKey: ({ messageId }) => messageId,
    success: RunSnapshot,
    error: ReviewRunMissing,
  }),
  /** Stop the run wherever it is; a cancelled run never resumes. */
  Rpc.make("Cancel", {
    payload: {
      messageId: Schema.String,
      reason: Schema.String,
      actor: Schema.NullOr(Schema.String),
    },
    primaryKey: ({ messageId }) => messageId,
    success: RunSnapshot,
    error: ReviewRunMissing,
  }),
]).annotateRpcs(ClusterSchema.Persisted, true)

const snapshot = (run: RunRecord): RunSnapshot => ({
  runId: run.runId,
  status: run.status,
  cancelReason: run.cancelReason,
})

/**
 * How the rest of the application reaches a run's agent. Production sends
 * through the cluster; tests substitute the in-memory entity client.
 */
export class ReviewAgentClient extends Context.Service<
  ReviewAgentClient,
  {
    readonly start: (runId: string, messageId: string) => Effect.Effect<RunSnapshot, unknown>
    readonly cancel: (runId: string, message: Cancellation) => Effect.Effect<RunSnapshot, unknown>
  }
>()("@janitor/cluster/Review/ReviewAgentClient") {
  static readonly layer: Layer.Layer<ReviewAgentClient, never, Sharding> = Layer.effect(
    this,
    Effect.map(ReviewAgent.client, (client) => ({
      start: (runId, messageId) => client(runId).Start({ messageId }),
      cancel: (runId, message) => client(runId).Cancel(message),
    })),
  )
}

export const ReviewAgentLayer = ReviewAgent.toLayer(
  Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress
    const runId = address.entityId
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const scheduler = yield* IssueReviewScheduler
    const available = yield* IssueReviewAvailable

    const missing = new ReviewRunMissing({ runId })
    const orDie = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
      Effect.orDie(effect)

    /**
     * Loads and holds the run, records the message once, and applies the
     * transition only for a first delivery of a live run. Returns the run
     * after the transition and whether the caller must release the issue.
     */
    const receive = <P>(
      message: { readonly messageId: string; readonly kind: string; readonly payload: P },
      apply: (run: RunRecord) => Effect.Effect<RunRecord, never, never>,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* store.lockRun(runId)
            if (Option.isNone(current)) return yield* missing
            const run = current.value
            const live = !isTerminalReviewStatus(run.status)
            const fresh = yield* store.recordMessage({
              runId,
              messageId: message.messageId,
              kind: message.kind,
              payload: message.payload,
              applied: live,
            })
            if (!fresh || !live) return { run, released: false }
            const applied = yield* apply(run)
            return { run: applied, released: isTerminalReviewStatus(applied.status) }
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
          Effect.catchTag("@janitor/cluster/Review/IssueReviewError", (error) => Effect.die(error)),
        )

    const cancelled = (run: RunRecord, reason: string, actor: string | null) =>
      Effect.gen(function* () {
        const now = DateTime.toDateUtc(yield* DateTime.now)
        return yield* orDie(
          store.transition(run.runId, {
            status: "cancelled",
            finishedAt: now,
            cancelReason: reason,
            cancelledBy: actor ?? undefined,
            agentState: { phase: "cancelled" },
          }),
        )
      })

    const finish = (result: { readonly run: RunRecord; readonly released: boolean }) =>
      Effect.gen(function* () {
        if (result.released) {
          yield* orDie(scheduler.release(result.run.repositoryId, result.run.issueNumber))
          yield* flushLive
        }
        return snapshot(result.run)
      })

    return {
      Start: (envelope) =>
        receive(
          { messageId: envelope.payload.messageId, kind: "Start", payload: envelope.payload },
          (run) =>
            Effect.gen(function* () {
              if (run.status !== "queued") return run
              // Fresh repository eligibility before execution: the generation
              // the invocation was accepted under must still be current.
              const repository = yield* eligibility.get(run.repositoryId).pipe(Effect.result)
              if (repository._tag === "Failure") {
                if (
                  repository.failure._tag !==
                  "@janitor/cluster/RepositoryEligibility/RepositoryBlocked"
                )
                  return yield* Effect.die(repository.failure)
                return yield* cancelled(run, repository.failure.reason, null)
              }
              if (repository.success.generation !== run.eligibilityGeneration)
                return yield* cancelled(run, changedReason, null)
              // Review may have been switched off since admission.
              if (!available) return yield* cancelled(run, unavailableReason, null)
              const settings = yield* orDie(store.settings(run.repositoryId))
              if (!Option.exists(settings, (setting) => setting.enabled))
                return yield* cancelled(run, disabledReason, null)
              const now = yield* DateTime.now
              return yield* orDie(
                store.transition(run.runId, {
                  status: "running",
                  startedAt: DateTime.toDateUtc(now),
                  deadlineAt: DateTime.toDateUtc(DateTime.addDuration(now, EXECUTION_ALLOWANCE)),
                  agentState: { phase: "started" },
                }),
              )
            }),
        ).pipe(Effect.flatMap(finish)),
      Cancel: (envelope) =>
        receive(
          { messageId: envelope.payload.messageId, kind: "Cancel", payload: envelope.payload },
          (run) => cancelled(run, envelope.payload.reason, envelope.payload.actor),
        ).pipe(Effect.flatMap(finish)),
    }
  }),
  // A cancellation must be processed while an earlier message is pending.
  { concurrency: "unbounded" },
)
