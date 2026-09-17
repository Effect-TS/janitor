import { isTerminalReviewStatus } from "@janitor/domain/Review/Run"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { ReviewAgentClient, type RunSnapshot } from "./Agent.ts"
import { IssueReviewStore, type IssueReviewError, type RunRecord } from "./Store.ts"

/**
 * The per-issue scheduler (ADR 0012): one active run per issue, later
 * invocations wait in acceptance order, and different issues advance
 * independently. It decides which run to start and tells that run's agent;
 * it never executes review work itself. There is no repository-wide queue
 * or concurrency cap.
 */

export interface CancelSelection {
  readonly repositoryId: string
  readonly issueNumber?: number | undefined
  readonly commentId?: string | undefined
  readonly runId?: string | undefined
}

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
     * Cancels every live run the selection covers by telling each agent.
     * `messageId` names the cancellation source so a repeated request is
     * applied once per run.
     */
    readonly cancel: (
      selection: CancelSelection,
      cancellation: {
        readonly messageId: string
        readonly reason: string
        readonly actor: string | null
      },
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
      const started = yield* agents.start(next.value.runId, `start:${next.value.runId}`).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Review run start was not delivered", cause).pipe(
            Effect.annotateLogs({ runId: next.value.runId }),
          ),
        ),
        Effect.option,
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
      cancellation: {
        readonly messageId: string
        readonly reason: string
        readonly actor: string | null
      },
    ) {
      const live = yield* store.liveRuns(selection.repositoryId, selection.issueNumber)
      const selected = live.filter(
        (run) =>
          (selection.commentId === undefined || run.commentId === selection.commentId) &&
          (selection.runId === undefined || run.runId === selection.runId),
      )
      const snapshots: Array<RunSnapshot> = []
      for (const run of selected) {
        const result = yield* agents
          .cancel(run.runId, {
            ...cancellation,
            messageId: `${cancellation.messageId}:${run.runId}`,
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Review run cancellation was not delivered", cause).pipe(
                Effect.annotateLogs({ runId: run.runId }),
              ),
            ),
            Effect.option,
          )
        if (Option.isSome(result)) snapshots.push(result.value)
      }
      return snapshots
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
