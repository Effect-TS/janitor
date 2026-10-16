import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import type {
  AlreadyProcessingMessage,
  EntityNotAssignedToRunner,
  MailboxFull,
  PersistenceError,
} from "effect/cluster/ClusterError"
import * as ClusterSchema from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import * as Entity from "effect/cluster/Entity"
import type * as Config from "effect/Config"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as PrimaryKey from "effect/PrimaryKey"
import * as Rpc from "effect/rpc/Rpc"
import * as Schema from "effect/Schema"
import { GitHubCommitSha, GitHubRepositoryDatabaseId } from "@janitor/domain/GitHub/Id"
import { RunId, Trigger } from "@janitor/domain/PullRequestReview/Run"
import { pullRequestReviewConfig, pullRequestReviewGate } from "./Config.ts"
import { PullRequestReviewRun } from "./RunEntity.ts"
import { PullRequestReviewStore, type PullRequestReviewStoreError } from "./Store.ts"

/**
 * The per-PR scheduler entity (EFF-1651 point 5): one per pull request, it
 * owns that pull request's runs. At most one run is active; a push, close or
 * conversion to draft cancels it, and the next run starts only once the
 * cancelled run's `RunFinished` arrives or its deadline plus a margin passes.
 * It does no GitHub I/O and keeps only the active run, the last head, the
 * cooldown and the automatic run count. Payloads carry ids only.
 */

const pullRequest = {
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
}

/** The scheduler's entity id for one pull request. */
export const schedulerEntityId = (repositoryId: GitHubRepositoryDatabaseId, number: number) =>
  `${repositoryId}/${number}`

/** Opened, ready for review or pushed to: an automatic run on `headSha`. */
export const HeadChanged = Rpc.make("HeadChanged", {
  payload: { ...pullRequest, headSha: GitHubCommitSha },
})

/** Reopened: cancels the pending wipe and starts an automatic run on `headSha`. */
export const Reopened = Rpc.make("Reopened", {
  payload: { ...pullRequest, headSha: GitHubCommitSha },
})

/** Closed or merged: cancels the active run and schedules the wipe. */
export const Closed = Rpc.make("Closed", { payload: pullRequest })

export const ConvertedToDraft = Rpc.make("ConvertedToDraft", { payload: pullRequest })

/**
 * A write-access `/janitor`, `Rerun` or `Forced`. The trigger carries the
 * comment id, never its text, and resets the automatic run count.
 */
export const Rerun = Rpc.make("Rerun", {
  payload: { ...pullRequest, headSha: GitHubCommitSha, trigger: Trigger },
})

/** The run entity reached a final state. Ignored unless `runId` is the active run. */
export const RunFinished = Rpc.make("RunFinished", {
  payload: { runId: RunId, finishedAt: Schema.DateTimeUtc },
})

/** The repository's PR review was disabled: cancels the active run. */
export const RepoDisabled = Rpc.make("RepoDisabled", { payload: pullRequest })

/** Sent to itself when a run starts, for the run's deadline plus a margin. */
export class RunOverduePayload extends Schema.Class<RunOverduePayload>(
  "PullRequestReviewScheduler/RunOverdue",
)({ runId: RunId, at: Schema.DateTimeUtc }) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
}
export const RunOverdue = Rpc.make("RunOverdue", { payload: RunOverduePayload })

/** Sent to itself when a push lands within the cooldown after a completed run. */
export class CooldownElapsedPayload extends Schema.Class<CooldownElapsedPayload>(
  "PullRequestReviewScheduler/CooldownElapsed",
)({ at: Schema.DateTimeUtc }) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  /** Pushes within one cooldown schedule one delivery. */
  [PrimaryKey.symbol](): string {
    return `cooldown:${DateTime.toEpochMillis(this.at)}`
  }
}
export const CooldownElapsed = Rpc.make("CooldownElapsed", { payload: CooldownElapsedPayload })

/** Sent to itself on close, after the configured days. A reopen cancels it. */
export class WipePayload extends Schema.Class<WipePayload>("PullRequestReviewScheduler/Wipe")({
  at: Schema.DateTimeUtc,
}) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  /** Keyed by its time, so a close after a reopen schedules its own wipe. */
  [PrimaryKey.symbol](): string {
    return `wipe:${DateTime.toEpochMillis(this.at)}`
  }
}
export const Wipe = Rpc.make("Wipe", { payload: WipePayload })

export const PullRequestScheduler = Entity.make("PullRequestReviewScheduler", [
  HeadChanged,
  Reopened,
  Closed,
  ConvertedToDraft,
  Rerun,
  RunFinished,
  RunOverdue,
  RepoDisabled,
  CooldownElapsed,
  Wipe,
]).annotateRpcs(ClusterSchema.Persisted, true)

/** After a completed run, automatic runs wait this long. */
const COOLDOWN = Duration.minutes(2)
/** How long past its deadline a run's `RunFinished` may take before the next run starts anyway. */
const OVERDUE_MARGIN = Duration.minutes(2)

const State = Schema.Struct({
  /** The run started last, until its `RunFinished`; `cancelled` once a `Cancel` went out. */
  active: Schema.NullOr(
    Schema.Struct({ runId: RunId, headSha: GitHubCommitSha, cancelled: Schema.Boolean }),
  ),
  /** The run to start next: the last head and what asked for it. */
  pending: Schema.NullOr(Schema.Struct({ headSha: GitHubCommitSha, trigger: Trigger })),
  /** Epoch millis before which an automatic run waits, after a completed run. */
  cooldownUntil: Schema.NullOr(Schema.Finite),
  /** Automatic runs since the last `/janitor` or wipe. */
  automaticRuns: Schema.Int,
  /** Epoch millis of the wipe a close scheduled, until a reopen cancels it. */
  wipeAt: Schema.NullOr(Schema.Finite),
})
type State = typeof State.Type

const initial: State = {
  active: null,
  pending: null,
  cooldownUntil: null,
  automaticRuns: 0,
  wipeAt: null,
}

const StateJson = Schema.fromJsonString(State)

/** What sending an entity message can fail with. */
type SendError =
  | MailboxFull
  | AlreadyProcessingMessage
  | PersistenceError
  | EntityNotAssignedToRunner

/**
 * The scheduler's handlers, with concurrency 1, over the entity's own
 * `CloudflareCluster.DurableObjectSqlClient`. Each message loads the state,
 * moves it on, saves it, and only then sends what it decided: a message that
 * is retried after a crash never starts a second run.
 */
export const PullRequestSchedulerLayer = PullRequestScheduler.toLayer(
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
    const store = yield* PullRequestReviewStore
    const runs = yield* PullRequestReviewRun.client
    const self = (yield* PullRequestScheduler.client)(entityId)
    const separator = entityId.lastIndexOf("/")
    const repositoryId = GitHubRepositoryDatabaseId.make(entityId.slice(0, separator))
    const number = Number(entityId.slice(separator + 1))
    const decode = Schema.decodeEffect(StateJson)
    const encode = Schema.encodeEffect(StateJson)

    yield* sql`CREATE TABLE IF NOT EXISTS pr_review_scheduler (
      entity_id TEXT PRIMARY KEY, state TEXT NOT NULL)`.pipe(Effect.orDie)

    const load = sql<{ state: string }>`
      SELECT state FROM pr_review_scheduler WHERE entity_id = ${entityId}`.pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeed(initial) : decode(row.state))),
    )
    const save = (state: State) =>
      Effect.flatMap(
        encode(state),
        (json) => sql`
          INSERT INTO pr_review_scheduler (entity_id, state) VALUES (${entityId}, ${json})
          ON CONFLICT (entity_id) DO UPDATE SET state = excluded.state`,
      )

    /** One message's work: the next state and the messages to send once it is saved. */
    interface Step {
      state: State
      readonly sends: Array<Effect.Effect<void, SendError>>
    }

    const step = (
      move: (
        step: Step,
        now: DateTime.Utc,
      ) => Effect.Effect<void, Config.ConfigError | PullRequestReviewStoreError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const current: Step = { state: yield* load, sends: [] }
        yield* move(current, now)
        yield* save(current.state)
        yield* Effect.forEach(current.sends, (send) => send, { discard: true })
      }).pipe(Effect.orDie)

    const cancelActive = (current: Step) => {
      const active = current.state.active
      if (active === null || active.cancelled) return
      current.state = { ...current.state, active: { ...active, cancelled: true } }
      current.sends.push(runs(active.runId).Cancel({ runId: active.runId }, { discard: true }))
    }

    /** The deployment gate and the repository flag, read again before every start. */
    const reviewing = Effect.gen(function* () {
      if (!(yield* pullRequestReviewGate)) return false
      return yield* store.isEnabled(repositoryId)
    })

    /**
     * Starts the pending run when nothing is active and, for an automatic
     * run, the cooldown is over; past the run cap it is skipped instead.
     */
    const release = (current: Step, now: DateTime.Utc) =>
      Effect.gen(function* () {
        const { active, pending, cooldownUntil } = current.state
        if (active !== null || pending === null) return
        const automatic = pending.trigger._tag === "Automatic"
        if (automatic && cooldownUntil !== null && cooldownUntil > DateTime.toEpochMillis(now)) {
          const at = DateTime.makeUnsafe(cooldownUntil)
          current.sends.push(
            self.CooldownElapsed(new CooldownElapsedPayload({ at }), { discard: true }),
          )
          return
        }
        current.state = { ...current.state, pending: null }
        if (!(yield* reviewing)) return
        const config = yield* pullRequestReviewConfig
        const run = {
          runId: RunId.make(crypto.randomUUID()),
          repositoryId,
          number,
          headSha: pending.headSha,
          trigger: pending.trigger,
        }
        if (automatic && current.state.automaticRuns >= config.maxAutomaticRuns) {
          current.sends.push(runs(run.runId).Skip({ ...run, reason: "run_cap" }, { discard: true }))
          return
        }
        current.state = {
          ...current.state,
          active: { runId: run.runId, headSha: run.headSha, cancelled: false },
          automaticRuns: current.state.automaticRuns + (automatic ? 1 : 0),
        }
        const overdue = DateTime.addDuration(now, Duration.sum(config.runDeadline, OVERDUE_MARGIN))
        current.sends.push(
          runs(run.runId).Start(run, { discard: true }),
          self.RunOverdue(new RunOverduePayload({ runId: run.runId, at: overdue }), {
            discard: true,
          }),
        )
      })

    /** A new head to review: a push during a run cancels it, and the newest head wins. */
    const queue = (
      current: Step,
      now: DateTime.Utc,
      headSha: GitHubCommitSha,
      trigger: Trigger,
    ) => {
      const active = current.state.active
      // A repeated event for the head under review leaves its run going.
      if (
        trigger._tag === "Automatic" &&
        active !== null &&
        !active.cancelled &&
        active.headSha === headSha
      )
        return Effect.void
      cancelActive(current)
      current.state = { ...current.state, pending: { headSha, trigger } }
      return release(current, now)
    }

    /** The active run ended, by its `RunFinished` or by running past its deadline. */
    const finished = (current: Step, now: DateTime.Utc, runId: RunId, finishedAt: DateTime.Utc) => {
      const active = current.state.active
      if (active === null || active.runId !== runId) return Effect.void
      current.state = {
        ...current.state,
        active: null,
        // A run that completed rather than being cancelled starts the cooldown.
        cooldownUntil: active.cancelled
          ? current.state.cooldownUntil
          : DateTime.toEpochMillis(DateTime.addDuration(finishedAt, COOLDOWN)),
      }
      return release(current, now)
    }

    /** Close, conversion to draft or disabling: cancel the run and forget the pending one. */
    const stop = (current: Step) => {
      cancelActive(current)
      current.state = { ...current.state, pending: null }
    }

    const automatic: Trigger = { _tag: "Automatic" }

    return PullRequestScheduler.of({
      HeadChanged: ({ payload }) =>
        step((current, now) => queue(current, now, payload.headSha, automatic)),
      Reopened: ({ payload }) =>
        step((current, now) => {
          current.state = { ...current.state, wipeAt: null }
          return queue(current, now, payload.headSha, automatic)
        }),
      Closed: () =>
        step((current, now) =>
          Effect.gen(function* () {
            stop(current)
            const config = yield* pullRequestReviewConfig
            const at = DateTime.addDuration(now, config.schedulerWipeAfterClose)
            current.state = { ...current.state, wipeAt: DateTime.toEpochMillis(at) }
            current.sends.push(self.Wipe(new WipePayload({ at }), { discard: true }))
          }),
        ),
      ConvertedToDraft: () => step((current) => Effect.sync(() => stop(current))),
      RepoDisabled: () => step((current) => Effect.sync(() => stop(current))),
      Rerun: ({ payload }) =>
        step((current, now) => {
          // A `/janitor` re-run resets the automatic run count.
          current.state = { ...current.state, automaticRuns: 0 }
          return queue(current, now, payload.headSha, payload.trigger)
        }),
      RunFinished: ({ payload }) =>
        step((current, now) => finished(current, now, payload.runId, payload.finishedAt)),
      RunOverdue: ({ payload }) =>
        step((current, now) => finished(current, now, payload.runId, now)),
      CooldownElapsed: () => step((current, now) => release(current, now)),
      Wipe: ({ payload }) =>
        Effect.gen(function* () {
          const state = yield* load
          // A reopen since the close cancelled this wipe.
          if (state.wipeAt !== DateTime.toEpochMillis(payload.at)) return
          yield* sql`DELETE FROM pr_review_scheduler WHERE entity_id = ${entityId}`
        }).pipe(Effect.orDie),
    })
  }),
  { concurrency: 1 },
)

/**
 * What the web app calls when PR review is disabled for a repository: turns
 * the flag off, then sends `RepoDisabled` to the scheduler of every pull
 * request with a running run, found through `pr_review_runs`.
 */
export const disableRepository = (repositoryId: GitHubRepositoryDatabaseId) =>
  Effect.gen(function* () {
    const store = yield* PullRequestReviewStore
    yield* store.setEnabled(repositoryId, false)
    const running = yield* store.running(repositoryId)
    const schedulers = yield* PullRequestScheduler.client
    yield* Effect.forEach(
      new Set(running.map((run) => run.number)),
      (number) =>
        schedulers(schedulerEntityId(repositoryId, number)).RepoDisabled({ repositoryId, number }),
      { discard: true },
    )
  })
