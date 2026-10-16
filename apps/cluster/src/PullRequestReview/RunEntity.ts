import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as Clock from "effect/Clock"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import * as EntityResource from "effect/cluster/EntityResource"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
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
import { loadRunRecord, writeRunRecord } from "./RunRecord.ts"
import { makeRunStorage, type RunState, type RunStorage } from "./RunStorage.ts"
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

/**
 * Sent to itself when the run is final, for when its debugging data goes
 * (EFF-1848). While a run's final Postgres row is still unwritten, `retry`
 * numbers an earlier delivery that retries the row instead.
 */
export class ExpirePayload extends Schema.Class<ExpirePayload>("PullRequestReviewRun/Expire")({
  runId: RunId,
  at: Schema.DateTimeUtc,
  retry: Schema.NullOr(Schema.Int),
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  [PrimaryKey.symbol](): string {
    return this.retry === null ? `expire/${this.runId}` : `expire/${this.runId}/retry/${this.retry}`
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
 * batch from "PR review: the Publish batch and run record" (EFF-1964),
 * `RunPublisherLayer` in `Publish.ts`. It journals its steps and the run's
 * final record in the run's storage and, once done, saves the run as
 * `published`, or as `cancelled` when a push superseded it, with
 * `RunFinished` sent and whether the record was written.
 */
export class RunPublisher extends Context.Service<
  RunPublisher,
  {
    readonly publish: (run: {
      readonly runId: RunId
      readonly outcome: LoopOutcome
      readonly state: RunState
      readonly storage: RunStorage
    }) => Effect.Effect<void>
  }
>()("@janitor/cluster/PullRequestReview/RunEntity/RunPublisher") {}

/** Why an acquire stopped instead of starting the loop. */
class RunStopped extends Data.TaggedError("RunStopped")<{
  readonly reason: "cancelled" | RunError
}> {}

/** The longest wait between attempts at a container. */
const MAX_CONTAINER_BACKOFF = Duration.seconds(30)

/** The first and longest waits before retrying a final Postgres row that failed. */
const FINAL_ROW_RETRY = Duration.minutes(1)
const MAX_FINAL_ROW_RETRY = Duration.minutes(30)

const isEnded = (phase: RunState["phase"]) =>
  phase === "skipped" || phase === "cancelled" || phase === "failed" || phase === "published"

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
    /** Completed by `Cancel`; interrupts an acquire still in flight. */
    const stop = Deferred.makeUnsafe<void>()
    /** One per acquire in flight, completed once it has finished, release included. */
    const acquiring = new Set<Deferred.Deferred<void>>()
    /** `finalize` runs one pass at a time. */
    const finalizing = yield* Semaphore.make(1)
    /**
     * Set while `Start` makes its startup writes, the start row and the check
     * run. A `Cancel` meanwhile leaves finishing the run to `Start`, which
     * finalizes once those writes are done, so the check run is concluded and
     * nothing writes after `Expire`.
     */
    let startingUp = false
    /** The loop this entity started, while it runs. */
    let session: ReviewSession | undefined
    /**
     * Whether this entity holds the run's workspace: from an acquire until it
     * is released. Releasing is terminal, so closing the resource to resume
     * after a lost sandbox keeps the workspace, and the next acquire resets it.
     */
    let workspaceHeld = false
    let resuming = false

    /** Releases the run's workspace if this entity still holds it. */
    const releaseWorkspace = Effect.suspend(() => {
      if (!workspaceHeld) return Effect.void
      workspaceHeld = false
      return workspaces.release(entityId)
    })

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
     * What a final run still owes, each part once: for a run that ended before
     * `Publish`, the check run and the final Postgres row; for one that
     * published, the record `Publish` journalled, until Postgres takes it.
     * Then `RunFinished`, then `Expire`. A restart picks up where an
     * interrupted pass stopped.
     */
    const finalize = Effect.gen(function* () {
      const loaded = yield* storage.load
      if (Option.isNone(loaded) || !isEnded(loaded.value.phase)) return
      const state = loaded.value
      const finishedAt = DateTime.makeUnsafe(state.finishedAt ?? (yield* Clock.currentTimeMillis))
      const rowDue = state.target !== null && state.phase !== "skipped"
      let rowWritten = state.finalRowWritten || !rowDue
      const journalled = yield* loadRunRecord(storage)
      if (!rowWritten && Option.isSome(journalled)) {
        // `Publish` already did the GitHub writes; only the record is left.
        rowWritten = yield* writeRunRecord(store, storage, journalled.value)
        yield* storage.update((current) =>
          rowWritten
            ? { ...current, finalRowWritten: true }
            : { ...current, finalRowAttempts: current.finalRowAttempts + 1 },
        )
      } else if (!rowWritten && state.target !== null) {
        // A run cancelled before asking for a check run has none to conclude. One
        // asked for but without a saved id is found by its head SHA.
        if (state.checkRun !== null || state.checkRunAttempted || state.phase === "failed")
          yield* concludeCheckRun(state, state.target)
        rowWritten = yield* store
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
        yield* storage.update((current) =>
          rowWritten
            ? { ...current, finalRowWritten: true }
            : { ...current, finalRowAttempts: current.finalRowAttempts + 1 },
        )
      }
      if (!state.runFinishedSent) {
        yield* schedulers(schedulerEntityId(state.repositoryId, state.number)).RunFinished(
          { runId, finishedAt },
          { discard: true },
        )
        yield* storage.update((current) => ({ ...current, runFinishedSent: true }))
      }
      const config = yield* pullRequestReviewConfig
      const retention = DateTime.addDuration(finishedAt, config.runRetention)
      if (!rowWritten) {
        // The row is retried before anything expires, for as long as the run is kept.
        const now = yield* DateTime.now
        const retry = state.finalRowAttempts + 1
        const wait = Duration.min(
          Duration.times(FINAL_ROW_RETRY, 2 ** (retry - 1)),
          MAX_FINAL_ROW_RETRY,
        )
        if (DateTime.isLessThan(now, retention))
          return yield* self.Expire(
            new ExpirePayload({ runId, at: DateTime.addDuration(now, wait), retry }),
            { discard: true },
          )
        yield* Effect.logError("Gave up recording a PR review run").pipe(
          Effect.annotateLogs({ runId }),
        )
      }
      // A run cancelled before publishing has nothing worth keeping.
      const at = state.phase === "cancelled" ? finishedAt : retention
      yield* self.Expire(new ExpirePayload({ runId, at, retry: null }), { discard: true })
    }).pipe(Semaphore.withPermits(finalizing, 1))

    /** Ends a running run as `failed`; a run that already ended is left as it is. */
    const fail = (errorCategory: RunError) =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis
        const ended = yield* storage.update((state) =>
          state.phase === "running"
            ? { ...state, phase: "failed", errorCategory, finishedAt }
            : undefined,
        )
        if (Option.isSome(ended)) yield* finalize
      })

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
        if (result._tag === "SandboxLost") {
          // Not a failed run: a fresh sandbox and checkout, and the loop resumes
          // from its history. The re-acquire counts as a resume.
          yield* Effect.logWarning("PR review sandbox lost; resuming in a new one").pipe(
            Effect.annotateLogs({ runId }),
          )
          // Not from this fiber: closing the resource interrupts it.
          yield* Effect.forkIn(
            Effect.gen(function* () {
              resuming = true
              yield* Effect.ensuring(
                resource.close,
                Effect.sync(() => {
                  resuming = false
                }),
              )
              yield* ensureAcquired
            }),
            entityScope,
          )
          return
        }
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
      // Cancelled before this acquire was registered: stop before any SQL, as `Expire` may follow.
      if (cancelling) return yield* new RunStopped({ reason: "cancelled" })
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

      // Closing the resource stops the loop first, then destroys the container,
      // unless it closes to resume in the same workspace.
      workspaceHeld = true
      yield* Scope.addFinalizer(
        closeScope,
        Effect.suspend(() => (resuming ? Effect.void : releaseWorkspace)),
      )
      const executor = yield* provision(state, deadline)
      if (cancelling) return yield* new RunStopped({ reason: "cancelled" })
      const history = yield* storage.resumeHistory
      const records = yield* storage.records
      const live = yield* agent
        .start({
          runId,
          github: yield* github(state.target!, state.number),
          pullRequest: { headSha: state.headSha, baseSha: state.baseSha, trigger: state.trigger },
          executor,
          history,
          prompt: state.acquires > 1 ? resumeMessage : undefined,
          records,
          onStep: (step) => storage.commitStep(step.history, step.records).pipe(Effect.orDie),
        })
        .pipe(
          Effect.provideService(Scope.Scope, closeScope),
          // Reading the loop's inputs is bounded by the run's deadline, like provisioning.
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(0, deadline - (yield* Clock.currentTimeMillis))),
            orElse: () =>
              Effect.andThen(
                Effect.logWarning("PR review inputs weren't read before the deadline").pipe(
                  Effect.annotateLogs({ runId }),
                ),
                Effect.fail(new RunStopped({ reason: "incomplete" })),
              ),
          }),
          Effect.catchTag("ReviewInputError", (error) =>
            Effect.andThen(
              Effect.logWarning("Couldn't read the PR review run's inputs").pipe(
                Effect.annotateLogs({ runId, operation: error.operation }),
              ),
              Effect.fail(new RunStopped({ reason: "incomplete" })),
            ),
          ),
        )
      // Cancelled while the agent started: closing the scope stops it, then releases.
      if (cancelling) return yield* new RunStopped({ reason: "cancelled" })
      session = live
      yield* storage.update((current) => ({
        ...current,
        standardsSources: live.standardsSources,
      }))
      // A resume past wrap-up time goes straight to wrap-up.
      if ((yield* Clock.currentTimeMillis) >= wrapUpAt) yield* wrapUp(live)
      yield* Scope.addFinalizer(
        closeScope,
        Effect.sync(() => {
          session = undefined
        }),
      )
      yield* Effect.forkIn(drive(live, wrapUpAt, deadline), closeScope)
    }).pipe(
      Effect.catchIf((error) => !(error instanceof RunStopped), Effect.die),
      // `Cancel` interrupts an acquire wherever it is, agent start included.
      Effect.raceFirst(
        Effect.andThen(Deferred.await(stop), Effect.fail(new RunStopped({ reason: "cancelled" }))),
      ),
    )

    // Never acquired eagerly, so making it can't fail.
    const resource: EntityResource.EntityResource<void, RunStopped> = yield* EntityResource.make({
      acquire,
    }).pipe(Effect.orDie)

    /**
     * Holds the loop; an acquire that stopped ends the run, unless it was
     * cancelled. `Cancel` waits for it to finish, workspace release included.
     */
    const ensureAcquired = Effect.gen(function* () {
      const done = Deferred.makeUnsafe<void>()
      acquiring.add(done)
      yield* Effect.scoped(resource.get).pipe(
        Effect.ensuring(
          Effect.andThen(
            Deferred.succeed(done, undefined),
            Effect.sync(() => {
              acquiring.delete(done)
            }),
          ),
        ),
      )
    }).pipe(
      Effect.catchTag("RunStopped", (stopped) =>
        // An acquire that stopped before taking the workspace over, after a
        // resume kept it, releases it here.
        Effect.andThen(
          releaseWorkspace,
          stopped.reason === "cancelled" ? Effect.void : fail(stopped.reason),
        ),
      ),
    )

    // A rebuilt entity picks up where it was: an active run resumes at once.
    const initial = yield* storage.load.pipe(Effect.orDie)
    if (Option.isSome(initial)) {
      if (initial.value.phase === "running")
        yield* Effect.forkIn(Effect.orDie(ensureAcquired), entityScope)
      else if (isEnded(initial.value.phase))
        yield* Effect.forkIn(Effect.orDie(finalize), entityScope)
      // Rebuilt after the outcome was saved, maybe before `Publish` went out:
      // send it again, keyed so a duplicate is dropped, and let the entity go.
      else if (initial.value.phase === "publishing")
        yield* Effect.forkIn(
          Effect.andThen(self.Publish({ runId }, { discard: true }), Entity.keepAlive(false)).pipe(
            Effect.orDie,
          ),
          entityScope,
        )
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
            checkRunAttempted: false,
            outcome: null,
            finishedAt: null,
            finalRowWritten: false,
            finalRowAttempts: 0,
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
          const known = {
            ...fresh,
            target,
            title: pull.title,
            baseSha: pull.baseSha,
            baseRef: pull.baseRef,
          }
          // Closed or turned draft since it was queued: skipped, like the other draft skips.
          if (pull.state === "closed" || pull.draft) {
            yield* storage.save({ ...known, phase: "skipped", finishedAt: startedAt })
            return yield* finalize
          }
          startingUp = true
          // `false` when the run was cancelled before it could start.
          const started = yield* Effect.gen(function* () {
            const begun = yield* storage.begin({ ...known, phase: "running" })
            // Cancelled while the pull request was read: it never starts.
            if (begun.phase === "cancelled" || cancelling) return false
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
            if (cancelling) return false
            // Recorded first, in its own transaction: the request may create a
            // check run whose id never gets saved.
            yield* storage.update((state) => ({ ...state, checkRunAttempted: true }))
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
            return !cancelling
          }).pipe(
            // On every exit: a `Cancel` during startup left finishing the run to this.
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                startingUp = false
                return cancelling || (Exit.isSuccess(exit) && !exit.value) ? finalize : Effect.void
              }),
            ),
          )
          if (started && !cancelling) yield* ensureAcquired
        }).pipe(Effect.orDie),

      Cancel: () =>
        Effect.gen(function* () {
          if (expired) return
          const cancelled = yield* storage.cancel(yield* Clock.currentTimeMillis)
          if (cancelled === "Ended") return
          cancelling = true
          // Read in the same step that set `cancelling`, so exactly one of
          // `Start` and `Cancel` finishes the run.
          const handedOff = startingUp
          yield* Deferred.succeed(stop, undefined)
          // Before `Start` saved the run, or during its startup writes: `Start` finishes it.
          if (cancelled === "Requested" || handedOff) return
          // Interrupt the loop before destroying its container, so the loop
          // can't fail on a missing sandbox and overwrite `cancelled`.
          if (session !== undefined) yield* session.interrupt
          yield* Effect.forEach(acquiring, Deferred.await, { discard: true })
          yield* resource.close
          // Kept by a resume that hadn't acquired again yet.
          yield* releaseWorkspace
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
          // A replay after the batch finished goes straight to `finalize`.
          if (state.value.phase === "publishing")
            yield* publisher.publish({
              runId: payload.runId,
              outcome: state.value.outcome,
              state: state.value,
              storage,
            })
          // Retries a record Postgres refused, then expires the run: after the
          // retention period, or at once when a push superseded it.
          yield* finalize
        }).pipe(Effect.orDie),

      Expire: ({ payload }) =>
        Effect.gen(function* () {
          if (expired) return
          // A retry of the final row: `finalize` tries it again, then sends the next `Expire`.
          if (payload.retry !== null) return yield* finalize
          expired = true
          yield* storage.drop
        }).pipe(Effect.orDie),
    })
  }),
  { concurrency: "unbounded" },
)
