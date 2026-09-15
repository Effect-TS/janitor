// Slack thread scan health for one session, read the same way by every viewer.
//
// The scan owns its bookkeeping (cursor, lease, due time); this reads only
// what a teammate can act on: when it last completed, whether it is late,
// whether its results are all in, what it is retrying past, and what it can
// never bring back. GitHub feedback arrives by webhook only; nothing scans it.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { RecoveryStatus } from "@janitor/domain/Agent/Observation"
import type { AgentSessionId } from "./RunnerProtocol.ts"

/**
 * The scan runs every five minutes; a scan more than two cycles behind is late
 * enough to say so without flickering at the boundary of a normal cycle.
 */
export const OVERDUE_AFTER_SECONDS = 600

/** The Slack scan's standing limit: it can only read what is still in the thread. */
export const SLACK_GAP =
  "Deleted uncaptured text and never-received start mentions cannot be recovered"

const Row = Schema.Struct({
  platform: Schema.Literals(["slack"]),
  completed_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  overdue: Schema.Boolean,
  incomplete: Schema.Boolean,
  warning: Schema.NullOr(Schema.String),
  gap: Schema.NullOr(Schema.String),
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

export const recoveryStatus = (
  sql: SqlClient.SqlClient,
  sessionId: AgentSessionId,
): Effect.Effect<ReadonlyArray<RecoveryStatus>, { readonly message: string }> =>
  sql`
    SELECT 'slack' AS platform, recovery_completed_at AS completed_at,
      state = 'ready' AND (recovery_completed_at IS NULL OR recovery_completed_at < CLOCK_TIMESTAMP() - make_interval(secs => ${OVERDUE_AFTER_SECONDS})) AS overdue,
      recovery_cursor <> '' AS incomplete, recovery_warning AS warning, ${SLACK_GAP} AS gap
    FROM slack_thread WHERE session_id = ${sessionId}
  `.pipe(
    Effect.flatMap(decodeRows),
    Effect.map((rows) =>
      rows.map(({ completed_at, ...row }) => ({ ...row, completedAt: completed_at })),
    ),
  )
