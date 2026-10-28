import type { SessionSummary } from "@janitor/domain/Chat/Session"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"

type IndexError = SqlError.SqlError | Schema.SchemaError

/**
 * The chat sessions page's index, in Postgres (EFF-3021). Each session's
 * entity keeps its own row up to date as messages and turns change it, and
 * removes it once the session expires or is deleted. The transcript stays in
 * the entity's storage.
 */
export class ChatSessionIndex extends Context.Service<
  ChatSessionIndex,
  {
    /** Saves the session's row as it stands now. */
    readonly save: (summary: SessionSummary) => Effect.Effect<void, IndexError>
    readonly remove: (sessionId: string) => Effect.Effect<void, IndexError>
    readonly get: (sessionId: string) => Effect.Effect<Option.Option<SessionSummary>, IndexError>
    /** Every session, latest activity first. */
    readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, IndexError>
  }
>()("@janitor/cluster/Chat/SessionIndex/ChatSessionIndex") {
  /** Not stored yet: "Chat sessions in the web app" (EFF-3021) builds it. */
  static readonly layer: Layer.Layer<ChatSessionIndex, never, SqlClient.SqlClient> = Layer.succeed(
    this,
    {
      save: () => Effect.die("The chat session index is not stored yet (EFF-3021)"),
      remove: () => Effect.die("The chat session index is not stored yet (EFF-3021)"),
      get: () => Effect.die("The chat session index is not stored yet (EFF-3021)"),
      list: Effect.die("The chat session index is not stored yet (EFF-3021)"),
    },
  )
}
