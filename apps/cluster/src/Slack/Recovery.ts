import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SlackConfig } from "./Config.ts"
import { SlackConversation, SlackError, slackError, type Thread } from "./Conversation.ts"
import { SlackTransport, SlackTransportError } from "./Transport.ts"
import { compareTimestamp } from "./Processor.ts"

export class SlackRecovery extends Context.Service<
  SlackRecovery,
  {
    readonly processDue: Effect.Effect<void, SlackError>
  }
>()("Slack/Recovery") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* SlackConfig
      const transport = yield* SlackTransport
      const conversation = yield* SlackConversation
      const processDue = Effect.gen(function* () {
        const token = yield* Effect.sync(() => crypto.randomUUID())
        const threads = yield* sql<
          Thread & {
            recovery_cursor: string
            recovery_oldest: string | null
            recovery_highwater: string | null
          }
        >`UPDATE slack_thread SET recovery_lease_token=${token},recovery_lease_until=CLOCK_TIMESTAMP()+interval '60 seconds'
        WHERE session_id IN (SELECT session_id FROM slack_thread WHERE workspace_id=${config.workspaceId} AND state='ready' AND recovery_due_at<=CLOCK_TIMESTAMP() AND (recovery_lease_until IS NULL OR recovery_lease_until<CLOCK_TIMESTAMP()) ORDER BY recovery_due_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`
        for (const thread of threads) {
          const result = yield* Effect.gen(function* () {
            // Re-read the known thread, including the previous scan's messages. Immutable contribution keys provide overlap deduplication.
            const page = yield* transport.replies(
              thread.channel_id,
              thread.thread_ts,
              thread.recovery_cursor,
              undefined,
              thread.recovery_oldest ?? thread.boundary_ts,
            )
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([thread.workspace_id, thread.channel_id, thread.thread_ts])},0))`
                const owned =
                  yield* sql`SELECT 1 FROM slack_thread WHERE session_id=${thread.session_id} AND recovery_lease_token=${token} FOR UPDATE`
                if (owned.length === 0) return
                let highwater = thread.recovery_highwater ?? thread.boundary_ts
                for (const message of [...page.messages].sort((a, b) =>
                  compareTimestamp(a.ts, b.ts),
                )) {
                  if (
                    message.thread_ts === thread.thread_ts &&
                    compareTimestamp(message.ts, highwater) > 0
                  )
                    highwater = message.ts
                  if (
                    !message.user ||
                    message.user === config.botUserId ||
                    message.bot_id ||
                    message.subtype ||
                    message.edited ||
                    message.thread_ts !== thread.thread_ts ||
                    compareTimestamp(message.ts, thread.boundary_ts) <= 0
                  )
                    continue
                  yield* conversation.record(
                    `recovery:${thread.channel_id}:${message.ts}`,
                    message,
                    {
                      type: "message",
                      channel: thread.channel_id,
                      thread_ts: thread.thread_ts,
                      ts: message.ts,
                      user: message.user,
                      text: message.text ?? "",
                    },
                  )
                }
                const [seconds, fraction = "0"] = highwater.split(".")
                const overlap = `${BigInt(seconds!) - 300n}.${fraction}`
                const oldest =
                  compareTimestamp(overlap, thread.boundary_ts) > 0 ? overlap : thread.boundary_ts
                yield* sql`UPDATE slack_thread SET recovery_highwater=${highwater},recovery_oldest=CASE WHEN ${page.cursor}='' THEN ${oldest} ELSE recovery_oldest END,recovery_cursor=${page.cursor},recovery_completed_at=CASE WHEN ${page.cursor}='' THEN CLOCK_TIMESTAMP() ELSE recovery_completed_at END,recovery_due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${page.cursor === "" ? 300 : 2}),recovery_warning=NULL,recovery_lease_until=NULL,recovery_lease_token=NULL WHERE session_id=${thread.session_id}`
              }),
            )
          }).pipe(Effect.result)
          if (result._tag === "Failure") {
            const error = result.failure
            yield* sql`UPDATE slack_thread SET recovery_warning=${error.message},recovery_due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${error instanceof SlackTransportError ? Math.max(30, error.retryAfter) : 30}),recovery_lease_until=NULL,recovery_lease_token=NULL WHERE session_id=${thread.session_id} AND recovery_lease_token=${token}`
            // A rate limit applies to other threads too.
            if (error instanceof SlackTransportError && error.disposition === "retry")
              yield* sql`UPDATE slack_thread SET recovery_due_at=GREATEST(recovery_due_at,CLOCK_TIMESTAMP()+make_interval(secs=>${Math.max(30, error.retryAfter)})) WHERE workspace_id=${config.workspaceId}`
          }
        }
      }).pipe(slackError)
      return { processDue }
    }),
  )
}
