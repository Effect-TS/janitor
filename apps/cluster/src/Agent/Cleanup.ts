// Durable cleanup of ended agent sessions.
//
// Explicit repository disconnection deletes a session's Janitor records in
// the disconnecting transaction and leaves one cleanup tombstone per session:
// the session identity, its generation and the remote identities the runner
// still holds. The tombstone is the queue entry and the fence. This service
// asks the runner to remove the native session, workspace and checkpoints,
// retrying with backoff while the runner is unreachable, and drops the
// tombstone only once the runner has confirmed. Nothing here depends on the
// request that disconnected the repository still being alive.
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { RunnerClient } from "./RunnerClient.ts"
import { AgentSessionId } from "./RunnerProtocol.ts"

export class AgentCleanupError extends Schema.TaggedError<AgentCleanupError>()(
  "@janitor/cluster/Agent/AgentCleanupError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CleanupOutcome {
  readonly sessionId: AgentSessionId
  readonly generation: number
  readonly completed: boolean
  readonly error: string | null
}

const LEASE = Duration.seconds(60)
const MAX_BACKOFF = Duration.minutes(5)

/** Retry delay after `attempts` failed attempts: 2s, 4s, 8s … capped at five minutes. */
export const cleanupBackoff = (attempts: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 ** Math.min(Math.max(attempts, 1), 9)), MAX_BACKOFF)

const TombstoneRow = Schema.Struct({
  session_id: AgentSessionId,
  generation: Schema.Int,
  attempts: Schema.Int,
})

export class AgentCleanup extends Context.Service<
  AgentCleanup,
  {
    /** Claims due tombstones and asks the runner to clean each up; returns what ran. */
    readonly processDue: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<CleanupOutcome>, AgentCleanupError>
    /** Milliseconds until the earliest unclaimed tombstone is due, or null when none remain. */
    readonly nextDueIn: Effect.Effect<number | null, AgentCleanupError>
  }
>()("@janitor/cluster/Agent/AgentCleanup") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const runner = yield* RunnerClient
      const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TombstoneRow))
      const wrap =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
          Effect.mapError(
            effect,
            (error) => new AgentCleanupError({ operation, message: describeError(error) }),
          )

      const claim = (limit: number, lease: string) =>
        sql`
          WITH due AS (
            SELECT session_id FROM agent_session_cleanup
            WHERE due_at <= CLOCK_TIMESTAMP()
              AND (lease_until IS NULL OR lease_until <= CLOCK_TIMESTAMP())
            ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
          )
          UPDATE agent_session_cleanup AS c SET lease_token = ${lease},
            lease_until = CLOCK_TIMESTAMP() + make_interval(secs => ${Duration.toSeconds(LEASE)})
          FROM due WHERE c.session_id = due.session_id
          RETURNING c.session_id, c.generation::int AS generation, c.attempts
        `.pipe(Effect.flatMap(decodeRows), wrap("processDue"))

      const complete = (sessionId: AgentSessionId, lease: string) =>
        sql`
          DELETE FROM agent_session_cleanup WHERE session_id = ${sessionId} AND lease_token = ${lease}
        `.pipe(wrap("processDue"))

      const retry = (sessionId: AgentSessionId, lease: string, attempts: number, error: string) =>
        sql`
          UPDATE agent_session_cleanup SET attempts = ${attempts}, last_error = ${error},
            due_at = CLOCK_TIMESTAMP() + make_interval(secs => ${Duration.toSeconds(cleanupBackoff(attempts))}),
            lease_token = NULL, lease_until = NULL
          WHERE session_id = ${sessionId} AND lease_token = ${lease}
        `.pipe(wrap("processDue"))

      const processDue = Effect.fn("AgentCleanup.processDue")(function* (limit: number) {
        // Lease tokens must be unique across isolates; platform randomness, not the PRNG.
        // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
        const lease = crypto.randomUUID()
        const claimed = yield* claim(Math.max(0, limit), lease)
        return yield* Effect.forEach(
          claimed,
          (row) =>
            Effect.gen(function* () {
              const result = yield* runner
                .cleanup(row.session_id, row.generation)
                .pipe(Effect.result)
              if (result._tag === "Success") {
                yield* complete(row.session_id, lease)
                return {
                  sessionId: row.session_id,
                  generation: row.generation,
                  completed: true,
                  error: null,
                } satisfies CleanupOutcome
              }
              // Every refusal is retried: an unreachable runner recovers, and a
              // runner that answers otherwise is a deployment problem that must
              // stay visible on the tombstone rather than strand remote state.
              const attempts = row.attempts + 1
              yield* retry(row.session_id, lease, attempts, result.failure.message)
              yield* Effect.logWarning("Agent session cleanup will retry", {
                sessionId: row.session_id,
                attempts,
                message: result.failure.message,
              })
              return {
                sessionId: row.session_id,
                generation: row.generation,
                completed: false,
                error: result.failure.message,
              } satisfies CleanupOutcome
            }),
          { concurrency: 4 },
        )
      })

      const nextDueIn = sql<{ delay: number | null }>`
        SELECT GREATEST(0, EXTRACT(EPOCH FROM (MIN(due_at) - CLOCK_TIMESTAMP())) * 1000)::int AS delay
        FROM agent_session_cleanup WHERE lease_until IS NULL OR lease_until <= CLOCK_TIMESTAMP()
        HAVING COUNT(*) > 0
      `.pipe(
        Effect.map((rows) =>
          rows[0]?.delay === undefined || rows[0].delay === null ? null : Number(rows[0].delay),
        ),
        wrap("nextDueIn"),
      )

      return { processDue, nextDueIn }
    }),
  )
}
