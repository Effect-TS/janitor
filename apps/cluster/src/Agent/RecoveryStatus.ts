// Recovery health for one session, read the same way by every viewer.
//
// The scans own their bookkeeping (cursors, leases, due times); this reads
// only what a teammate can act on: when a scan last completed, whether it is
// late, whether its results are all in, what it is retrying past, and what it
// can never bring back.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { RecoveryStatus } from "@janitor/domain/Agent/Observation"
import type { AgentSessionId } from "./RunnerProtocol.ts"

/**
 * Scans run every five minutes; a scan more than two cycles behind is late
 * enough to say so without flickering at the boundary of a normal cycle.
 */
export const OVERDUE_AFTER_SECONDS = 600

/** The Slack scan's standing limit: it can only read what is still in the thread. */
export const SLACK_GAP =
  "Deleted uncaptured text and never-received start mentions cannot be recovered"

const Row = Schema.Struct({
  platform: Schema.Literals(["slack", "github"]),
  completed_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  overdue: Schema.Boolean,
  incomplete: Schema.Boolean,
  hydrating: Schema.Int,
  warning: Schema.NullOr(Schema.String),
  gap: Schema.NullOr(Schema.String),
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))

export const recoveryStatus = (
  sql: SqlClient.SqlClient,
  sessionId: AgentSessionId,
): Effect.Effect<ReadonlyArray<RecoveryStatus>, { readonly message: string }> =>
  sql`
    WITH hydration AS (
      -- Feedback contributions whose comments are still being fetched; the
      -- warning shown is the one due to retry soonest.
      SELECT COUNT(*)::int AS pending,
        (array_agg(warning ORDER BY due_at) FILTER (WHERE warning IS NOT NULL))[1] AS warning
      FROM github_feedback WHERE session_id = ${sessionId} AND state = 'pending'
    )
    SELECT 'github' AS platform, r.completed_at,
      r.completed_at IS NULL OR r.completed_at < CLOCK_TIMESTAMP() - make_interval(secs => ${OVERDUE_AFTER_SECONDS}) AS overdue,
      r.cursor <> '' OR EXISTS (
        SELECT 1 FROM github_recovery_attempt a JOIN agent_session s ON s.repository_id = a.repository_id
        WHERE s.session_id = ${sessionId} AND a.state = 'pending'
      ) AS incomplete,
      h.pending AS hydrating, COALESCE(r.warning, h.warning) AS warning, r.gap
    FROM platform_recovery r, hydration h WHERE r.scan_id = 'github'
    UNION ALL
    SELECT 'slack', recovery_completed_at,
      state = 'ready' AND (recovery_completed_at IS NULL OR recovery_completed_at < CLOCK_TIMESTAMP() - make_interval(secs => ${OVERDUE_AFTER_SECONDS})),
      recovery_cursor <> '', 0, recovery_warning, ${SLACK_GAP}
    FROM slack_thread WHERE session_id = ${sessionId}
  `.pipe(
    Effect.flatMap(decodeRows),
    Effect.map((rows) =>
      rows.map(({ completed_at, ...row }) => ({ ...row, completedAt: completed_at })),
    ),
  )
