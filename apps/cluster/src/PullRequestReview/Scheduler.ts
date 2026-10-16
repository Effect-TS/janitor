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
import { GitHubWebhookJournalSequence } from "@janitor/domain/GitHub/WebhookJournal"
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
 * cooldown and the automatic run count, plus the newest event it handled and
 * the messages it has yet to send. Payloads carry ids only.
 */

const pullRequest = {
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
}

/** The scheduler's entity id for one pull request. */
export const schedulerEntityId = (repositoryId: GitHubRepositoryDatabaseId, number: number) =>
  `${repositoryId}/${number}`

/**
 * A webhook event, in the order janitor received it. Admissions run
 * concurrently and can finish out of order, so the scheduler ignores an event
 * older than one it already handled.
 */
const delivery = { ...pullRequest, sequence: GitHubWebhookJournalSequence }

/**
 * A new head. `oversized` means it is skipped: admission already recorded the
 * skip, and the scheduler cancels the active run and drops the queued head.
 */
const head = { ...delivery, headSha: GitHubCommitSha, oversized: Schema.Boolean }

/** Opened, ready for review or pushed to: an automatic run on `headSha`. */
export const HeadChanged = Rpc.make("HeadChanged", { payload: head })

/** Reopened: cancels the pending wipe and starts an automatic run on `headSha`. */
export const Reopened = Rpc.make("Reopened", { payload: head })

/** Closed or merged: cancels the active run and schedules the wipe. */
export const Closed = Rpc.make("Closed", { payload: delivery })

export const ConvertedToDraft = Rpc.make("ConvertedToDraft", { payload: delivery })

/**
 * A write-access `/janitor`, `Rerun` or `Forced`. The trigger carries the
 * comment id, never its text, and resets the automatic run count.
 */
export const Rerun = Rpc.make("Rerun", {
  payload: { ...delivery, headSha: GitHubCommitSha, trigger: Trigger },
})

/** The run entity reached a final state. Ignored unless `runId` is the active run. */
export const RunFinished = Rpc.make("RunFinished", {
  payload: { runId: RunId, finishedAt: Schema.DateTimeUtc },
})

/** The repository's PR review was disabled: cancels the active run. Not ordered with webhooks. */
export const RepoDisabled = Rpc.make("RepoDisabled", { payload: pullRequest })

/** Sent to itself when a run starts, for the run's deadline plus a margin. */
export class RunOverduePayload extends Schema.Class<RunOverduePayload>(
  "PullRequestReviewScheduler/RunOverdue",
)({ runId: RunId, at: Schema.DateTimeUtc }) {
  [DeliverAt.symbol](): DateTime.DateTime {
    return this.at
  }
  /** One per run, however often a crash makes the scheduler send it. */
  [PrimaryKey.symbol](): string {
    return `overdue:${this.runId}`
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

const RunPayload = Schema.Struct({
  runId: RunId,
  repositoryId: GitHubRepositoryDatabaseId,
  number: Schema.Int,
  headSha: GitHubCommitSha,
  trigger: Trigger,
})

/** A message the scheduler decided to send, kept with its state until it went out. */
const Outgoing = Schema.Union([
  Schema.TaggedStruct("Start", { run: RunPayload }),
  Schema.TaggedStruct("Skip", { run: RunPayload }),
  Schema.TaggedStruct("Cancel", { runId: RunId }),
  Schema.TaggedStruct("RunOverdue", { runId: RunId, at: Schema.Finite }),
  Schema.TaggedStruct("CooldownElapsed", { at: Schema.Finite }),
  Schema.TaggedStruct("Wipe", { at: Schema.Finite }),
])
type Outgoing = typeof Outgoing.Type

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
  /** The newest webhook event handled; older ones are ignored. */
  lastSequence: Schema.NullOr(GitHubWebhookJournalSequence),
  /**
   * Messages decided but not yet known to be sent. They are saved with the
   * state change that decided them, so a crash before the send can't lose them.
   */
  outbox: Schema.Array(Outgoing),
})
type State = typeof State.Type

const initial: State = {
  active: null,
  pending: null,
  cooldownUntil: null,
  automaticRuns: 0,
  wipeAt: null,
  lastSequence: null,
  outbox: [],
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
 * moves it on, and saves it together with the messages it decided to send.
 * Only then does it send them, and clear them once sent. A message retried
 * after a crash first sends what the interrupted attempt left; the primary
 * keys on those messages make a second send of one harmless.
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
      readonly sends: Array<Outgoing>
    }

    const send = (outgoing: Outgoing): Effect.Effect<void, SendError> => {
      switch (outgoing._tag) {
        case "Start":
          return runs(outgoing.run.runId).Start(outgoing.run, { discard: true })
        case "Skip":
          return runs(outgoing.run.runId).Skip(
            { ...outgoing.run, reason: "run_cap" },
            { discard: true },
          )
        case "Cancel":
          return runs(outgoing.runId).Cancel({ runId: outgoing.runId }, { discard: true })
        case "RunOverdue":
          return self.RunOverdue(
            new RunOverduePayload({
              runId: outgoing.runId,
              at: DateTime.makeUnsafe(outgoing.at),
            }),
            { discard: true },
          )
        case "CooldownElapsed":
          return self.CooldownElapsed(
            new CooldownElapsedPayload({ at: DateTime.makeUnsafe(outgoing.at) }),
            { discard: true },
          )
        case "Wipe":
          return self.Wipe(new WipePayload({ at: DateTime.makeUnsafe(outgoing.at) }), {
            discard: true,
          })
      }
    }
    const dispatch = (outbox: ReadonlyArray<Outgoing>) =>
      Effect.forEach(outbox, send, { discard: true })

    const step = (
      move: (
        step: Step,
        now: DateTime.Utc,
      ) => Effect.Effect<void, Config.ConfigError | PullRequestReviewStoreError>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        let state = yield* load
        // What an attempt interrupted between its save and its sends left behind.
        if (state.outbox.length > 0) {
          yield* dispatch(state.outbox)
          state = { ...state, outbox: [] }
          yield* save(state)
        }
        const current: Step = { state, sends: [] }
        yield* move(current, now)
        if (current.sends.length === 0) return yield* save(current.state)
        yield* save({ ...current.state, outbox: current.sends })
        yield* dispatch(current.sends)
        yield* save(current.state)
      }).pipe(Effect.orDie)

    /** Whether the event is newer than every one handled so far; it becomes the newest if so. */
    const inOrder = (current: Step, sequence: GitHubWebhookJournalSequence) => {
      const last = current.state.lastSequence
      if (last !== null && BigInt(sequence) <= BigInt(last)) return false
      current.state = { ...current.state, lastSequence: sequence }
      return true
    }

    const cancelActive = (current: Step) => {
      const active = current.state.active
      if (active === null || active.cancelled) return
      current.state = { ...current.state, active: { ...active, cancelled: true } }
      current.sends.push({ _tag: "Cancel", runId: active.runId })
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
          current.sends.push({ _tag: "CooldownElapsed", at: cooldownUntil })
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
          current.sends.push({ _tag: "Skip", run })
          return
        }
        current.state = {
          ...current.state,
          active: { runId: run.runId, headSha: run.headSha, cancelled: false },
          automaticRuns: current.state.automaticRuns + (automatic ? 1 : 0),
        }
        const overdue = DateTime.addDuration(now, Duration.sum(config.runDeadline, OVERDUE_MARGIN))
        current.sends.push(
          { _tag: "Start", run },
          { _tag: "RunOverdue", runId: run.runId, at: DateTime.toEpochMillis(overdue) },
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

    /**
     * Close, conversion to draft, disabling or an oversized head: cancel the
     * run and forget the pending one.
     */
    const stop = (current: Step) => {
      cancelActive(current)
      current.state = { ...current.state, pending: null }
    }

    const automatic: Trigger = { _tag: "Automatic" }

    /** A new head: queued for review, or, when oversized, a reason to stop. */
    const headChanged = (
      current: Step,
      now: DateTime.Utc,
      payload: { readonly headSha: GitHubCommitSha; readonly oversized: boolean },
    ) => {
      if (!payload.oversized) return queue(current, now, payload.headSha, automatic)
      stop(current)
      return Effect.void
    }

    return PullRequestScheduler.of({
      HeadChanged: ({ payload }) =>
        step((current, now) =>
          inOrder(current, payload.sequence) ? headChanged(current, now, payload) : Effect.void,
        ),
      Reopened: ({ payload }) =>
        step((current, now) => {
          if (!inOrder(current, payload.sequence)) return Effect.void
          current.state = { ...current.state, wipeAt: null }
          return headChanged(current, now, payload)
        }),
      Closed: ({ payload }) =>
        step((current, now) =>
          Effect.gen(function* () {
            if (!inOrder(current, payload.sequence)) return
            stop(current)
            const config = yield* pullRequestReviewConfig
            const at = DateTime.toEpochMillis(
              DateTime.addDuration(now, config.schedulerWipeAfterClose),
            )
            current.state = { ...current.state, wipeAt: at }
            current.sends.push({ _tag: "Wipe", at })
          }),
        ),
      ConvertedToDraft: ({ payload }) =>
        step((current) =>
          Effect.sync(() => {
            if (inOrder(current, payload.sequence)) stop(current)
          }),
        ),
      RepoDisabled: () => step((current) => Effect.sync(() => stop(current))),
      Rerun: ({ payload }) =>
        step((current, now) => {
          if (!inOrder(current, payload.sequence)) return Effect.void
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
          let wiped = false
          yield* step((current) =>
            Effect.sync(() => {
              // A reopen since the close cancelled this wipe.
              wiped = current.state.wipeAt === DateTime.toEpochMillis(payload.at)
            }),
          )
          if (wiped)
            yield* sql`DELETE FROM pr_review_scheduler WHERE entity_id = ${entityId}`.pipe(
              Effect.orDie,
            )
        }),
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
