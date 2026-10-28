import { SessionSummary } from "@janitor/domain/Chat/Session"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"

type IndexError = SqlError.SqlError | Schema.SchemaError

/** A `chat_sessions` row: JSONB columns arrive parsed, timestamps as `Date`s. */
const Row = Schema.Struct({
  ...SessionSummary.fields,
  lastActivityAt: Schema.DateTimeUtcFromDate,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

/**
 * The chat sessions page's index, in Postgres (EFF-3021). Each session's
 * entity keeps its own row up to date as messages and turns change it, and
 * removes it once the session expires or is deleted. The transcript stays in
 * the entity's storage.
 */
export class ChatSessionIndex extends Context.Service<
  ChatSessionIndex,
  {
    /** Saves the session's row as it stands now. */
    readonly save: (summary: SessionSummary) => Effect.Effect<void, IndexError>
    readonly remove: (sessionId: string) => Effect.Effect<void, IndexError>
    readonly get: (sessionId: string) => Effect.Effect<Option.Option<SessionSummary>, IndexError>
    /** Every session, latest activity first. */
    readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, IndexError>
  }
>()("@janitor/cluster/Chat/SessionIndex/ChatSessionIndex", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const select = sql.literal(`
      SELECT session_id AS "sessionId", thread, started_by AS "startedBy", turns, status,
        last_activity_at AS "lastActivityAt", usage
      FROM chat_sessions`)
    return {
      save: (summary) =>
        sql`
          INSERT INTO chat_sessions ${sql.insert({
            session_id: summary.sessionId,
            thread: JSON.stringify(summary.thread),
            started_by: JSON.stringify(summary.startedBy),
            turns: summary.turns,
            status: summary.status,
            last_activity_at: DateTime.toDateUtc(summary.lastActivityAt),
            usage: summary.usage === null ? null : JSON.stringify(summary.usage),
          })}
          ON CONFLICT (session_id) DO UPDATE SET thread = EXCLUDED.thread,
            started_by = EXCLUDED.started_by, turns = EXCLUDED.turns, status = EXCLUDED.status,
            last_activity_at = EXCLUDED.last_activity_at, usage = EXCLUDED.usage`.pipe(
          Effect.asVoid,
        ),
      remove: (sessionId) =>
        sql`DELETE FROM chat_sessions WHERE session_id = ${sessionId}`.pipe(Effect.asVoid),
      get: (sessionId) =>
        sql`${select} WHERE session_id = ${sessionId}`.pipe(
          Effect.flatMap(decodeRows),
          Effect.map((rows) => Option.fromNullishOr(rows[0])),
        ),
      list: sql`${select} ORDER BY last_activity_at DESC, session_id`.pipe(
        Effect.flatMap(decodeRows),
      ),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
