// Durable runner event consumption.
//
// Each session has one persisted catch-up obligation. A catch-up reads durable
// events after the consumer's exclusive cursor, applies their projection and
// advances the cursor in one transaction, then writes the next obligation
// before releasing its lease. Active sessions are read about every thirty
// seconds; idle sessions fall back to the five-minute recovery cadence so a
// final event can never be stranded on a missed notification.
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { EVENT_PAGE_LIMIT, RunnerClient, type RunnerClientError } from "./RunnerClient.ts"
import {
  AgentSessionId,
  type EventsRead,
  type ExecutionState,
  type RunnerEvent,
} from "./RunnerProtocol.ts"

/** Wakes the catch-up singleton after new obligations are due; the cron is the guarantee. */
export const AgentCatchUpWake = Context.Reference<Effect.Effect<void>>("Agent/CatchUpWake", {
  defaultValue: () => Effect.void,
})

export const PROJECTION_CONSUMER = "projection"
export const ACTIVE_CADENCE = Duration.seconds(30)
export const IDLE_CADENCE = Duration.minutes(5)
const LEASE = Duration.seconds(60)
const MAX_PAGES_PER_CATCH_UP = 20

export class AgentProjectionError extends Schema.TaggedError<AgentProjectionError>()(
  "@janitor/cluster/Agent/AgentProjectionError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface CatchUpSummary {
  readonly sessionId: AgentSessionId
  readonly applied: number
  readonly cursor: number
  readonly execution: ExecutionState
  readonly cadence: "active" | "idle"
  readonly error: string | null
}

export interface PageApplication {
  readonly cursor: number
  readonly execution: ExecutionState
  readonly reason: string | null
}

const EventFields = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  assistantMessageID: Schema.optionalKey(Schema.String),
  ordinal: Schema.optionalKey(Schema.Int),
  reason: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
    }),
  ),
})
const decodeEventFields = Schema.decodeUnknownOption(EventFields)

const CurrentRow = Schema.Struct({
  cursor: Schema.Int,
  execution: Schema.Literals(["working", "idle", "blocked", "failed"]),
  reason: Schema.NullOr(Schema.String),
  usage_seq: Schema.NullOr(Schema.Int),
})

export class AgentEventProjection extends Context.Service<
  AgentEventProjection,
  {
    /**
     * Applies one page of events and advances the cursor. Joins the ambient
     * transaction so the projection change and the cursor commit together.
     */
    readonly applyPage: (
      sessionId: AgentSessionId,
      page: EventsRead,
    ) => Effect.Effect<PageApplication, AgentProjectionError>
    /** Reads and applies everything after the cursor, then persists the next obligation. */
    readonly catchUp: (
      sessionId: AgentSessionId,
    ) => Effect.Effect<CatchUpSummary, AgentProjectionError>
    /** Claims due obligations and catches each up; returns what ran. */
    readonly processDue: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<CatchUpSummary>, AgentProjectionError>
    /** Milliseconds until the earliest unclaimed obligation is due, or null when none exist. */
    readonly nextDueIn: Effect.Effect<number | null, AgentProjectionError>
  }
>()("@janitor/cluster/Agent/AgentEventProjection") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const runner = yield* RunnerClient
      const decodeCurrent = Schema.decodeUnknownEffect(Schema.Array(CurrentRow))
      const wrap =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
          Effect.mapError(
            effect,
            (error) => new AgentProjectionError({ operation, message: describeError(error) }),
          )

      const applyPage = Effect.fn("AgentEventProjection.applyPage")(function* (
        sessionId: AgentSessionId,
        page: EventsRead,
      ) {
        const rows = yield* sql`
          SELECT COALESCE(c.cursor, 0)::int AS cursor, p.execution, p.reason, p.usage_seq::int AS usage_seq
          FROM agent_session_projection p
          LEFT JOIN agent_event_cursor c ON c.session_id = p.session_id AND c.consumer = ${PROJECTION_CONSUMER}
          WHERE p.session_id = ${sessionId} FOR UPDATE OF p
        `.pipe(Effect.flatMap(decodeCurrent), wrap("applyPage"))
        const current = rows[0]
        if (current === undefined)
          return yield* new AgentProjectionError({
            operation: "applyPage",
            message: `No projection for ${sessionId}`,
          })
        let execution: ExecutionState = current.execution
        let reason = current.reason
        let cursor = current.cursor
        let activity: number | null = null
        for (const event of page.events) {
          // Replay below the cursor is harmless; gaps are valid.
          if (event.seq <= cursor) continue
          const data = decodeEventFields(event.data)
          const fields = data._tag === "Some" ? data.value : {}
          switch (event.type) {
            case "session.execution.started":
              execution = "working"
              reason = null
              activity = event.created
              break
            case "session.execution.succeeded":
              execution = "idle"
              reason = null
              activity = event.created
              break
            case "session.execution.interrupted":
              // Shutdown interruption is recovered natively; explicit stops leave the session idle.
              execution = fields.reason === "shutdown" ? "working" : "idle"
              reason = fields.reason === "shutdown" ? "recovering after interruption" : null
              activity = event.created
              break
            case "session.execution.failed":
              execution = "failed"
              reason = fields.error?.message ?? "execution failed"
              activity = event.created
              break
            case "session.inbox.enqueued":
              if (execution === "idle") {
                execution = "working"
                reason = "input pending"
              }
              activity = event.created
              break
            case "session.retry.scheduled":
              execution = "working"
              reason =
                fields.at === undefined
                  ? "provider retry scheduled"
                  : `provider retry at ${DateTime.formatIso(DateTime.makeUnsafe(fields.at))}`
              break
            case "session.step.ended":
            case "session.tool.success":
            case "session.tool.failed":
              activity = event.created
              break
            case "session.text.ended":
              if (fields.text !== undefined && fields.assistantMessageID !== undefined)
                yield* sql`
                  INSERT INTO agent_response (session_id, seq, assistant_message_id, ordinal, text, created_at)
                  VALUES (${sessionId}, ${event.seq}::bigint, ${fields.assistantMessageID}, ${fields.ordinal ?? 0}::int, ${fields.text},
                    to_timestamp(${event.created}::double precision / 1000))
                  ON CONFLICT (session_id, seq) DO NOTHING
                `.pipe(wrap("applyPage"))
              activity = event.created
              break
            default:
              break
          }
          cursor = event.seq
        }
        // Runner-side holds are not events: the read reports them, and their release too.
        if (page.execution === "blocked") {
          execution = "blocked"
          reason = page.reason
        } else if (
          current.execution === "blocked" &&
          page.events.every((event) => event.seq <= current.cursor)
        ) {
          execution = page.execution
          reason = page.reason
        }
        const usage = page.usage
        const replaceUsage =
          usage !== null && (current.usage_seq === null || usage.seq > current.usage_seq)
        yield* sql`
          UPDATE agent_session_projection SET
            execution = ${execution},
            reason = ${reason},
            last_event_seq = GREATEST(last_event_seq, ${cursor}::bigint),
            activity_at = GREATEST(COALESCE(activity_at, to_timestamp(0)), COALESCE(to_timestamp(${activity}::double precision / 1000), activity_at, to_timestamp(0))),
            freshness_at = CLOCK_TIMESTAMP(),
            usage_seq = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.seq ?? null}::bigint ELSE usage_seq END,
            usage_input = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.input ?? null}::bigint ELSE usage_input END,
            usage_output = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.output ?? null}::bigint ELSE usage_output END,
            usage_reasoning = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.reasoning ?? null}::bigint ELSE usage_reasoning END,
            usage_cache_read = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.cacheRead ?? null}::bigint ELSE usage_cache_read END,
            usage_cache_write = CASE WHEN ${replaceUsage}::boolean THEN ${usage?.cacheWrite ?? null}::bigint ELSE usage_cache_write END
          WHERE session_id = ${sessionId}
        `.pipe(wrap("applyPage"))
        yield* sql`
          INSERT INTO agent_event_cursor (session_id, consumer, cursor) VALUES (${sessionId}, ${PROJECTION_CONSUMER}, ${cursor}::bigint)
          ON CONFLICT (session_id, consumer) DO UPDATE SET cursor = GREATEST(agent_event_cursor.cursor, EXCLUDED.cursor)
        `.pipe(wrap("applyPage"))
        return { cursor, execution, reason }
      })

      const cursorOf = (sessionId: AgentSessionId) =>
        sql<{ cursor: number }>`
          SELECT cursor FROM agent_event_cursor WHERE session_id = ${sessionId} AND consumer = ${PROJECTION_CONSUMER}
        `.pipe(
          Effect.map((rows) => Number(rows[0]?.cursor ?? 0)),
          wrap("catchUp"),
        )

      const markBlocked = (sessionId: AgentSessionId, reason: string) =>
        sql`
          UPDATE agent_session_projection SET execution = 'blocked', reason = ${reason}, freshness_at = CLOCK_TIMESTAMP()
          WHERE session_id = ${sessionId}
        `.pipe(wrap("catchUp"))

      const finish = (
        sessionId: AgentSessionId,
        lease: string,
        cadence: "active" | "idle",
        error: string | null,
      ) =>
        sql`
          UPDATE agent_catchup SET
            due_at = CLOCK_TIMESTAMP() + make_interval(secs => ${Duration.toSeconds(cadence === "active" ? ACTIVE_CADENCE : IDLE_CADENCE)}),
            cadence = ${cadence},
            last_read_at = CASE WHEN ${error}::text IS NULL THEN CLOCK_TIMESTAMP() ELSE last_read_at END,
            last_error = ${error}::text,
            lease_token = NULL, lease_until = NULL
          WHERE session_id = ${sessionId} AND lease_token = ${lease}
        `.pipe(wrap("catchUp"))

      /** The work between lease acquisition and obligation persistence. */
      const run = Effect.fn("AgentEventProjection.run")(function* (
        sessionId: AgentSessionId,
        lease: string,
      ) {
        let applied = 0
        let cursor = yield* cursorOf(sessionId)
        const previousRows = yield* sql<{ execution: ExecutionState }>`
          SELECT execution FROM agent_session_projection WHERE session_id = ${sessionId}
        `.pipe(wrap("catchUp"))
        let execution: ExecutionState = previousRows[0]?.execution ?? "idle"
        let error: string | null = null
        for (let pages = 0; pages < MAX_PAGES_PER_CATCH_UP; pages++) {
          const read = yield* runner
            .readEvents(sessionId, cursor, EVENT_PAGE_LIMIT)
            .pipe(Effect.result)
          if (read._tag === "Failure") {
            const failure: RunnerClientError = read.failure
            error = failure.message
            // A session the runner has not created yet is pending, not held.
            if (failure.code === "blocked" || failure.code === "stale_generation")
              yield* markBlocked(sessionId, failure.reason ?? failure.message)
            break
          }
          const page = read.success
          const result = yield* sql.withTransaction(applyPage(sessionId, page)).pipe(
            Effect.mapError((cause) =>
              cause instanceof AgentProjectionError
                ? cause
                : new AgentProjectionError({
                    operation: "catchUp",
                    message: describeError(cause),
                  }),
            ),
          )
          applied += page.events.filter((event: RunnerEvent) => event.seq > cursor).length
          cursor = result.cursor
          execution = result.execution
          if (page.events.length === 0 || page.synced === null || page.next >= page.synced) break
        }
        // A read that applied events keeps the active cadence for one more read, so the
        // obligation persisted here still covers a final event committed just after it.
        const cadence: "active" | "idle" =
          error !== null || execution === "working" || execution === "blocked" || applied > 0
            ? "active"
            : "idle"
        yield* finish(sessionId, lease, cadence, error)
        return { sessionId, applied, cursor, execution, cadence, error } satisfies CatchUpSummary
      })

      const claim = (sessionId: AgentSessionId | null, limit: number, lease: string) =>
        sql<{ session_id: AgentSessionId }>`
          WITH due AS (
            SELECT session_id FROM agent_catchup
            WHERE (lease_until IS NULL OR lease_until <= CLOCK_TIMESTAMP())
              AND (${sessionId}::text IS NULL OR session_id = ${sessionId})
              AND (${sessionId}::text IS NOT NULL OR due_at <= CLOCK_TIMESTAMP())
            ORDER BY due_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
          )
          UPDATE agent_catchup AS c SET lease_token = ${lease},
            lease_until = CLOCK_TIMESTAMP() + make_interval(secs => ${Duration.toSeconds(LEASE)})
          FROM due WHERE c.session_id = due.session_id
          RETURNING c.session_id
        `.pipe(wrap("catchUp"))

      const catchUp = Effect.fn("AgentEventProjection.catchUp")(function* (
        sessionId: AgentSessionId,
      ) {
        // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
        const lease = crypto.randomUUID()
        const claimed = yield* claim(sessionId, 1, lease)
        if (claimed.length === 0) {
          const rows = yield* sql<{ cursor: number }>`
            SELECT COALESCE(cursor, 0) AS cursor FROM agent_event_cursor WHERE session_id = ${sessionId} AND consumer = ${PROJECTION_CONSUMER}
          `.pipe(wrap("catchUp"))
          return {
            sessionId,
            applied: 0,
            cursor: Number(rows[0]?.cursor ?? 0),
            execution: "idle",
            cadence: "active",
            error: "another catch-up holds the lease",
          } satisfies CatchUpSummary
        }
        return yield* run(sessionId, lease)
      })

      const processDue = Effect.fn("AgentEventProjection.processDue")(function* (limit: number) {
        // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
        const lease = crypto.randomUUID()
        const claimed = yield* claim(null, limit, lease)
        return yield* Effect.forEach(
          claimed,
          (row) =>
            run(row.session_id, lease).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Agent catch-up failed", cause).pipe(
                  Effect.annotateLogs({ sessionId: row.session_id }),
                  Effect.andThen(finish(row.session_id, lease, "active", "catch-up failed")),
                  Effect.as({
                    sessionId: row.session_id,
                    applied: 0,
                    cursor: 0,
                    execution: "working" as const,
                    cadence: "active" as const,
                    error: "catch-up failed",
                  }),
                ),
              ),
            ),
          { concurrency: 4 },
        )
      })

      const nextDueIn = sql<{ delay: number | null }>`
        SELECT GREATEST(0, EXTRACT(EPOCH FROM (MIN(due_at) - CLOCK_TIMESTAMP())) * 1000)::int AS delay
        FROM agent_catchup WHERE lease_until IS NULL OR lease_until <= CLOCK_TIMESTAMP()
        HAVING COUNT(*) > 0
      `.pipe(
        Effect.map((rows) =>
          rows[0]?.delay === undefined || rows[0].delay === null ? null : Number(rows[0].delay),
        ),
        wrap("nextDueIn"),
      )

      return { applyPage, catchUp, processDue, nextDueIn }
    }),
  )
}
