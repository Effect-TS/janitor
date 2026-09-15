// What the API does when a runner announces that a session has new events:
// hurry the reads that already exist. The thread's next Slack read and the
// session's next catch-up become due now, and the singletons that perform
// them are woken. The minute cron and the per-session cadences remain the
// guarantee; a lost notice costs latency only.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { SlackWake } from "../Slack/Conversation.ts"
import { AgentCatchUpWake } from "./EventProjection.ts"

export class RunnerNotices extends Context.Service<
  RunnerNotices,
  {
    /** Makes every read of the session due now and wakes the readers. */
    readonly hurry: (sessionId: string) => Effect.Effect<void>
  }
>()("@janitor/cluster/Agent/RunnerNotices") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const wakeSlack = yield* SlackWake
      const wakeCatchUp = yield* AgentCatchUpWake
      const hurry = (sessionId: string) =>
        Effect.gen(function* () {
          yield* sql`UPDATE slack_thread SET publication_due_at=CLOCK_TIMESTAMP() WHERE session_id=${sessionId} AND state='ready'`
          yield* sql`UPDATE agent_catchup SET due_at=CLOCK_TIMESTAMP() WHERE session_id=${sessionId}`
          yield* Effect.all([wakeSlack, wakeCatchUp], {
            concurrency: "unbounded",
            discard: true,
          }).pipe(
            Effect.timeout("1 second"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Runner notice wake failed; cron will recover", cause),
            ),
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Runner notice could not hurry the session", cause),
          ),
        )
      return { hurry }
    }),
  )
}
