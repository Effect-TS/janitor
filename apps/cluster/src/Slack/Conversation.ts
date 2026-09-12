import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Teammates } from "../Teammates.ts"
import { SlackConfig } from "./Config.ts"

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", {
  message: Schema.String,
}) {}
export const slackError = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.mapError((error) => new SlackError({ message: error.message })))

export interface Message {
  readonly type: string
  readonly channel: string
  readonly user: string
  readonly ts: string
  readonly text: string
  readonly thread_ts?: string | undefined
}
export interface Thread {
  readonly session_id: string
  readonly workspace_id: string
  readonly channel_id: string
  readonly thread_ts: string
  readonly boundary_ts: string
  readonly repository_id: string | null
  readonly pr_number: string | null
  readonly state: "initializing" | "ready" | "redirected"
  readonly context: ReadonlyArray<Message> | null
  readonly context_pages: ReadonlyArray<Message>
  readonly context_cursor: string
  readonly warning: string | null
  readonly progress_ts: string | null
  readonly publication_cursor: string
}
export interface Contribution {
  readonly sequence: string
  readonly message_ts: string
  readonly text: string
  readonly author: { readonly teammateId?: string; readonly displayName?: string }
  readonly decision: "accepted" | "rejected"
  readonly forwarded: boolean
}
export interface ConversationView {
  readonly thread: Thread | null
  readonly contributions: ReadonlyArray<Contribution>
  readonly receipts: number
}

export class SlackConversation extends Context.Service<
  SlackConversation,
  {
    readonly record: (
      eventId: string,
      body: unknown,
      message: Message | null,
      retry?: string,
    ) => Effect.Effect<void, SlackError>
    readonly inspect: (
      channel: string,
      thread: string,
    ) => Effect.Effect<ConversationView, SlackError>
  }
>()("@janitor/cluster/Slack/Conversation") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const teammates = yield* Teammates
      const config = yield* SlackConfig
      const record = (eventId: string, body: unknown, message: Message | null, retry?: string) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const root = message?.thread_ts ?? message?.ts ?? null
              const receipt =
                yield* sql`INSERT INTO slack_receipt (workspace_id,event_id,channel_id,thread_ts,body,retry_number)
        VALUES (${config.workspaceId},${eventId},${message?.channel ?? null},${root},${JSON.stringify(body)}::jsonb,${retry ?? null})
        ON CONFLICT (workspace_id,event_id) DO NOTHING RETURNING event_id`
              if (receipt.length === 0) {
                yield* sql`UPDATE slack_receipt SET attempts=attempts+1,retry_number=${retry ?? null} WHERE workspace_id=${config.workspaceId} AND event_id=${eventId}`
                return
              }
              if (message === null) return
              // Serialize callback overlap and initialization without any network work under the lock.
              yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([config.workspaceId, message.channel, root])},0))`
              const existing =
                yield* sql`SELECT 1 FROM slack_contribution WHERE workspace_id=${config.workspaceId} AND channel_id=${message.channel} AND message_ts=${message.ts}`
              if (existing.length > 0) return
              const mentioned =
                message.type === "app_mention" || message.text.includes(`<@${config.botUserId}>`)
              const homes =
                yield* sql`SELECT 1 FROM slack_thread WHERE workspace_id=${config.workspaceId} AND channel_id=${message.channel} AND thread_ts=${root}`
              const authority = yield* teammates.authorize({
                platform: "slack",
                workspaceId: config.workspaceId,
                accountId: message.user,
              })
              const accepted = authority._tag === "Authorized"
              yield* sql`INSERT INTO slack_contribution (workspace_id,channel_id,thread_ts,message_ts,author_id,author,text,decision,onboarding_pending)
        VALUES (${config.workspaceId},${message.channel},${root},${message.ts},${message.user},${JSON.stringify(accepted ? { teammateId: authority.teammateId, displayName: authority.displayName } : {})}::jsonb,${message.text},${accepted ? "accepted" : "rejected"},${!accepted && (mentioned || homes.length > 0)})`
              if (!accepted) return
              if (mentioned) {
                // Hex encoding avoids delimiter collisions and stays below the runner's identity limit.
                const digest = yield* Effect.promise(() =>
                  crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(
                      JSON.stringify([config.workspaceId, message.channel, root]),
                    ),
                  ),
                )
                const sessionId = `slack_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`
                yield* sql`INSERT INTO slack_thread (session_id,workspace_id,channel_id,thread_ts,boundary_ts,context)
          VALUES (${sessionId},${config.workspaceId},${message.channel},${root},${message.ts},${root === message.ts ? "[]" : null}::jsonb)
          ON CONFLICT (workspace_id,channel_id,thread_ts) DO NOTHING`
              }
              yield* sql`UPDATE slack_thread SET due_at=LEAST(due_at,CLOCK_TIMESTAMP()) WHERE workspace_id=${config.workspaceId} AND channel_id=${message.channel} AND thread_ts=${root}`
            }),
          )
          .pipe(slackError, Effect.asVoid)
      const inspect = (channel: string, thread: string) =>
        Effect.gen(function* () {
          const threads =
            yield* sql<Thread>`SELECT * FROM slack_thread WHERE workspace_id=${config.workspaceId} AND channel_id=${channel} AND thread_ts=${thread}`
          const contributions =
            yield* sql<Contribution>`SELECT * FROM slack_contribution WHERE workspace_id=${config.workspaceId} AND channel_id=${channel} AND thread_ts=${thread} ORDER BY sequence`
          const receipts = yield* sql<{
            count: number
          }>`SELECT count(*)::int AS count FROM slack_receipt WHERE workspace_id=${config.workspaceId} AND channel_id=${channel} AND thread_ts=${thread}`
          return { thread: threads[0] ?? null, contributions, receipts: receipts[0]!.count }
        }).pipe(slackError)
      return { record, inspect }
    }),
  )
}
