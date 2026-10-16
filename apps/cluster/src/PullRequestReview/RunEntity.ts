import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as Clock from "effect/Clock"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import * as EntityResource from "effect/cluster/EntityResource"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import {
  GitHubCommitSha,
  GitHubInstallationId,
  GitHubRepositoryDatabaseId,
} from "@janitor/domain/GitHub/Id"
import { resumeMessage, wrapUpMessage } from "@janitor/domain/PullRequestReview/Prompt"
import { checkRunOutput, type RunError } from "@janitor/domain/PullRequestReview/Render"
import { RunId, SkipReason, Trigger } from "@janitor/domain/PullRequestReview/Run"
import { GitHubTransport } from "../GitHub/Transport.ts"
import { RepositoryEligibility } from "../RepositoryEligibility.ts"
import { type LoopOutcome, ReviewAgent, type ReviewSession } from "./Agent.ts"
import { pullRequestReviewConfig } from "./Config.ts"
import * as ReviewGitHub from "./GitHub.ts"
import { makeRunStorage, type RunState } from "./RunStorage.ts"
import { SandboxWorkspaces } from "./Sandbox/WorkspaceClient.ts"
import { PullRequestScheduler, schedulerEntityId } from "./Scheduler.ts"
import { recordSkip } from "./Skip.ts"
import { PullRequestReviewStore } from "./Store.ts"

/**
 * The message protocol of the PR review run entity, one entity per run with
 * the run id as its entity id (EFF-1651 point 5). The per-PR scheduler mints
 * the run id, sends `Start` and `Cancel`, and hears back through its own
 * `RunFinished` whenever the run reaches a final state: published, quiet,
 * skipped, cancelled or errored. Payloads carry ids only, never pull request
 * or invoker text (EFF-1848 point 10).
 */

const run = {
  runId: RunId,
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  headSha: GitHubCommitSha,
  trigger: Trigger,
}

/**
 * Reviews the pull request at `headSha`. The handler checks it is still open
 * and not a draft. Each message is keyed by its run, so the scheduler can
 * send it again after a crash without the run entity seeing it twice.
 */
export const Start = Rpc.make("Start", {
  payload: run,
  primaryKey: ({ runId }) => `start:${runId}`,
})

/** Stops the run. A run that is publishing finishes its batch first. */
export const Cancel = Rpc.make("Cancel", {
  payload: { runId: RunId },
  primaryKey: ({ runId }) => `cancel:${runId}`,
})

/**
 * Records a run the scheduler won't start: the `skipped` row and the neutral
 * `janitor/review` check run. The scheduler does no GitHub I/O, so the run
 * entity writes both. It sends no `RunFinished`: a skipped run never became
 * the active run.
 */
export const Skip = Rpc.make("Skip", {
  payload: { ...run, reason: SkipReason },
  primaryKey: ({ runId }) => `skip:${runId}`,
})

/** Sent to itself once the loop's outcome is saved. Only the run entity sends it. */
export const Publish = Rpc.make("Publish", {
  payload: { runId: RunId },
  primaryKey: ({ runId }) => `publish/${runId}`,
})

/** Sent to itself when the run is final, for when its debugging data goes (EFF-1848). */
export class ExpirePayload extends Schema.Class<ExpirePayload>("PullRequestReviewRun/Expire")({
  runId: RunId,
  at: Schema.DateTimeUtc,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  [PrimaryKey.symbol](): string {
    return `expire/${this.runId}`
  }
}
export const Expire = Rpc.make("Expire", { payload: ExpirePayload })

export const PullRequestReviewRun = Entity.make("PullRequestReviewRun", [
  Start,
  Cancel,
  Skip,
  Publish,
  Expire,
]).annotateRpcs(ClusterSchema.Persisted, true)

/**
 * What the `Publish` handler does with a finished loop's outcome: the review
 * batch from "PR review: the Publish batch and run record" (EFF-1964).
 */
export class RunPublisher extends Context.Service<
  RunPublisher,
  {
    readonly publish: (run: {
      readonly runId: RunId
      readonly outcome: LoopOutcome
    }) => Effect.Effect<void>
  }
>()("@janitor/cluster/PullRequestReview/RunEntity/RunPublisher") {}

/** Why an acquire stopped instead of starting the loop. */
class RunStopped extends Data.TaggedError("RunStopped")<{
  readonly reason: "cancelled" | RunError
}> {}

/** The longest wait between attempts at a container. */
const MAX_CONTAINER_BACKOFF = Duration.seconds(30)

const isEnded = (phase: RunState["phase"]) =>
  phase === "skipped" || phase === "cancelled" || phase === "failed"

/** Waits until epoch millis `at`; a time already past doesn't wait at all. */
const sleepUntil = (at: number) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    at > now ? Effect.sleep(Duration.millis(at - now)) : Effect.void,
  )

/**
 * The run entity's handlers (EFF-1651, EFF-1848), over its own
 * `CloudflareCluster.DurableObjectSqlClient`. The agent loop lives in an
 * `EntityResource`: acquiring it provisions the sandbox, restores the
 * history and forks the loop into the resource's `CloseScope`, and holding
 * it holds keep-alive, so a restart rebuilds the entity and resumes. Once
 * the run is final the resource is closed, or the heartbeat would rebuild a
 * finished entity after every deploy.
 *
 * Handlers run concurrently, so a `Cancel` reaches a run whose `Start` is
 * still waiting for a container. Every state change is one short transaction
 * that only runs SQL.
 */
export const PullRequestReviewRunLayer = PullRequestReviewRun.toLayer(
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress
    const runId = RunId.make(entityId)
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
    const storage = makeRunStorage(sql, entityId)
    const store = yield* PullRequestReviewStore
    const eligibility = yield* RepositoryEligibility
    const transport = yield* GitHubTransport
    const workspaces = yield* SandboxWorkspaces
    const agent = yield* ReviewAgent
    const publisher = yield* RunPublisher
    const schedulers = yield* PullRequestScheduler.client
    const self = (yield* PullRequestReviewRun.client)(entityId)
    const entityScope = yield* Scope.Scope

    yield* storage.ensureTables.pipe(Effect.orDie)

    /** Set once `Expire` dropped the tables; later messages find nothing. */
    let expired = false
    /** Set by `Cancel`, so an acquire still waiting for a container gives up. */
    let cancelling = false
    /** The loop this entity started, while it runs. */
    let session: ReviewSession | undefined

    const github = (target: NonNullable<RunState["target"]>, number: number) =>
      ReviewGitHub.make({
        installationId: GitHubInstallationId.make(target.installationId),
        owner: target.owner,
        repo: target.repo,
        number,
      }).pipe(Effect.provideService(GitHubTransport, transport))

    /** Re-reads the pull request through the GitHub client. */
    const openPullRequest = (repositoryId: GitHubRepositoryDatabaseId, number: number) =>
      Effect.gen(function* () {
        const found = yield* eligibility.get(repositoryId)
        const [owner] = found.name.split("/")
        const target = {
          installationId: found.installationId,
          owner: owner!,
          repo: found.name.slice(owner!.length + 1),
        }
        const client = yield* github(target, number)
        return { target, client, pull: yield* client.pullRequest }
      })

    /** Moves a running run to a final phase; `None` when it had already moved on. */
    const end = (phase: "cancelled" | "failed", errorCategory: RunError | null) =>
      Effect.flatMap(DateTime.now, (now) =>
        storage.update((state) =>
          state.phase === "running"
            ? { ...state, phase, errorCategory, finishedAt: DateTime.toEpochMillis(now) }
            : undefined,
        ),
      )

    /** The `janitor/review` check run on a run that ended before `Publish`. */
    const concludeCheckRun = (state: RunState, target: NonNullable<RunState["target"]>) =>
      Effect.gen(function* () {
        const client = yield* github(target, state.number)
        yield* client.upsertCheckRun({
          headSha: state.headSha,
          ...(state.phase === "cancelled"
            ? {
                state: { status: "completed", conclusion: "cancelled" } as const,
                output: checkRunOutput({ _tag: "Cancelled" }),
              }
            : {
                state: { status: "completed", conclusion: "failure" } as const,
                output: checkRunOutput({
                  _tag: "Errored",
                  error: state.errorCategory ?? "incomplete",
                }),
              }),
          ...(state.checkRun === null ? {} : { checkRunId: state.checkRun.id }),
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Couldn't conclude the PR review check run", error),
        ),
      )

    /**
     * What a run that ended before `Publish` still owes, each part once: the
     * check run and the final Postgres row, then `RunFinished`, then `Expire`.
     * A restart picks up where an interrupted pass stopped.
     */
    const finalize = Effect.gen(function* () {
      const loaded = yield* storage.load
      if (Option.isNone(loaded) || !isEnded(loaded.value.phase)) return
      const state = loaded.value
      const finishedAt = DateTime.makeUnsafe(state.finishedAt ?? (yield* Clock.currentTimeMillis))
      if (!state.finalRowWritten && state.target !== null && state.phase !== "skipped") {
        yield* concludeCheckRun(state, state.target)
        const written = yield* store
          .finish({
            runId,
            repositoryId: state.repositoryId,
            number: state.number,
            title: state.title,
            headSha: state.headSha,
            baseSha: state.baseSha,
            trigger: state.trigger,
            startedAt: DateTime.makeUnsafe(state.startedAt),
            status: state.phase === "cancelled" ? "cancelled" : "failed",
            verdict: null,
            failedGates: [],
            standardsSources: null,
            resumeCount: Math.max(0, state.acquires - 1),
            errorCategory: state.errorCategory,
            finishedAt,
            review: null,
            checkRun: state.checkRun,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.as(Effect.logWarning("Couldn't record the PR review run", error), false),
            ),
          )
        if (written) yield* storage.update((current) => ({ ...current, finalRowWritten: true }))
      }
      if (!state.runFinishedSent) {
        yield* schedulers(schedulerEntityId(state.repositoryId, state.number)).RunFinished(
          { runId, finishedAt },
          { discard: true },
        )
        yield* storage.update((current) => ({ ...current, runFinishedSent: true }))
      }
      // A run cancelled before publishing has nothing worth keeping.
      const config = yield* pullRequestReviewConfig
      const at =
        state.phase === "cancelled"
          ? finishedAt
          : DateTime.addDuration(finishedAt, config.runRetention)
      yield* self.Expire(new ExpirePayload({ runId, at }), { discard: true })
    })

    const fail = (error: RunError) =>
      Effect.flatMap(end("failed", error), (ended) =>
        Option.isSome(ended) ? finalize : Effect.void,
      )

    /**
     * Provisions the sandbox at the pinned head. With no container to be had,
     * as at `max_instances`, it retries with backoff until the deadline.
     */
    const provision = (state: RunState, deadline: number) =>
      Effect.gen(function* () {
        const target = state.target!
        for (let attempt = 0; ; attempt++) {
          if (cancelling) return yield* new RunStopped({ reason: "cancelled" })
          const budget = deadline - (yield* Clock.currentTimeMillis)
          if (budget <= 0) return yield* new RunStopped({ reason: "sandbox_unavailable" })
          const acquired = yield* workspaces
            .acquire({
              runId: entityId,
              installationId: target.installationId,
              repositoryId: state.repositoryId,
              owner: target.owner,
              repo: target.repo,
              prNumber: state.number,
              baseSha: state.baseSha,
              headSha: state.headSha,
              startBudget: budget,
            })
            .pipe(Effect.result)
          if (acquired._tag === "Success") return acquired.success
          const error = acquired.failure
          if (error._tag === "WorkspaceReleased" && cancelling)
            return yield* new RunStopped({ reason: "cancelled" })
          if (error._tag !== "ContainerUnavailable")
            return yield* new RunStopped({ reason: "checkout_failed" })
          yield* Effect.logInfo("No PR review sandbox container available; retrying").pipe(
            Effect.annotateLogs({ runId, reason: error.reason }),
          )
          const backoff = Math.min(1_000 * 2 ** attempt, Duration.toMillis(MAX_CONTAINER_BACKOFF))
          yield* sleepUntil(Math.min((yield* Clock.currentTimeMillis) + backoff, deadline))
        }
      })

    /** Tells the agent to wrap up, and records it. */
    const wrapUp = (live: ReviewSession) =>
      Effect.flatMap(live.steer(wrapUpMessage), () =>
        storage.update((state) => ({ ...state, steered: true })),
      )

    /**
     * Drives a running loop: the wrap-up message at minute 7 and the
     * interrupt at minute 10, both from the run's first start. When the loop
     * ends, it saves the outcome, sends `Publish` and closes the resource.
     */
    const drive = (live: ReviewSession, wrapUpAt: number, deadline: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const timers = yield* Effect.forkChild(
          Effect.gen(function* () {
            if (wrapUpAt > (yield* Clock.currentTimeMillis)) {
              yield* sleepUntil(wrapUpAt)
              yield* wrapUp(live)
            }
            yield* sleepUntil(deadline)
            yield* storage.update((state) => ({ ...state, interrupted: true }))
            yield* live.interrupt
          }),
        )
        const result = yield* live.result
        yield* Fiber.interrupt(timers)
        const records = yield* storage.records
        const saved = yield* storage.update((state) =>
          state.phase !== "running"
            ? undefined
            : {
                ...state,
                phase: "publishing",
                outcome: {
                  summary: result._tag === "Completed" ? result.summary : null,
                  steered: state.steered,
                  interrupted: state.interrupted,
                  unfinished:
                    result._tag === "Completed"
                      ? null
                      : result._tag === "Interrupted"
                        ? "deadline"
                        : "provider_failure",
                  records,
                },
              },
        )
        // Cancelled meanwhile: `Cancel` finishes the run.
        if (Option.isNone(saved)) return
        yield* self.Publish({ runId }, { discard: true })
        // Not from this fiber: closing the resource interrupts it.
        yield* Effect.forkIn(resource.close, entityScope)
      }).pipe(Effect.orDie)

    const acquire = Effect.gen(function* () {
      const closeScope = yield* EntityResource.CloseScope
      const config = yield* pullRequestReviewConfig
      // Every acquire after the first is a resume; past the allowed resumes the run errors.
      const counted = yield* storage.update((state) =>
        state.phase === "running" && state.acquires <= config.maxResumes
          ? { ...state, acquires: state.acquires + 1 }
          : undefined,
      )
      if (Option.isNone(counted)) {
        const current = yield* storage.load
        return yield* new RunStopped({
          reason:
            Option.isSome(current) && current.value.phase === "running"
              ? "resume_limit"
              : "cancelled",
        })
      }
      const state = counted.value
      const deadline = state.startedAt + Duration.toMillis(config.runDeadline)
      const wrapUpAt = state.startedAt + Duration.toMillis(config.wrapUpAfter)

      // Closing the resource stops the loop first, then destroys the container.
      yield* Scope.addFinalizer(closeScope, workspaces.release(entityId))
      const executor = yield* provision(state, deadline)
      if (cancelling) return yield* new RunStopped({ reason: "cancelled" })
      const history = yield* storage.resumeHistory
      const live = yield* agent
        .start({
          runId,
          executor,
          history,
          prompt: state.acquires > 1 ? resumeMessage : undefined,
          onStep: (step) => storage.commitStep(step.history, step.records).pipe(Effect.orDie),
        })
        .pipe(Effect.provideService(Scope.Scope, closeScope))
      session = live
      // A resume past wrap-up time goes straight to wrap-up.
      if ((yield* Clock.currentTimeMillis) >= wrapUpAt) yield* wrapUp(live)
      yield* Scope.addFinalizer(
        closeScope,
        Effect.sync(() => {
          session = undefined
        }),
      )
      yield* Effect.forkIn(drive(live, wrapUpAt, deadline), closeScope)
    }).pipe(Effect.catchIf((error) => !(error instanceof RunStopped), Effect.die))

    // Never acquired eagerly, so making it can't fail.
    const resource: EntityResource.EntityResource<void, RunStopped> = yield* EntityResource.make({
      acquire,
    }).pipe(Effect.orDie)

    /** Holds the loop; an acquire that stopped ends the run, unless it was cancelled. */
    const ensureAcquired = Effect.scoped(resource.get).pipe(
      Effect.catchTag("RunStopped", (stopped) =>
        stopped.reason === "cancelled" ? Effect.void : fail(stopped.reason),
      ),
    )

    // A rebuilt entity picks up where it was: an active run resumes at once.
    const initial = yield* storage.load.pipe(Effect.orDie)
    if (Option.isSome(initial)) {
      if (initial.value.phase === "running")
        yield* Effect.forkIn(Effect.orDie(ensureAcquired), entityScope)
      else if (isEnded(initial.value.phase))
        yield* Effect.forkIn(Effect.orDie(finalize), entityScope)
    }

    return PullRequestReviewRun.of({
      Start: ({ payload }) =>
        Effect.gen(function* () {
          if (expired) return
          const existing = yield* storage.load
          if (Option.isSome(existing)) {
            if (existing.value.phase === "running") yield* ensureAcquired
            return
          }
          const startedAt = yield* Clock.currentTimeMillis
          const fresh = {
            ...payload,
            target: null,
            title: "",
            baseSha: "",
            startedAt,
            acquires: 0,
            steered: false,
            interrupted: false,
            errorCategory: null,
            checkRun: null,
            outcome: null,
            finishedAt: null,
            finalRowWritten: false,
            runFinishedSent: false,
          } satisfies Omit<RunState, "phase">
          const opened = yield* openPullRequest(payload.repositoryId, payload.number).pipe(
            Effect.result,
          )
          if (opened._tag === "Failure") {
            yield* Effect.logWarning("Couldn't read the pull request for a PR review run").pipe(
              Effect.annotateLogs({ runId, error: opened.failure }),
            )
            // With no pull request to report on, there's no check run or row either.
            yield* storage.save({
              ...fresh,
              phase: "failed",
              errorCategory: "incomplete",
              finishedAt: startedAt,
            })
            return yield* finalize
          }
          const { target, client, pull } = opened.success
          const known = { ...fresh, target, title: pull.title, baseSha: pull.baseSha }
          // Closed or turned draft since it was queued: skipped, like the other draft skips.
          if (pull.state === "closed" || pull.draft) {
            yield* storage.save({ ...known, phase: "skipped", finishedAt: startedAt })
            return yield* finalize
          }
          yield* storage.save({ ...known, phase: "running" })
          yield* store
            .start({
              ...payload,
              title: pull.title,
              baseSha: pull.baseSha,
              startedAt: DateTime.makeUnsafe(startedAt),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Couldn't write the PR review start row", error),
              ),
            )
          const checkRun = yield* client
            .upsertCheckRun({
              headSha: payload.headSha,
              state: { status: "in_progress" },
              output: checkRunOutput({ _tag: "Reviewing" }),
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning("Couldn't start the PR review check run", error),
              ),
              Effect.option,
            )
          if (Option.isSome(checkRun))
            yield* storage.update((state) => ({ ...state, checkRun: checkRun.value }))
          yield* ensureAcquired
        }).pipe(Effect.orDie),

      Cancel: () =>
        Effect.gen(function* () {
          if (expired) return
          const ended = yield* end("cancelled", null)
          if (Option.isNone(ended)) return
          cancelling = true
          // Interrupt the loop before destroying its container, so the loop
          // can't fail on a missing sandbox and overwrite `cancelled`.
          if (session !== undefined) yield* session.interrupt
          yield* resource.close
          yield* finalize
        }).pipe(Effect.orDie),

      Skip: ({ payload }) =>
        Effect.gen(function* () {
          const { client, pull } = yield* openPullRequest(payload.repositoryId, payload.number)
          yield* recordSkip(client, {
            ...payload,
            title: pull.title,
            baseSha: pull.baseSha,
            startedAt: yield* DateTime.now,
          })
        }).pipe(
          Effect.provideService(PullRequestReviewStore, store),
          Effect.catch((error) =>
            Effect.logWarning("Couldn't record a skipped PR review run", error),
          ),
        ),

      Publish: ({ payload }) =>
        Effect.gen(function* () {
          if (expired) return
          const state = yield* storage.load
          if (Option.isNone(state) || state.value.outcome === null) return
          yield* publisher.publish({ runId: payload.runId, outcome: state.value.outcome })
        }).pipe(Effect.orDie),

      Expire: () =>
        Effect.gen(function* () {
          expired = true
          yield* storage.drop
        }).pipe(Effect.orDie),
    })
  }),
  { concurrency: "unbounded" },
)
