import { isTerminalReviewStatus } from "@janitor/domain/Review/Run"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { ReviewAgentClient, type RunSnapshot } from "./Agent.ts"
import {
  type Cancellation,
  type CancelSelection,
  IssueReviewStore,
  type IssueReviewError,
  type RunRecord,
} from "./Store.ts"

/**
 * The per-issue scheduler (ADR 0012): one active run per issue, later
 * invocations wait in acceptance order, and different issues advance
 * independently. It decides which run to start and tells that run's agent;
 * it never executes review work itself. There is no repository-wide queue
 * or concurrency cap.
 */

export class IssueReviewScheduler extends Context.Service<
  IssueReviewScheduler,
  {
    /** Starts the issue's next run when it has no active run. Idempotent. */
    readonly advance: (
      repositoryId: string,
      issueNumber: number,
    ) => Effect.Effect<Option.Option<RunSnapshot>, IssueReviewError>
    /** A run reached a terminal state; the issue may start its next run. */
    readonly release: (
      repositoryId: string,
      issueNumber: number,
    ) => Effect.Effect<void, IssueReviewError>
    /**
     * Cancels every live run the selection covers. The cancellation is
     * persisted first, in the caller's transaction when there is one, so it
     * holds whether or not the agent can be reached; the agent is then told
     * so it stops, and each affected issue may start its next run.
     */
    readonly cancel: (
      selection: CancelSelection,
      cancellation: Cancellation,
    ) => Effect.Effect<ReadonlyArray<RunSnapshot>, IssueReviewError>
  }
>()("@janitor/cluster/Review/IssueReviewScheduler", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const agents = yield* ReviewAgentClient

    /** Picks the run to start under the issue's scheduling record. */
    const choose = (repositoryId: string, issueNumber: number) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { activeRunId } = yield* store.lockIssue(repositoryId, issueNumber)
            if (activeRunId !== null) {
              const active = yield* store.run(activeRunId)
              if (Option.isSome(active) && !isTerminalReviewStatus(active.value.status))
                // A start that was lost in delivery is sent again; the agent applies it once.
                return active.value.status === "queued" ? active : Option.none<RunRecord>()
            }
            const next = yield* store.nextQueued(repositoryId, issueNumber)
            yield* store.setActiveRun(
              repositoryId,
              issueNumber,
              Option.isSome(next) ? next.value.runId : null,
            )
            return next
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)))

    const advance = Effect.fn("IssueReviewScheduler.advance")(function* (
      repositoryId: string,
      issueNumber: number,
    ) {
      const next = yield* choose(repositoryId, issueNumber)
      if (Option.isNone(next)) return Option.none<RunSnapshot>()
      // Delivery may fail in any way; the next advance sends the start again.
      const started = yield* agents.start(next.value.runId, `start:${next.value.runId}`).pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) =>
          Effect.logWarning("Review run start was not delivered", cause).pipe(
            Effect.annotateLogs({ runId: next.value.runId }),
            Effect.as(Option.none<RunSnapshot>()),
          ),
        ),
      )
      yield* Effect.logInfo("Advanced issue review queue").pipe(
        Effect.annotateLogs({
          repositoryId,
          issueNumber,
          runId: next.value.runId,
          delivered: Option.isSome(started),
        }),
      )
      return started
    })

    const cancel = Effect.fn("IssueReviewScheduler.cancel")(function* (
      selection: CancelSelection,
      cancellation: Cancellation,
    ) {
      const cancelled = yield* store.cancelRuns(selection, cancellation)
      for (const run of cancelled) {
        // Best effort: the record already says cancelled; the agent learns
        // it from this message or from the record before its next action.
        yield* agents
          .cancel(run.runId, {
            ...cancellation,
            messageId: `${cancellation.messageId}:${run.runId}`,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("Review run cancellation was not delivered", cause).pipe(
                Effect.annotateLogs({ runId: run.runId }),
              ),
            ),
          )
      }
      for (const issueNumber of new Set(cancelled.map((run) => run.issueNumber)))
        yield* advance(selection.repositoryId, issueNumber)
      return cancelled.map((run): RunSnapshot => ({
        runId: run.runId,
        status: run.status,
        cancelReason: run.cancelReason,
      }))
    })

    return {
      advance,
      release: (repositoryId, issueNumber) => Effect.asVoid(advance(repositoryId, issueNumber)),
      cancel,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
