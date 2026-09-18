import { savedPublicationOutcome } from "./SavedPublication.ts"
import { draftIntent, summaryIntent } from "./Output.ts"
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
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import {
  actionMessageId,
  limitations,
  REVIEW_ACTION_TAG,
  ReviewActionDispatch,
  type ReviewActionPayload,
  reviewActionKey,
} from "./Actions.ts"
import {
  ActionResult,
  mergeObserved,
  observedEvidence,
  type Prepared,
  type Round,
  validateCitations,
} from "./Conversation.ts"
import { disabledReason, IssueReviewAvailable, unavailableReason } from "./Gate.ts"
import { IssueReviewScheduler } from "./Scheduler.ts"
import { type ActionKind, type Cancellation, IssueReviewStore, type RunRecord } from "./Store.ts"
import { ReviewWorkspaces } from "./Workspace.ts"

/**
 * The review agent (ADR 0012): one persistent cluster Entity per review run,
 * addressed by the run ID. It receives messages, owns the run's lifecycle
 * and persists its state explicitly in the run record; every message is
 * recorded by the identity its sender chose, so a redelivery is applied
 * once. The investigation itself runs as embedded action workflows: the
 * agent schedules each action, applies its completion once, and decides
 * whether the run continues, concludes or stops.
 */

/** Installation, investigation and testing share this single allowance. */
export const EXECUTION_ALLOWANCE = Duration.minutes(15)

/** Consecutive model turns without a tool call or `finish` before the run stops. */
export const MAX_IDLE_ROUNDS = 3

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
  }).annotate(ClusterSchema.Persisted, true),
  /** Cancellation details live in the expiring application journal, not the cluster mailbox. */
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
  /** An action workflow recorded its result. */
  Rpc.make("ActionCompleted", {
    payload: { messageId: Schema.String, sequence: Schema.Int },
    primaryKey: ({ messageId }) => messageId,
    success: RunSnapshot,
    error: ReviewRunMissing,
  }).annotate(ClusterSchema.Persisted, true),
])

const snapshot = (run: RunRecord): RunSnapshot => ({
  runId: run.runId,
  status: run.status,
  // Detailed reasons are read from expiring history, never copied into durable RPC replies.
  cancelReason: null,
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
    readonly actionCompleted: (
      runId: string,
      messageId: string,
      sequence: number,
    ) => Effect.Effect<RunSnapshot, unknown>
  }
>()("@janitor/cluster/Review/ReviewAgentClient") {
  static readonly layer: Layer.Layer<ReviewAgentClient, never, Sharding> = Layer.effect(
    this,
    Effect.map(ReviewAgent.client, (client) => ({
      start: (runId, messageId) => client(runId).Start({ messageId }),
      cancel: (runId, message) => client(runId).Cancel(message),
      actionCompleted: (runId, messageId, sequence) =>
        client(runId).ActionCompleted({ messageId, sequence }),
    })),
  )
}

const decodeResult = Schema.decodeUnknownEffect(ActionResult)

export const ReviewAgentLayer = ReviewAgent.toLayer(
  Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress
    const runId = address.entityId
    const sql = yield* SqlClient.SqlClient
    const store = yield* IssueReviewStore
    const eligibility = yield* RepositoryEligibility
    const scheduler = yield* IssueReviewScheduler
    const available = yield* IssueReviewAvailable
    const outbox = yield* WorkflowOutbox
    const dispatch = yield* ReviewActionDispatch
    const workspaces = yield* ReviewWorkspaces

    const missing = new ReviewRunMissing({ runId })
    const orDie = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
      Effect.orDie(effect)

    interface Applied {
      readonly run: RunRecord
      readonly released: boolean
      /** Whether this was the message's first delivery. */
      readonly fresh: boolean
      readonly scheduled: ReadonlyArray<ReviewActionPayload>
    }

    /**
     * Loads and holds the run, records the message once, and applies the
     * transition only for a first delivery of a live run. Returns the run
     * after the transition, whether the caller must release the issue, and
     * the actions to start once the transaction committed.
     */
    const receive = <P>(
      message: { readonly messageId: string; readonly kind: string; readonly payload: P },
      apply: (run: RunRecord, schedule: Schedule) => Effect.Effect<RunRecord, never, never>,
    ): Effect.Effect<Applied, ReviewRunMissing> =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* store.lockRun(runId)
            if (Option.isNone(current)) return yield* missing
            const run = current.value
            const live =
              !isTerminalReviewStatus(run.status) || run.savedPublication?.status === "pending"
            const fresh = yield* store.recordMessage({
              runId,
              messageId: message.messageId,
              kind: message.kind,
              payload: message.payload,
              applied: live,
            })
            if (!fresh || !live) return { run, released: false, fresh, scheduled: [] }
            const scheduled: Array<ReviewActionPayload> = []
            const schedule: Schedule = (sequence, kind) =>
              Effect.gen(function* () {
                const payload = { runId, sequence }
                yield* orDie(store.insertAction(runId, sequence, kind))
                yield* orDie(
                  outbox.enqueue({
                    workflowTag: REVIEW_ACTION_TAG,
                    executionKey: reviewActionKey(payload),
                    payload,
                  }),
                )
                scheduled.push(payload)
              })
            const applied = yield* apply(run, schedule)
            return {
              run: applied,
              released:
                isTerminalReviewStatus(applied.status) &&
                applied.savedPublication?.status !== "pending",
              fresh,
              scheduled,
            }
          }),
        )
        .pipe(
          Effect.catchTag("SqlError", (error) => Effect.die(error)),
          Effect.catchTag("@janitor/cluster/Review/IssueReviewError", (error) => Effect.die(error)),
        )

    type Schedule = (sequence: number, kind: ActionKind) => Effect.Effect<void>

    const now = Effect.map(DateTime.now, DateTime.toDateUtc)

    const cancelled = (run: RunRecord, reason: string, actor: string | null) =>
      Effect.gen(function* () {
        return yield* orDie(
          store.transition(run.runId, {
            status: "cancelled",
            finishedAt: yield* now,
            cancelReason: reason,
            cancelledBy: actor ?? undefined,
            agentState: { phase: "cancelled" },
          }),
        )
      })

    /** Ends the run without a conclusion, keeping what it observed. */
    const ended = (
      run: RunRecord,
      status: "failed" | "interrupted",
      limitation: string,
      rounds: ReadonlyArray<Round>,
      repository: string | undefined,
    ) =>
      Effect.gen(function* () {
        return yield* orDie(
          store.transition(run.runId, {
            status,
            finishedAt: yield* now,
            limitation,
            evidence:
              repository === undefined ? [] : observedEvidence(mergeObserved(rounds), repository),
            agentState: { phase: status },
          }),
        )
      })

    const investigating = (run: RunRecord, schedule: Schedule, sequence: number) =>
      Effect.gen(function* () {
        yield* schedule(sequence, "model")
        return yield* orDie(
          store.transition(run.runId, {
            status: "running",
            agentState: { phase: "investigating", action: sequence },
          }),
        )
      })

    /** Applies a completed action's result to the run. */
    const applyAction = (run: RunRecord, schedule: Schedule, sequence: number) =>
      Effect.gen(function* () {
        const rows = yield* orDie(store.actions(runId))
        const completed = rows.filter((row) => row.status === "completed")
        const action = completed.find((row) => row.sequence === sequence)
        if (action === undefined) return run
        if (
          run.savedPublication != null &&
          !["publish", "publish_branch", "publish_pr"].includes(action.kind)
        )
          return run
        const results = yield* Effect.forEach(completed, (row) =>
          decodeResult(row.result).pipe(Effect.map((result) => [row.sequence, result] as const)),
        ).pipe(Effect.orDie)
        const result = results.find(([at]) => at === sequence)![1]
        const prepared = results
          .map(([, value]) => value)
          .find((value): value is Prepared => value._tag === "Ready")
        const rounds = results
          .filter(([at]) => at <= sequence)
          .map(([, value]) => value)
          .filter((value): value is Round => value._tag === "Round")
        const repository = prepared?.repository
        const overdue =
          run.deadlineAt !== null &&
          (yield* now).getTime() >= DateTime.toEpochMillis(run.deadlineAt)
        switch (result._tag) {
          case "Ready":
            return yield* investigating(run, schedule, sequence + 1)
          case "Denied":
            return yield* cancelled(run, result.reason, null)
          case "Unavailable":
            return yield* ended(run, "failed", result.reason, rounds, repository)
          case "Round": {
            if (result.conclusion !== null) {
              const evidence = validateCitations(
                result.conclusion.evidence,
                mergeObserved(rounds),
                repository ?? "",
              )
              const concluded = yield* orDie(
                store.transition(run.runId, {
                  status: run.dryRun ? "completed" : "running",
                  finishedAt: run.dryRun ? yield* now : undefined,
                  conclusion: { ...result.conclusion, evidence },
                  agentState: { phase: run.dryRun ? "completed" : "publishing" },
                }),
              )
              const draft = draftIntent(
                concluded,
                repository ?? "",
                result.conclusion.reproductionPr,
              )
              if (draft !== null) yield* orDie(store.saveDraft(runId, draft))
              const intent = summaryIntent(concluded, repository ?? "")
              yield* orDie(store.savePublication(runId, intent))
              if (run.dryRun) return concluded
              if (intent.status === "rejected")
                return yield* orDie(
                  store.transition(runId, {
                    status: "completed",
                    finishedAt: yield* now,
                    agentState: { phase: "completed" },
                  }),
                )
              yield* schedule(
                sequence + 1,
                draft?.status === "pending" ? "publish_branch" : "publish",
              )
              return concluded
            }
            if (overdue)
              return yield* ended(run, "failed", limitations.deadline, rounds, repository)
            const idle = rounds
              .slice(-MAX_IDLE_ROUNDS)
              .every((round) => round.tools.length === 0 && round.conclusion === null)
            if (rounds.length >= MAX_IDLE_ROUNDS && idle)
              return yield* ended(run, "failed", limitations.idle, rounds, repository)
            return yield* investigating(run, schedule, sequence + 1)
          }
          case "TimedOut":
            return yield* ended(run, "failed", limitations.deadline, rounds, repository)
          case "Interrupted":
            return yield* ended(run, "interrupted", result.reason, rounds, repository)
          case "Failed":
            return yield* ended(run, "failed", result.reason, rounds, repository)
          case "BranchFinished":
            yield* schedule(
              sequence + 1,
              run.draftPublication?.status === "branch" ? "publish_pr" : "publish",
            )
            return run
          case "DraftFinished":
            yield* schedule(sequence + 1, "publish")
            return run
          case "PublicationFinished":
            if (run.savedPublication?.status === "pending") {
              yield* orDie(
                sql`UPDATE issue_review_run SET saved_publication = ${JSON.stringify({ ...run.savedPublication, status: savedPublicationOutcome(run) })}::jsonb WHERE run_id::text = ${runId}`,
              )
              return Option.getOrThrow(yield* orDie(store.run(runId)))
            }
            return yield* orDie(
              store.transition(runId, {
                status: "completed",
                finishedAt: yield* now,
                agentState: { phase: "completed" },
              }),
            )
          case "Skipped":
            return run
        }
      })

    /**
     * A start for a run that is already running: after a restart, or a
     * completion whose message was lost. The latest completed action is
     * applied if it was not yet; a pending action is left to its workflow.
     */
    const resync = (run: RunRecord, schedule: Schedule) =>
      Effect.gen(function* () {
        const rows = yield* orDie(store.actions(runId))
        const latest = rows.at(-1)
        if (latest === undefined || latest.status !== "completed") return run
        const fresh = yield* orDie(
          store.recordMessage({
            runId,
            messageId: actionMessageId({ runId, sequence: latest.sequence }),
            kind: "ActionCompleted",
            payload: { resync: true, sequence: latest.sequence },
            applied: true,
          }),
        )
        return fresh ? yield* applyAction(run, schedule, latest.sequence) : run
      })

    const finish = (result: Applied) =>
      Effect.gen(function* () {
        if (result.released)
          yield* orDie(scheduler.release(result.run.repositoryId, result.run.issueNumber))
        // A run that reached the sandbox lets it go once it ends, whoever ended
        // it; a redelivered message to a finished run does not start a container.
        if (
          result.fresh &&
          result.run.savedPublication == null &&
          isTerminalReviewStatus(result.run.status) &&
          result.run.commitSha !== null
        )
          yield* workspaces
            .open(runId)
            .release.pipe(
              Effect.catch((error) =>
                Effect.logWarning("Review workspace release failed", error).pipe(
                  Effect.annotateLogs({ runId }),
                ),
              ),
            )
        for (const payload of result.scheduled) yield* dispatch.dispatch(payload)
        yield* flushLive
        return snapshot(result.run)
      })

    return {
      Start: (envelope) =>
        receive(
          { messageId: envelope.payload.messageId, kind: "Start", payload: envelope.payload },
          (run, schedule) =>
            Effect.gen(function* () {
              if (run.status === "running" || run.savedPublication?.status === "pending")
                return yield* resync(run, schedule)
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
              const started = yield* DateTime.now
              const running = yield* orDie(
                store.transition(run.runId, {
                  status: "running",
                  startedAt: DateTime.toDateUtc(started),
                  deadlineAt: DateTime.toDateUtc(
                    DateTime.addDuration(started, EXECUTION_ALLOWANCE),
                  ),
                  agentState: { phase: "preparing", action: 0 },
                }),
              )
              yield* schedule(0, "prepare")
              return running
            }),
        ).pipe(Effect.flatMap(finish)),
      Cancel: (envelope) =>
        receive(
          { messageId: envelope.payload.messageId, kind: "Cancel", payload: envelope.payload },
          (run) => cancelled(run, envelope.payload.reason, envelope.payload.actor),
        ).pipe(Effect.flatMap(finish)),
      ActionCompleted: (envelope) =>
        receive(
          {
            messageId: envelope.payload.messageId,
            kind: "ActionCompleted",
            payload: envelope.payload,
          },
          (run, schedule) =>
            run.status === "running" || run.savedPublication?.status === "pending"
              ? applyAction(run, schedule, envelope.payload.sequence)
              : Effect.succeed(run),
        ).pipe(Effect.flatMap(finish)),
    }
  }),
  // A cancellation must be processed while an earlier message is pending.
  { concurrency: "unbounded" },
)
