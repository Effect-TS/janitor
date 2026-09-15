// The dashboard's read model over agent sessions.
//
// One read projection composed from its owners: Janitor's session identity
// and associations, the runner-projected execution facts and usage, and the
// delivery records. Nothing here talks to the runner or reads conversation
// history; a stale projection is reported as stale, not inferred as failure.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import {
  displayedUsage,
  type DeliveryItem,
  type SessionCursor,
  type SessionDetail,
  type SessionPage,
  type SessionSummary,
} from "@janitor/domain/Agent/Observation"
import { homeThreadUrl } from "../Slack/HomeThread.ts"
import { describeError } from "../SqlErrors.ts"
import { AgentSessionError, AgentSessionNotFound } from "./Sessions.ts"
import { AgentSessionId } from "./RunnerProtocol.ts"
import { recoveryStatus } from "./RecoveryStatus.ts"

export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

/** A thread without a session yet is waiting on the conversation to settle its repository. */
const WAITING_FOR_SELECTION = "Waiting for repository selection"

const SummaryRow = Schema.Struct({
  session_id: Schema.String,
  title: Schema.String,
  repository_id: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  channel_id: Schema.NullOr(Schema.String),
  thread_ts: Schema.NullOr(Schema.String),
  pr_number: Schema.NullOr(Schema.String),
  execution: Schema.Literals(["working", "idle", "blocked", "failed"]),
  reason: Schema.NullOr(Schema.String),
  /** The database's text form of activity_at, carried opaquely in the page cursor. */
  activity_cursor: Schema.String,
  activity_at: Schema.DateTimeUtcFromDate,
  usage_seq: Schema.NullOr(Schema.Int),
  usage_input: Schema.NullOr(Schema.Int),
  usage_output: Schema.NullOr(Schema.Int),
  usage_reasoning: Schema.NullOr(Schema.Int),
  usage_cache_read: Schema.NullOr(Schema.Int),
  usage_cache_write: Schema.NullOr(Schema.Int),
  delivery_warning: Schema.NullOr(Schema.String),
  last_read_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  last_error: Schema.NullOr(Schema.String),
  runner_state: Schema.NullOr(Schema.String),
  runner_error: Schema.NullOr(Schema.String),
})
type SummaryRow = typeof SummaryRow.Type

const DetailRow = Schema.Struct({
  pending_inputs: Schema.Int,
  accepted_inputs: Schema.Int,
  last_input_at: Schema.NullOr(Schema.DateTimeUtcFromDate),
  /** The error of the latest accepted input when that input was rejected; null otherwise. */
  latest_rejection: Schema.NullOr(Schema.String),
})

const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(SummaryRow))
const decodeDetails = Schema.decodeUnknownEffect(Schema.Array(DetailRow))

const summarize = (row: SummaryRow): SessionSummary => ({
  sessionId: row.session_id,
  title: row.title,
  repository:
    row.repository_id !== null && row.owner !== null && row.repo !== null
      ? { repositoryId: row.repository_id, owner: row.owner, repo: row.repo }
      : null,
  homeThread:
    row.channel_id !== null && row.thread_ts !== null
      ? { platform: "slack", url: homeThreadUrl(row.channel_id, row.thread_ts) }
      : null,
  pullRequests:
    row.pr_number !== null && row.owner !== null && row.repo !== null
      ? [
          {
            number: Number(row.pr_number),
            url: `https://github.com/${row.owner}/${row.repo}/pull/${row.pr_number}`,
          },
        ]
      : [],
  execution: row.execution,
  reason: row.reason,
  activityAt: row.activity_at,
  usage:
    row.usage_seq === null
      ? null
      : displayedUsage({
          input: row.usage_input ?? 0,
          output: row.usage_output ?? 0,
          reasoning: row.usage_reasoning ?? 0,
          cacheRead: row.usage_cache_read ?? 0,
          cacheWrite: row.usage_cache_write ?? 0,
        }),
  deliveryWarning: row.delivery_warning,
  freshness: { readAt: row.last_read_at, error: row.last_error },
})

export interface ListRequest {
  readonly cursor: SessionCursor | null
  readonly limit: number
}

export class SessionObservation extends Context.Service<
  SessionObservation,
  {
    /** Working sessions first, then latest meaningful activity, then session ID; keyset paged. */
    readonly list: (request: ListRequest) => Effect.Effect<SessionPage, AgentSessionError>
    readonly detail: (
      sessionId: string,
    ) => Effect.Effect<SessionDetail, AgentSessionError | AgentSessionNotFound>
  }
>()("@janitor/cluster/Agent/SessionObservation") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const wrap =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
          Effect.mapError(
            effect,
            (error) => new AgentSessionError({ operation, message: describeError(error) }),
          )

      // Sessions and pending threads share one identity. A thread with no
      // session yet is shown waiting for its repository; a fenced session or
      // a redirected thread is not a session anyone can observe. A paused or
      // inaccessible repository fences new repository work, so its sessions
      // read as blocked with that reason ahead of anything the runner says.
      const summaries = (sessionId: string | null, cursor: SessionCursor | null, limit: number) =>
        sql`
          WITH base AS (
            SELECT COALESCE(a.session_id, t.session_id) AS session_id,
              COALESCE(a.title, 'Slack conversation') AS title,
              COALESCE(a.repository_id, t.repository_id) AS repository_id,
              a.runner_state, a.runner_error,
              t.channel_id, t.thread_ts, t.pr_number, t.warning AS thread_warning, t.delivery_warning,
              CASE
                WHEN a.session_id IS NULL OR a.runner_state = 'blocked' OR f.block_reason IS NOT NULL
                  THEN 'blocked'
                ELSE COALESCE(p.execution, 'idle')
              END AS execution,
              CASE
                WHEN a.session_id IS NULL THEN COALESCE(t.warning, ${WAITING_FOR_SELECTION})
                WHEN f.block_reason IS NOT NULL THEN f.block_reason
                WHEN a.runner_state = 'blocked' THEN COALESCE(a.runner_error, 'The runner refused work')
                ELSE p.reason
              END AS reason,
              COALESCE(p.activity_at, a.created_at, to_timestamp(t.thread_ts::numeric)) AS activity_key,
              p.usage_seq::int AS usage_seq, p.usage_input::int AS usage_input, p.usage_output::int AS usage_output,
              p.usage_reasoning::int AS usage_reasoning, p.usage_cache_read::int AS usage_cache_read,
              p.usage_cache_write::int AS usage_cache_write,
              c.last_read_at, c.last_error
            FROM agent_session a
            FULL JOIN slack_thread t ON t.session_id = a.session_id
            LEFT JOIN agent_session_projection p ON p.session_id = a.session_id
            LEFT JOIN agent_catchup c ON c.session_id = a.session_id
            LEFT JOIN LATERAL (
              SELECT CASE WHEN a.repository_id IS NULL THEN NULL ELSE repository_block_reason(a.repository_id) END AS block_reason
            ) f ON TRUE
            WHERE (a.session_id IS NULL OR a.runner_state <> 'disconnected')
              AND (t.session_id IS NULL OR t.state <> 'redirected')
          ), ranked AS (
            SELECT b.*, CASE WHEN b.execution = 'working' THEN 0 ELSE 1 END AS rank FROM base b
          )
          SELECT d.session_id, d.title, d.repository_id, r.owner, r.repo, d.channel_id, d.thread_ts, d.pr_number,
            d.execution, d.reason, d.activity_key::text AS activity_cursor, d.activity_key AS activity_at,
            d.usage_seq, d.usage_input, d.usage_output, d.usage_reasoning, d.usage_cache_read, d.usage_cache_write,
            COALESCE(d.delivery_warning, (
              SELECT o.error FROM github_feedback_output o
              WHERE o.session_id = d.session_id AND o.state <> 'sent' AND o.error IS NOT NULL
              ORDER BY o.sequence LIMIT 1
            )) AS delivery_warning,
            d.last_read_at, d.last_error, d.runner_state, d.runner_error
          FROM ranked d LEFT JOIN github_repository r ON r.repository_id = d.repository_id
          WHERE (${sessionId}::text IS NULL OR d.session_id = ${sessionId})
            AND (${cursor === null}::boolean
              OR d.rank > ${cursor === null || cursor.working ? 0 : 1}::int
              OR (d.rank = ${cursor === null || cursor.working ? 0 : 1}::int
                AND (d.activity_key < ${cursor?.activityAt ?? null}::timestamptz
                  OR (d.activity_key = ${cursor?.activityAt ?? null}::timestamptz AND d.session_id > ${cursor?.sessionId ?? null}::text))))
          ORDER BY d.rank, d.activity_key DESC, d.session_id
          LIMIT ${limit}
        `.pipe(Effect.flatMap(decodeSummaries))

      const list = Effect.fn("SessionObservation.list")(function* (request: ListRequest) {
        const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, request.limit))
        const rows = yield* summaries(null, request.cursor, limit + 1).pipe(wrap("list"))
        const page = rows.slice(0, limit)
        const last = page[page.length - 1]
        const cursor: SessionCursor | null =
          rows.length > limit && last !== undefined
            ? {
                working: last.execution === "working",
                activityAt: last.activity_cursor,
                sessionId: last.session_id,
              }
            : null
        return { sessions: page.map(summarize), cursor } satisfies SessionPage
      })

      const detail = Effect.fn("SessionObservation.detail")(function* (sessionId: string) {
        if (!Schema.is(AgentSessionId)(sessionId))
          return yield* new AgentSessionNotFound({ sessionId: "invalid" })
        const rows = yield* summaries(sessionId, null, 1).pipe(wrap("detail"))
        const row = rows[0]
        if (row === undefined) return yield* new AgentSessionNotFound({ sessionId })
        const inputs = yield* sql`
          SELECT COUNT(*) FILTER (WHERE handoff_state IN ('pending', 'uncertain'))::int AS pending_inputs,
            COUNT(*)::int AS accepted_inputs,
            MAX(accepted_at) AS last_input_at,
            (SELECT CASE WHEN handoff_state = 'rejected' THEN handoff_error END FROM agent_input
              WHERE session_id = ${sessionId} ORDER BY sequence DESC LIMIT 1) AS latest_rejection
          FROM agent_input WHERE session_id = ${sessionId}
        `.pipe(Effect.flatMap(decodeDetails), wrap("detail"))
        const counts = inputs[0]!
        const pendingDelivery = yield* sql<DeliveryItem>`
          SELECT 'slack' AS platform, state, error FROM slack_output
          WHERE session_id = ${sessionId} AND state <> 'sent'
          UNION ALL
          SELECT 'github', state, error FROM github_feedback_output
          WHERE session_id = ${sessionId} AND state <> 'sent'
          ORDER BY platform
        `.pipe(wrap("detail"))
        const recovery = yield* recoveryStatus(sql, sessionId).pipe(wrap("detail"))
        const summary = summarize(row)
        // Later accepted work supersedes an older rejection, as it does an older failed turn.
        const latestError =
          summary.execution === "failed"
            ? summary.reason
            : row.runner_state === "blocked"
              ? row.runner_error
              : counts.latest_rejection
        return {
          ...summary,
          pendingInputs: counts.pending_inputs,
          acceptedInputs: counts.accepted_inputs,
          lastInputAt: counts.last_input_at,
          latestError,
          pendingDelivery,
          recovery,
        } satisfies SessionDetail
      })

      return { list, detail }
    }),
  )
}
