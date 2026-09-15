import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { RunnerClient } from "../Agent/RunnerClient.ts"
import { TurnEventData } from "../Agent/RunnerProtocol.ts"
import { SlackConfig } from "./Config.ts"
import { SlackError, slackError, type Thread } from "./Conversation.ts"
import { enqueueAgentOutput } from "../Agent/Output.ts"
import { interruptionBlocks, type InterruptionActions } from "./Interruption.ts"
import { enqueueOutput as enqueueSlackOutput } from "./Outbox.ts"
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
  readonly actions: InterruptionActions | null
}
const STAGE_PROGRESS = {
  preparing: "Preparing the workspace.",
  working: "Working on your request.",
  saving: "Saving the workspace.",
} as const

export class SlackDelivery extends Context.Service<
  SlackDelivery,
  {
    readonly catchUp: (sessionId: string) => Effect.Effect<void, SlackError>
    readonly deliver: (sessionId: string) => Effect.Effect<void, SlackError>
    readonly sendDue: Effect.Effect<void, SlackError>
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
              let publishedPr = current.pr_number
              let contribution = current.active_contribution
              const enqueueOutput = (
                kind: "progress" | "response" | "error" | "question",
                text: string,
                overall = false,
              ) => enqueueAgentOutput(sql, sessionId, contribution, kind, text, overall)
              const [session] = yield* sql<{
                generation: number
              }>`SELECT generation::int AS generation FROM agent_session WHERE session_id=${sessionId}`
              for (const event of page.events) {
                if (event.seq <= cursor) continue
                const decoded = Schema.decodeUnknownOption(TurnEventData)(event.data)
                const fields = decoded._tag === "Some" ? decoded.value : {}
                switch (event.type) {
                  case "turn.started":
                  case "turn.retried": {
                    const [input] = yield* sql<{
                      contribution_key: string
                    }>`SELECT contribution_key FROM agent_input WHERE session_id=${sessionId} AND runner_message_id=${fields.inputId ?? ""}`
                    if (input) contribution = input.contribution_key
                    yield* enqueueOutput("progress", STAGE_PROGRESS.preparing)
                    break
                  }
                  case "turn.stage":
                    yield* enqueueOutput(
                      "progress",
                      fields.stage === undefined
                        ? STAGE_PROGRESS.working
                        : STAGE_PROGRESS[fields.stage],
                    )
                    break
                  case "turn.completed":
                    if (fields.text) yield* enqueueOutput("response", fields.text)
                    yield* enqueueOutput("progress", "Finished this turn. Reply here to continue.")
                    break
                  case "turn.interrupted":
                  case "turn.save_failed": {
                    if (fields.inputId === undefined || fields.attempt === undefined) break
                    const text =
                      event.type === "turn.interrupted"
                        ? `This request was interrupted: ${fields.reason ?? "unknown reason"}. The workspace will be restored to the last saved state. Retry the request or skip it to continue with later messages.`
                        : `The agent finished this request but its workspace could not be saved: ${fields.reason ?? "unknown reason"}. Retry saving or skip the request.`
                    yield* enqueueSlackOutput(sql, sessionId, "question", text, {
                      sessionId,
                      generation: session?.generation ?? 1,
                      inputId: fields.inputId,
                      attempt: fields.attempt,
                    })
                    yield* enqueueOutput("progress", "Waiting for a teammate to retry or skip.")
                    break
                  }
                  case "turn.skipped":
                    yield* enqueueOutput("progress", "Skipped. Continuing with later messages.")
                    break
                  case "turn.published":
                    if (fields.publication) {
                      const pr = fields.publication
                      if (
                        pr.repositoryId === current.repository_id &&
                        (publishedPr === null || publishedPr === String(pr.number))
                      ) {
                        if (publishedPr === null) {
                          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([current.repository_id, String(pr.number)])},1))`
                          const homes =
                            yield* sql`SELECT 1 FROM slack_thread WHERE repository_id=${current.repository_id} AND pr_number=${String(pr.number)} AND session_id<>${sessionId} AND state<>'redirected'`
                          if (homes.length > 0) {
                            yield* enqueueOutput(
                              "error",
                              "This PR already belongs to another home thread. Its association needs reconciliation.",
                            )
                            break
                          }
                          yield* sql`UPDATE slack_thread SET pr_number=${String(pr.number)} WHERE session_id=${sessionId} AND pr_number IS NULL`
                        }
                        publishedPr = String(pr.number)
                        yield* enqueueOutput(
                          "response",
                          `${pr.title}\n\n${pr.body}\n\nReview: ${pr.url}\nA teammate can review and merge this PR.`,
                          true,
                        )
                      }
                    }
                    break
                  default:
                    break
                }
                cursor = event.seq
              }
              yield* sql`UPDATE slack_thread SET active_contribution=${contribution},publication_cursor=${cursor}::bigint,publication_due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${page.execution === "working" || page.events.length > 0 ? 30 : 300}) WHERE session_id=${sessionId}`
            }),
          )
        }).pipe(slackError)
      const deliver = (sessionId: string) =>
        Effect.gen(function* () {
          // Receipt acknowledgements can precede initialization; verify channel access first.
          const [destination] =
            yield* sql<Thread>`SELECT * FROM slack_thread WHERE session_id=${sessionId} AND workspace_id=${config.workspaceId}`
          if (!destination) return
          if (destination.state === "initializing") {
            const channel = yield* transport.channel(destination.channel_id)
            if (!channel.is_private || !channel.is_member) return
          }
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
          yield* sql.withTransaction(
            Effect.gen(function* () {
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
                const blocks =
                  output.actions === null
                    ? undefined
                    : interruptionBlocks(output.text, output.actions)
                const result = yield* (
                  output.kind === "progress" && thread.progress_ts !== null
                    ? transport.update(
                        thread.channel_id,
                        thread.progress_ts,
                        output.text,
                        output.output_id,
                      )
                    : transport.post(
                        thread.channel_id,
                        thread.thread_ts,
                        output.text,
                        output.output_id,
                        blocks,
                      )
                ).pipe(Effect.result)
                if (result._tag === "Success") yield* sent(result.success)
                else {
                  const error = result.failure
                  delay = error.disposition === "denied" ? 300 : Math.max(1, error.retryAfter)
                  yield* sql`UPDATE slack_output SET state=${error.disposition === "uncertain" ? "uncertain" : "pending"},error=${error.message} WHERE output_id=${output.output_id}`
                }
              }
              yield* sql`UPDATE slack_thread SET delivery_warning=(SELECT error FROM slack_output WHERE session_id=${sessionId} AND state<>'sent' ORDER BY sequence LIMIT 1) WHERE session_id=${sessionId}`
              yield* sql`UPDATE slack_channel_delivery SET due_at=CLOCK_TIMESTAMP()+make_interval(secs=>${delay}) WHERE workspace_id=${thread.workspace_id} AND channel_id=${thread.channel_id}`
            }),
          )
        }).pipe(slackError)
      const readDue = Effect.gen(function* () {
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
      }).pipe(slackError)
      const sendDue = Effect.gen(function* () {
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
      const processDue = Effect.all([readDue, sendDue], { concurrency: "unbounded", discard: true })
      return { inspect, catchUp, deliver, processDue, sendDue }
    }),
  )
}
