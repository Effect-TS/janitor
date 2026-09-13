import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export type OutputKind = "progress" | "response" | "error" | "question"
/** Split at code point boundaries, leaving room below Slack's message limits. */
export const chunks = (text: string): ReadonlyArray<string> => {
  const result: string[] = []
  let chunk = ""
  let size = 0
  const encoder = new TextEncoder()
  for (const character of text) {
    const bytes = encoder.encode(character).length
    if (size + bytes > 3900) {
      result.push(chunk)
      chunk = ""
      size = 0
    }
    chunk += character
    size += bytes
  }
  if (chunk !== "") result.push(chunk)
  return result
}
/** Caller owns the thread transaction/lock. Never change an output that might have been sent. */
export const enqueueOutput = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  kind: OutputKind,
  text: string,
) =>
  Effect.gen(function* () {
    const parts = chunks(text)
    if (kind === "progress" && parts.length === 1) {
      const replaced =
        yield* sql`UPDATE slack_output SET text=${text} WHERE kind='progress' AND state='pending' AND output_id=(
      SELECT output_id FROM slack_output WHERE session_id=${sessionId} ORDER BY sequence DESC LIMIT 1
    ) RETURNING output_id`
      if (replaced.length > 0) return
    }
    for (const chunk of parts) {
      const [row] = yield* sql<{
        sequence: string
      }>`UPDATE slack_thread SET next_output=next_output+1 WHERE session_id=${sessionId} RETURNING (next_output-1)::text AS sequence`
      yield* sql`INSERT INTO slack_output (session_id,sequence,kind,text) VALUES (${sessionId},${row!.sequence}::bigint,${kind},${chunk})`
    }
  })
