import * as Effect from "effect/Effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { chunks, enqueueOutput, type OutputKind } from "../Slack/Outbox.ts"

/** The event consumer owns the cursor transaction. Source determines the reply destination. */
export const enqueueAgentOutput = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  contribution: string | null,
  kind: OutputKind,
  text: string,
  overall = false,
) =>
  Effect.gen(function* () {
    if (!contribution?.startsWith("github:"))
      return yield* enqueueOutput(sql, sessionId, kind, text)
    if (kind === "progress") return
    const [feedback] = yield* sql<{
      inline_target: string | null
    }>`SELECT inline_target FROM github_feedback WHERE session_id=${sessionId} AND contribution_key=${contribution}`
    if (!feedback) return
    for (const chunk of chunks(text))
      yield* sql`INSERT INTO github_feedback_output (session_id,inline_target,text) VALUES (${sessionId},${overall ? null : feedback.inline_target},${chunk})`
  })
