// The durable maintenance barrier for controlled runner upgrades.
//
// Operators hold agent sessions before a release that changes session storage
// or execution. The barrier row exists before any session is enumerated, so a
// session started or an input accepted afterwards is withheld from dispatch
// by the handoff just the same; intake, authorization and deduplication keep
// running. Each runner is asked to persist its hold and quiesce, and only a
// runner that answered counts: an unreachable runner is retried, never
// assumed stopped. Release first verifies the deployed runner's health and
// manifest, then releases every matching hold; a session whose own checks
// fail stays held for repair while the rest resume, and disconnection during
// the hold outranks release because it deletes the hold record with the
// session. Nothing here is a teammate command or a dashboard control.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { handoffReleaseRequest } from "./Handoff.ts"
import { RunnerClient, type RunnerClientError } from "./RunnerClient.ts"
import {
  AgentSessionId,
  MaintenanceCheck,
  RUNNER_EVENT_CONTRACT,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_STATE_FAMILY,
  type RunnerHealth,
} from "./RunnerProtocol.ts"

export class AgentMaintenanceError extends Schema.TaggedError<AgentMaintenanceError>()(
  "@janitor/cluster/Agent/AgentMaintenanceError",
  { operation: Schema.String, message: Schema.String },
) {}

/** A release the deployed runner does not qualify for; every hold stays in place. */
export class MaintenanceRefused extends Schema.TaggedError<MaintenanceRefused>()(
  "@janitor/cluster/Agent/MaintenanceRefused",
  { epoch: Schema.Int, reasons: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Maintenance ${this.epoch} cannot be released: ${this.reasons.join("; ")}`
  }
}

export const BarrierState = Schema.Literals(["holding", "held", "releasing", "released"])
export type BarrierState = typeof BarrierState.Type

export const SessionHoldState = Schema.Literals([
  "requested",
  "held",
  "quiescent",
  "released",
  "refused",
])
export type SessionHoldState = typeof SessionHoldState.Type

export const SessionHold = Schema.Struct({
  sessionId: AgentSessionId,
  state: SessionHoldState,
  uncertain: Schema.Boolean,
  attempts: Schema.Int,
  lastError: Schema.NullOr(Schema.String),
  checks: Schema.NullOr(Schema.Array(MaintenanceCheck)),
})
export type SessionHold = typeof SessionHold.Type

export const MaintenanceStatus = Schema.Struct({
  epoch: Schema.Int,
  state: BarrierState,
  reason: Schema.String,
  expectedRelease: Schema.NullOr(Schema.String),
  verifiedRelease: Schema.NullOr(Schema.String),
  sessions: Schema.Array(SessionHold),
})
export type MaintenanceStatus = typeof MaintenanceStatus.Type

const BarrierRow = Schema.Struct({
  epoch: Schema.Int,
  state: BarrierState,
  reason: Schema.String,
  expected_release: Schema.NullOr(Schema.String),
  verified_release: Schema.NullOr(Schema.String),
})

const HoldRow = Schema.Struct({
  session_id: AgentSessionId,
  state: SessionHoldState,
  uncertain: Schema.Boolean,
  attempts: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
  checks: Schema.NullOr(Schema.Array(MaintenanceCheck)),
})

/** Why the deployed runner is not the one this release may be released against. */
export const healthProblems = (
  health: RunnerHealth,
  expectedRelease: string | null,
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (health.problems.length > 0)
    problems.push(`runner manifest problems: ${health.problems.join("; ")}`)
  if (health.protocol !== RUNNER_PROTOCOL_VERSION)
    problems.push(
      `runner speaks protocol ${health.protocol}; this Janitor speaks ${RUNNER_PROTOCOL_VERSION}`,
    )
  if (!health.manifest.commandProtocol.accepted.includes(RUNNER_PROTOCOL_VERSION))
    problems.push(`runner manifest does not accept protocol ${RUNNER_PROTOCOL_VERSION}`)
  if (health.manifest.events.contract !== RUNNER_EVENT_CONTRACT)
    problems.push(
      `runner emits event contract ${health.manifest.events.contract}; this Janitor consumes ${RUNNER_EVENT_CONTRACT}`,
    )
  if (health.manifest.family !== RUNNER_STATE_FAMILY)
    problems.push(
      `runner writes state family ${health.manifest.family}; this Janitor is tested against ${RUNNER_STATE_FAMILY}`,
    )
  if (expectedRelease !== null && health.release !== expectedRelease)
    problems.push(
      `runner reports release ${health.release}; the rollout expected ${expectedRelease}`,
    )
  return problems
}

export class AgentMaintenance extends Context.Service<
  AgentMaintenance,
  {
    /**
     * Establishes the barrier (or returns the active one), then asks every
     * session's runner to hold. Idempotent; repeat to retry unreachable runners.
     */
    readonly hold: (input: {
      readonly reason: string
      readonly expectedRelease?: string | undefined
    }) => Effect.Effect<MaintenanceStatus, AgentMaintenanceError>
    /**
     * Progresses the active barrier: enumerates sessions it has not asked yet,
     * requests holds and refreshes quiescence. Null when no barrier is active.
     */
    readonly advance: Effect.Effect<MaintenanceStatus | null, AgentMaintenanceError>
    /** The named barrier, or the active one when no epoch is given. */
    readonly status: (
      epoch?: number,
    ) => Effect.Effect<MaintenanceStatus | null, AgentMaintenanceError>
    /**
     * Verifies the deployed runner, then releases each of the barrier's holds.
     * Sessions whose runner refuses stay held and are named; repeating the
     * release retries them after repair.
     */
    readonly release: (input: {
      readonly epoch: number
    }) => Effect.Effect<MaintenanceStatus, AgentMaintenanceError | MaintenanceRefused>
  }
>()("@janitor/cluster/Agent/AgentMaintenance") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const runner = yield* RunnerClient
      const outbox = yield* WorkflowOutbox
      const decodeBarriers = Schema.decodeUnknownEffect(Schema.Array(BarrierRow))
      const decodeHolds = Schema.decodeUnknownEffect(Schema.Array(HoldRow))
      const wrap =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
          Effect.mapError(
            effect,
            (error) => new AgentMaintenanceError({ operation, message: describeError(error) }),
          )

      const barrier = (epoch: number | null, operation: string) =>
        (epoch === null
          ? sql`SELECT epoch::int AS epoch, state, reason, expected_release, verified_release FROM agent_maintenance WHERE state <> 'released' LIMIT 1`
          : sql`SELECT epoch::int AS epoch, state, reason, expected_release, verified_release FROM agent_maintenance WHERE epoch = ${epoch}`
        ).pipe(
          Effect.flatMap(decodeBarriers),
          Effect.map((rows) => rows[0]),
          wrap(operation),
        )

      const holds = (epoch: number, operation: string) =>
        sql`
          SELECT session_id, state, uncertain, attempts, last_error, checks
          FROM agent_session_maintenance WHERE epoch = ${epoch} ORDER BY session_id
        `.pipe(Effect.flatMap(decodeHolds), wrap(operation))

      const status = (epoch: number | null, operation: string) =>
        Effect.gen(function* () {
          const row = yield* barrier(epoch, operation)
          if (row === undefined) return null
          const sessions = yield* holds(row.epoch, operation)
          return {
            epoch: row.epoch,
            state: row.state,
            reason: row.reason,
            expectedRelease: row.expected_release,
            verifiedRelease: row.verified_release,
            sessions: sessions.map((hold) => ({
              sessionId: hold.session_id,
              state: hold.state,
              uncertain: hold.uncertain,
              attempts: hold.attempts,
              lastError: hold.last_error,
              checks: hold.checks,
            })),
          } satisfies MaintenanceStatus
        })

      const setBarrierState = (epoch: number, state: BarrierState, operation: string) =>
        sql`
          UPDATE agent_maintenance SET state = ${state}, updated_at = CLOCK_TIMESTAMP(),
            released_at = CASE WHEN ${state} = 'released' THEN CLOCK_TIMESTAMP() ELSE released_at END
          WHERE epoch = ${epoch}
        `.pipe(wrap(operation))

      const recordFailure = (
        sessionId: AgentSessionId,
        epoch: number,
        error: RunnerClientError,
        operation: string,
      ) =>
        sql`
          UPDATE agent_session_maintenance SET attempts = attempts + 1, last_error = ${error.message},
            updated_at = CLOCK_TIMESTAMP()
          WHERE session_id = ${sessionId} AND epoch = ${epoch}
        `.pipe(
          Effect.andThen(
            Effect.logWarning("Runner maintenance request failed", {
              sessionId,
              epoch,
              operation,
              message: error.message,
            }),
          ),
          wrap(operation),
        )

      /** Asks one runner to hold and records what it actually acknowledged. */
      const requestHold = (sessionId: AgentSessionId, epoch: number) =>
        Effect.gen(function* () {
          const result = yield* runner
            .maintenance(sessionId, { hold: true, epoch })
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            // A refusal is not an acknowledgement either; a disconnected session's
            // row disappears with the session and needs no hold.
            yield* recordFailure(sessionId, epoch, result.failure, "hold")
            return
          }
          const answer = result.success
          // Only a hold at this epoch counts. An answer naming another epoch is a
          // stale acknowledgement from an earlier barrier, or a newer fence.
          if (!answer.held || answer.epoch !== epoch) {
            yield* sql`
              UPDATE agent_session_maintenance SET attempts = attempts + 1,
                last_error = ${`runner reports held=${answer.held} epoch=${answer.epoch}, not epoch ${epoch}`},
                updated_at = CLOCK_TIMESTAMP()
              WHERE session_id = ${sessionId} AND epoch = ${epoch}
            `.pipe(wrap("hold"))
            return
          }
          yield* sql`
            UPDATE agent_session_maintenance SET state = ${answer.quiescent ? "quiescent" : "held"},
              uncertain = ${answer.uncertain}, last_error = NULL, attempts = attempts + 1, updated_at = CLOCK_TIMESTAMP()
            WHERE session_id = ${sessionId} AND epoch = ${epoch} AND state IN ('requested', 'held')
          `.pipe(wrap("hold"))
        })

      const advanceBarrier = (epoch: number) =>
        Effect.gen(function* () {
          // Every session not yet asked, including ones started after the barrier.
          yield* sql`
            INSERT INTO agent_session_maintenance (session_id, epoch)
            SELECT s.session_id, ${epoch} FROM agent_session s
            WHERE s.runner_state <> 'disconnected'
            ON CONFLICT DO NOTHING
          `.pipe(wrap("advance"))
          const pending = yield* sql<{ session_id: AgentSessionId }>`
            SELECT session_id FROM agent_session_maintenance
            WHERE epoch = ${epoch} AND state IN ('requested', 'held') ORDER BY session_id
          `.pipe(wrap("advance"))
          yield* Effect.forEach(pending, (row) => requestHold(row.session_id, epoch), {
            concurrency: 4,
            discard: true,
          })
          const remaining = yield* sql<{ n: number }>`
            SELECT COUNT(*)::int AS n FROM agent_session_maintenance
            WHERE epoch = ${epoch} AND state IN ('requested', 'held')
          `.pipe(wrap("advance"))
          const current = yield* barrier(epoch, "advance")
          if (current?.state === "holding" && Number(remaining[0]?.n ?? 0) === 0)
            yield* setBarrierState(epoch, "held", "advance")
          else if (current?.state === "held" && Number(remaining[0]?.n ?? 0) > 0)
            yield* setBarrierState(epoch, "holding", "advance")
        })

      const hold = Effect.fn("AgentMaintenance.hold")(function* (input: {
        readonly reason: string
        readonly expectedRelease?: string | undefined
      }) {
        // The barrier row exists before any session is read: the partial unique
        // index makes a second concurrent hold adopt the active barrier.
        yield* sql`
          INSERT INTO agent_maintenance (state, reason, expected_release)
          SELECT 'holding', ${input.reason}, ${input.expectedRelease ?? null}::text
          WHERE NOT EXISTS (SELECT 1 FROM agent_maintenance WHERE state <> 'released')
          ON CONFLICT DO NOTHING
        `.pipe(wrap("hold"))
        const active = yield* barrier(null, "hold")
        if (active === undefined)
          return yield* new AgentMaintenanceError({
            operation: "hold",
            message: "The maintenance barrier could not be established",
          })
        yield* advanceBarrier(active.epoch)
        return (yield* status(active.epoch, "hold"))!
      })

      const advance = Effect.gen(function* () {
        const active = yield* barrier(null, "advance")
        if (active === undefined || active.state === "releasing") return null
        yield* advanceBarrier(active.epoch)
        return yield* status(active.epoch, "advance")
      })

      /** Asks one runner to release this epoch and records its answer. */
      const requestRelease = (sessionId: AgentSessionId, epoch: number) =>
        Effect.gen(function* () {
          const result = yield* runner
            .maintenance(sessionId, { hold: false, epoch })
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            yield* recordFailure(sessionId, epoch, result.failure, "release")
            return false
          }
          const answer = result.success
          if (answer.held) {
            yield* sql`
              UPDATE agent_session_maintenance SET state = 'refused', checks = ${JSON.stringify(answer.checks)}::jsonb,
                uncertain = ${answer.uncertain}, attempts = attempts + 1,
                last_error = ${answer.checks
                  .filter((check) => !check.ok)
                  .map((check) => `${check.name}: ${check.detail}`)
                  .join("; ")},
                updated_at = CLOCK_TIMESTAMP()
              WHERE session_id = ${sessionId} AND epoch = ${epoch}
            `.pipe(wrap("release"))
            return false
          }
          // Withheld inputs resume in their durable order through the ordinary
          // handoff. The request is enqueued (idempotently, by its key) before the
          // row is marked released, so a failure here is retried by repeating the release.
          yield* outbox
            .enqueue(handoffReleaseRequest(sessionId, epoch))
            .pipe(
              Effect.mapError(
                (error) =>
                  new AgentMaintenanceError({ operation: "release", message: error.message }),
              ),
            )
          yield* sql`
            UPDATE agent_session_maintenance SET state = 'released', checks = ${JSON.stringify(answer.checks)}::jsonb,
              uncertain = ${answer.uncertain}, last_error = NULL, attempts = attempts + 1, updated_at = CLOCK_TIMESTAMP()
            WHERE session_id = ${sessionId} AND epoch = ${epoch}
          `.pipe(wrap("release"))
          return true
        })

      const release = Effect.fn("AgentMaintenance.release")(function* (input: {
        readonly epoch: number
      }) {
        const row = yield* barrier(input.epoch, "release")
        if (row === undefined)
          return yield* new AgentMaintenanceError({
            operation: "release",
            message: `Maintenance ${input.epoch} does not exist`,
          })
        // The deployed runner must be the release this Janitor is tested against
        // and, when the rollout named one, the release it was meant to produce.
        const health = yield* runner.health.pipe(Effect.result)
        if (health._tag === "Failure")
          return yield* new MaintenanceRefused({
            epoch: input.epoch,
            reasons: [`runner health is unavailable: ${health.failure.message}`],
          })
        const problems = healthProblems(health.success, row.expected_release)
        if (problems.length > 0)
          return yield* new MaintenanceRefused({ epoch: input.epoch, reasons: problems })
        yield* sql`
          UPDATE agent_maintenance SET verified_release = ${health.success.release}, updated_at = CLOCK_TIMESTAMP()
          WHERE epoch = ${input.epoch}
        `.pipe(wrap("release"))
        // Every affected session must have acknowledged the hold and quiesced,
        // including sessions started since the last advance: a runner that never
        // answered is not known to have stopped, so the upgrade is postponed.
        if (row.state !== "released") {
          yield* advanceBarrier(input.epoch)
          const unacknowledged = yield* sql<{
            session_id: string
            state: string
            last_error: string | null
          }>`
            SELECT session_id, state, last_error FROM agent_session_maintenance
            WHERE epoch = ${input.epoch} AND state IN ('requested', 'held') ORDER BY session_id
          `.pipe(wrap("release"))
          if (unacknowledged.length > 0)
            return yield* new MaintenanceRefused({
              epoch: input.epoch,
              reasons: unacknowledged.map(
                (hold) =>
                  `session ${hold.session_id} is ${hold.state === "requested" ? "not acknowledged" : "not quiescent"}${hold.last_error === null ? "" : ` (${hold.last_error})`}`,
              ),
            })
          yield* setBarrierState(input.epoch, "releasing", "release")
        }
        const pending = yield* sql<{ session_id: AgentSessionId }>`
          SELECT session_id FROM agent_session_maintenance
          WHERE epoch = ${input.epoch} AND state <> 'released' ORDER BY session_id
        `.pipe(wrap("release"))
        yield* Effect.forEach(pending, (hold) => requestRelease(hold.session_id, input.epoch), {
          concurrency: 4,
          discard: true,
        })
        // Refused sessions stay held on their runner and visibly blocked; the
        // barrier itself lifts so the rest of the team's work resumes. A hold that
        // did not answer the release keeps the barrier until a repeated release
        // reaches it.
        const unanswered = yield* sql<{ n: number }>`
          SELECT COUNT(*)::int AS n FROM agent_session_maintenance
          WHERE epoch = ${input.epoch} AND state = 'quiescent'
        `.pipe(wrap("release"))
        if (Number(unanswered[0]?.n ?? 0) === 0)
          yield* setBarrierState(input.epoch, "released", "release")
        return (yield* status(input.epoch, "release"))!
      })

      return {
        hold,
        advance,
        status: (epoch?: number) => status(epoch ?? null, "status"),
        release,
      }
    }),
  )
}
