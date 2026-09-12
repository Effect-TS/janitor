import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RunnerClient } from "../Agent/RunnerClient.ts"
import { SlackConfig } from "./Config.ts"
import { SlackError, slackError, type Thread } from "./Conversation.ts"
import { enqueueOutput } from "./Outbox.ts"
import { SlackTransport } from "./Transport.ts"

export interface Output {
  readonly output_id: string
  readonly session_id: string
  readonly sequence: string
  readonly kind: "progress" | "response" | "error" | "question"
  readonly text: string
  readonly state: "pending" | "uncertain" | "sent"
  readonly message_ts: string | null
  readonly error: string | null
  readonly reconcile_cursor: string
}
const Fields = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
})

export class SlackDelivery extends Context.Service<
  SlackDelivery,
  {
    readonly catchUp: (sessionId: string) => Effect.Effect<void, SlackError>
    readonly deliver: (sessionId: string) => Effect.Effect<void, SlackError>
    readonly processDue: Effect.Effect<void, SlackError>
    readonly inspect: (sessionId: string) => Effect.Effect<ReadonlyArray<Output>, SlackError>
  }
>()("@janitor/cluster/Slack/Delivery") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const runner = yield* RunnerClient
      const transport = yield* SlackTransport
      const config = yield* SlackConfig
      const inspect = (sessionId: string) =>
        sql<Output>`SELECT * FROM slack_output WHERE session_id=${sessionId} ORDER BY sequence`.pipe(
          slackError,
        )
      const catchUp = (sessionId: string) =>
        Effect.gen(function* () {
          const [thread] =
            yield* sql<Thread>`SELECT * FROM slack_thread WHERE session_id=${sessionId} AND workspace_id=${config.workspaceId} AND state='ready'`
          if (!thread) return
          const page = yield* runner.readEvents(sessionId, Number(thread.publication_cursor), 200)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [current] =
                yield* sql<Thread>`SELECT * FROM slack_thread WHERE session_id=${sessionId} FOR UPDATE`
              if (!current) return
              let cursor = Number(current.publication_cursor)
              for (const event of page.events) {
                if (event.seq <= cursor) continue
                const decoded = Schema.decodeUnknownOption(Fields)(event.data)
                const fields = decoded._tag === "Some" ? decoded.value : {}
                switch (event.type) {
                  case "session.text.ended":
                    if (fields.text) yield* enqueueOutput(sql, sessionId, "response", fields.text)
                    break
                  case "session.execution.failed":
                    yield* enqueueOutput(
                      sql,
                      sessionId,
                      "error",
                      fields.error?.message ?? "The agent could not finish this turn.",
                    )
                    yield* enqueueOutput(
                      sql,
                      sessionId,
                      "progress",
                      "Work failed. See the error in this thread.",
                    )
                    break
                  case "session.execution.started":
                    yield* enqueueOutput(sql, sessionId, "progress", "Working on your request.")
                    break
                  case "session.tool.success":
                    yield* enqueueOutput(
                      sql,
                      sessionId,
                      "progress",
                      "Completed a step; continuing work.",
                    )
                    break
                  case "session.retry.scheduled":
                    yield* enqueueOutput(
                      sql,
                      sessionId,
                      "progress",
                      "Waiting to retry the model request.",
                    )
                    break
                  case "session.execution.succeeded":
                    yield* enqueueOutput(
                      sql,
                      sessionId,
                      "progress",
                      "Finished this turn. Reply here to continue.",
                    )
                    break
                  default:
                    break
                }
                cursor = event.seq
              }
              yield* sql`UPDATE slack_thread SET publication_cursor=${cursor}::bigint,publication_due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${page.execution === "working" || page.events.length > 0 ? 30 : 300}) WHERE session_id=${sessionId}`
            }),
          )
        }).pipe(slackError)
      const deliver = (sessionId: string) =>
        Effect.gen(function* () {
          const claim = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [thread] =
                yield* sql<Thread>`SELECT * FROM slack_thread WHERE session_id=${sessionId} AND workspace_id=${config.workspaceId} FOR UPDATE`
              if (!thread) return null
              const [output] =
                yield* sql<Output>`SELECT * FROM slack_output WHERE session_id=${sessionId} AND state<>'sent' ORDER BY sequence LIMIT 1 FOR UPDATE`
              if (!output) return null
              yield* sql`INSERT INTO slack_channel_delivery (workspace_id,channel_id) VALUES (${thread.workspace_id},${thread.channel_id}) ON CONFLICT DO NOTHING`
              // This reservation outlives the bounded request. A crashed sender leaves uncertain intent.
              const reserved =
                yield* sql`UPDATE slack_channel_delivery SET due_at=CLOCK_TIMESTAMP()+interval '30 seconds' WHERE workspace_id=${thread.workspace_id} AND channel_id=${thread.channel_id} AND due_at<=CLOCK_TIMESTAMP() RETURNING channel_id`
              if (reserved.length === 0) return null
              yield* sql`UPDATE slack_output SET state='uncertain' WHERE output_id=${output.output_id}`
              return { thread, output }
            }),
          )
          if (claim === null) return
          const { thread, output } = claim
          let delay = 1
          const sent = (ts: string) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE slack_output SET state='sent',message_ts=${ts},error=NULL WHERE output_id=${output.output_id}`
                if (output.kind === "progress")
                  yield* sql`UPDATE slack_thread SET progress_ts=${ts} WHERE session_id=${sessionId}`
              }),
            )
          if (output.state === "uncertain") {
            const result = yield* transport
              .replies(thread.channel_id, thread.thread_ts, output.reconcile_cursor)
              .pipe(Effect.result)
            if (result._tag === "Success") {
              const matches = result.success.messages.filter(
                (message) =>
                  message.user === config.botUserId &&
                  message.thread_ts === thread.thread_ts &&
                  message.metadata?.event_type === "janitor_output" &&
                  message.metadata.event_payload.marker === output.output_id &&
                  (output.kind !== "progress" ||
                    thread.progress_ts === null ||
                    message.ts === thread.progress_ts),
              )
              if (matches.length === 1) yield* sent(matches[0]!.ts)
              else {
                yield* sql`UPDATE slack_output SET reconcile_cursor=${result.success.cursor},error='Publication uncertain; waiting for a positive author, thread and marker match' WHERE output_id=${output.output_id}`
                delay = result.success.cursor === "" ? 300 : 1
              }
            } else {
              delay = Math.max(30, result.failure.retryAfter)
              yield* sql`UPDATE slack_output SET error=${result.failure.message} WHERE output_id=${output.output_id}`
            }
          } else {
            const result = yield* (
              output.kind === "progress" && thread.progress_ts !== null
                ? transport.update(
                    thread.channel_id,
                    thread.progress_ts,
                    output.text,
                    output.output_id,
                  )
                : transport.post(thread.channel_id, thread.thread_ts, output.text, output.output_id)
            ).pipe(Effect.result)
            if (result._tag === "Success") yield* sent(result.success)
            else {
              const error = result.failure
              delay = error.disposition === "denied" ? 300 : Math.max(1, error.retryAfter)
              yield* sql`UPDATE slack_output SET state=${error.disposition === "uncertain" ? "uncertain" : "pending"},error=${error.message} WHERE output_id=${output.output_id}`
            }
          }
          yield* sql`UPDATE slack_channel_delivery SET due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}) WHERE workspace_id=${thread.workspace_id} AND channel_id=${thread.channel_id}`
        }).pipe(slackError)
      const processDue = Effect.gen(function* () {
        const reads = yield* sql<{
          session_id: string
        }>`SELECT session_id FROM slack_thread WHERE workspace_id=${config.workspaceId} AND state='ready' AND publication_due_at<=CLOCK_TIMESTAMP() ORDER BY publication_due_at LIMIT 50`
        for (const row of reads)
          yield* catchUp(row.session_id).pipe(
            Effect.catch(
              (error) =>
                sql`UPDATE slack_thread SET warning=${error.message},publication_due_at=CLOCK_TIMESTAMP()+interval '30 seconds' WHERE session_id=${row.session_id}`,
            ),
          )
        const pending = yield* sql<{
          session_id: string
        }>`SELECT t.session_id FROM slack_thread t
          LEFT JOIN slack_channel_delivery c ON c.workspace_id=t.workspace_id AND c.channel_id=t.channel_id
          WHERE t.workspace_id=${config.workspaceId} AND (c.due_at IS NULL OR c.due_at<=CLOCK_TIMESTAMP())
            AND EXISTS (SELECT 1 FROM slack_output o WHERE o.session_id=t.session_id AND o.state<>'sent')
          ORDER BY c.due_at NULLS FIRST,t.session_id LIMIT 50`
        yield* Effect.forEach(pending, (row) => deliver(row.session_id), {
          concurrency: 4,
          discard: true,
        })
      }).pipe(slackError)
      return { inspect, catchUp, deliver, processDue }
    }),
  )
}
