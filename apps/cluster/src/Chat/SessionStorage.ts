import * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/sql/SqlClient"
import type { HistoryChange } from "../PullRequestReview/Agent.ts"
import { encodeMessage } from "../PullRequestReview/RunStorage.ts"
import { ChatMessage, ChatThread } from "./Platform.ts"

/**
 * A chat session's own storage, in its entity's Durable Object SQLite
 * (EFF-3018): the session's thread, its messages (deduped on the platform
 * message id) with their gate outcomes, its turns with their usage, and the
 * agent's history across turns. Every transaction is short and only runs SQL.
 */

/** What the reply gate made of a message, for the transcript. */
export const GateOutcome = Schema.TaggedUnion({
  /** It mentions the bot, so it skipped the gate. */
  Mention: {},
  /** Only "stop": it cancelled the running turn before any model saw it. */
  Stop: {},
  Passed: { probability: Schema.Finite },
  Rejected: { probability: Schema.Finite },
  /** The gate call failed, so it started nothing. */
  Failed: {},
  /** From an outsider or a bot, or backfilled: never gated, context only. */
  Context: {},
  /** Arrived while the kill switch was on: kept as context. */
  SwitchedOff: {},
})
export type GateOutcome = typeof GateOutcome.Type

/** A turn's final cumulative clanka `Usage`, sub-agents included. */
export const TurnUsage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
})
export type TurnUsage = typeof TurnUsage.Type

export const TurnStatus = Schema.Literals([
  "running",
  /** Ended with a final reply. */
  "replied",
  /** "stop", the kill switch or a delete. */
  "stopped",
  "deadline",
  "failed",
])
export type TurnStatus = typeof TurnStatus.Type

export const TranscriptTurn = Schema.Struct({
  turnId: Schema.String,
  status: TurnStatus,
  /** Why a failed turn failed: a provider error's category, `resume_limit`, `busy` and the like. */
  errorCategory: Schema.NullOr(Schema.String),
  resumes: Schema.Int,
  wrappedUp: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  /** How many scripts the turn started, across its resumes. */
  actions: Schema.Int,
  /** Null until the model reports any. */
  usage: Schema.NullOr(TurnUsage),
})
export type TranscriptTurn = typeof TranscriptTurn.Type

export const TurnState = Schema.Struct({
  ...TranscriptTurn.fields,
  /** Epoch millis the turn was created. */
  createdAt: Schema.Finite,
  /**
   * Epoch millis the turn first got a sandbox; its deadline and wrap-up
   * count from here, so queue time doesn't count against it.
   */
  startedAt: Schema.NullOr(Schema.Finite),
  /** Sandbox acquires so far. Every one after the first is a resume. */
  acquires: Schema.Int,
  statusMessageId: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.Finite),
})
export type TurnState = typeof TurnState.Type

export const SessionState = Schema.Struct({
  thread: ChatThread,
  /** Epoch millis of the latest message; the session expires counting from it. */
  lastMessageAt: Schema.Finite,
  /** The thread was told the bot is switched off, since it last was on. */
  switchedOffNotified: Schema.Boolean,
})
export type SessionState = typeof SessionState.Type

/** A stored message and where it stands. */
export interface StoredMessage {
  readonly message: ChatMessage
  readonly gate: GateOutcome | null
  /** It should start or steer a turn. */
  readonly wantsTurn: boolean
}

const SessionJson = Schema.fromJsonString(SessionState)
const TurnJson = Schema.fromJsonString(TurnState)
const ChatMessageJson = Schema.fromJsonString(Schema.toCodecJson(ChatMessage))
const GateJson = Schema.fromJsonString(GateOutcome)
const MessageJson = Schema.fromJsonString(Prompt.Message)

interface MessageRow {
  readonly message: string
  readonly gate: string | null
  readonly wants_turn: number
}

const decodeRow = (row: MessageRow) =>
  Effect.all({
    message: Schema.decodeEffect(ChatMessageJson)(row.message),
    gate: row.gate === null ? Effect.succeed(null) : Schema.decodeEffect(GateJson)(row.gate),
    wantsTurn: Effect.succeed(row.wants_turn === 1),
  })

const TABLES = ["chat_session", "chat_messages", "chat_turns", "chat_history"] as const

/** The session's storage over its entity's SQLite, keyed by session id. */
export const makeSessionStorage = (sql: SqlClient.SqlClient, sessionId: string) => {
  /** Whether the session has any storage. */
  const exists = Effect.gen(function* () {
    const [table] = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_session'`
    if (table === undefined) return false
    const [row] = yield* sql`SELECT 1 FROM chat_session WHERE session_id = ${sessionId}`
    return row !== undefined
  })

  const ensureTables = Effect.all(
    [
      sql`CREATE TABLE IF NOT EXISTS chat_session (
        session_id TEXT PRIMARY KEY, state TEXT NOT NULL)`,
      sql`CREATE TABLE IF NOT EXISTS chat_messages (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL,
        message TEXT NOT NULL, gate TEXT, wants_turn INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, seq), UNIQUE (session_id, message_id))`,
      sql`CREATE TABLE IF NOT EXISTS chat_turns (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY (session_id, seq), UNIQUE (session_id, turn_id))`,
      sql`CREATE TABLE IF NOT EXISTS chat_history (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY (session_id, seq))`,
    ],
    { discard: true },
  )

  /**
   * Deletes the session's rows, in one transaction, when it expires or is
   * deleted. The tables go too once nothing else is in them, as in a Durable
   * Object of its own.
   */
  const drop = sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM chat_session WHERE session_id = ${sessionId}`
      yield* sql`DELETE FROM chat_messages WHERE session_id = ${sessionId}`
      yield* sql`DELETE FROM chat_turns WHERE session_id = ${sessionId}`
      yield* sql`DELETE FROM chat_history WHERE session_id = ${sessionId}`
      const [left] = yield* sql`SELECT 1 FROM chat_session LIMIT 1`
      if (left !== undefined) return
      for (const table of TABLES) yield* sql`DROP TABLE IF EXISTS ${sql(table)}`
    }),
  )

  const loadSession = sql<{ state: string }>`
    SELECT state FROM chat_session WHERE session_id = ${sessionId}`.pipe(
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.succeed(Option.none<SessionState>())
        : Effect.map(Schema.decodeEffect(SessionJson)(row.state), Option.some),
    ),
  )

  const saveSession = (state: SessionState) =>
    Effect.flatMap(
      Schema.encodeEffect(SessionJson)(state),
      (json) => sql`
        INSERT INTO chat_session (session_id, state) VALUES (${sessionId}, ${json})
        ON CONFLICT (session_id) DO UPDATE SET state = excluded.state`,
    )

  /**
   * Stores a message unless one with its id is stored already; `false` for a
   * duplicate. `gate` is null for a message still to be gated.
   */
  const addMessage = (message: ChatMessage, gate: GateOutcome | null) =>
    Effect.gen(function* () {
      const json = yield* Schema.encodeEffect(ChatMessageJson)(message)
      const gateJson = gate === null ? null : yield* Schema.encodeEffect(GateJson)(gate)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [found] = yield* sql`
            SELECT seq FROM chat_messages
            WHERE session_id = ${sessionId} AND message_id = ${message.id}`
          if (found !== undefined) return false
          yield* sql`
            INSERT INTO chat_messages (session_id, seq, message_id, message, gate)
            SELECT ${sessionId}, COALESCE(MAX(seq) + 1, 0), ${message.id}, ${json}, ${gateJson}
            FROM chat_messages WHERE session_id = ${sessionId}`
          return true
        }),
      )
    })

  /**
   * Records a message's gate outcome. A message that wants a turn starts or
   * steers one; a delivered message never reaches the model again.
   */
  const setGate = (
    id: string,
    gate: GateOutcome,
    options: { readonly wantsTurn?: boolean; readonly delivered?: boolean } = {},
  ) =>
    Effect.flatMap(
      Schema.encodeEffect(GateJson)(gate),
      (json) => sql`
        UPDATE chat_messages SET gate = ${json}, wants_turn = ${options.wantsTurn ? 1 : 0},
          delivered = ${options.delivered ? 1 : 0}
        WHERE session_id = ${sessionId} AND message_id = ${id}`,
    )

  /** Messages stored but not gated yet, as a crash between the two leaves them. */
  const ungated = sql<MessageRow>`
    SELECT message, gate, wants_turn FROM chat_messages
    WHERE session_id = ${sessionId} AND gate IS NULL ORDER BY seq`.pipe(
    Effect.flatMap(Effect.forEach(decodeRow)),
  )

  /** The thread's latest `limit` messages, oldest first. */
  const recent = (limit: number) =>
    sql<MessageRow>`
      SELECT message, gate, wants_turn FROM (
        SELECT seq, message, gate, wants_turn FROM chat_messages
        WHERE session_id = ${sessionId} ORDER BY seq DESC LIMIT ${limit}
      ) ORDER BY seq`.pipe(
      Effect.flatMap(Effect.forEach(decodeRow)),
      Effect.map((rows) => rows.map((row) => row.message)),
    )

  /** Gated messages the model hasn't seen yet, oldest first. */
  const undelivered = sql<MessageRow>`
    SELECT message, gate, wants_turn FROM chat_messages
    WHERE session_id = ${sessionId} AND delivered = 0 AND gate IS NOT NULL ORDER BY seq`.pipe(
    Effect.flatMap(Effect.forEach(decodeRow)),
  )

  const markDelivered = (ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (id) => sql`
        UPDATE chat_messages SET delivered = 1
        WHERE session_id = ${sessionId} AND message_id = ${id}`,
      { discard: true },
    ).pipe(sql.withTransaction)

  /** Turns every message still waiting for a turn into context, as "stop" does. */
  const clearWanted = sql`
    UPDATE chat_messages SET wants_turn = 0
    WHERE session_id = ${sessionId} AND delivered = 0`.pipe(Effect.asVoid)

  const hasWanted = sql`
    SELECT 1 FROM chat_messages
    WHERE session_id = ${sessionId} AND delivered = 0 AND wants_turn = 1 LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
  )

  const saveTurn = (state: TurnState) =>
    Effect.flatMap(
      Schema.encodeEffect(TurnJson)(state),
      (json) => sql`
        INSERT INTO chat_turns (session_id, seq, turn_id, state)
        SELECT ${sessionId}, COALESCE(MAX(seq) + 1, 0), ${state.turnId}, ${json}
        FROM chat_turns WHERE session_id = ${sessionId}
        ON CONFLICT (session_id, turn_id) DO UPDATE SET state = excluded.state`,
    )

  const turns = sql<{ state: string }>`
    SELECT state FROM chat_turns WHERE session_id = ${sessionId} ORDER BY seq`.pipe(
    Effect.flatMap(Effect.forEach((row) => Schema.decodeEffect(TurnJson)(row.state))),
  )

  const loadTurn = (turnId: string) =>
    sql<{ state: string }>`
      SELECT state FROM chat_turns
      WHERE session_id = ${sessionId} AND turn_id = ${turnId}`.pipe(
      Effect.flatMap(([row]) =>
        row === undefined
          ? Effect.succeed(Option.none<TurnState>())
          : Effect.map(Schema.decodeEffect(TurnJson)(row.state), Option.some),
      ),
    )

  /**
   * Moves a turn on in one transaction. `move` returns the next state, or
   * `undefined` to leave it as it is; the result is the saved state.
   */
  const updateTurn = (turnId: string, move: (state: TurnState) => TurnState | undefined) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* loadTurn(turnId)
        if (Option.isNone(current)) return Option.none<TurnState>()
        const next = move(current.value)
        if (next === undefined) return Option.none<TurnState>()
        yield* saveTurn(next)
        return Option.some(next)
      }),
    )

  /**
   * Commits one history change, in one transaction. A replacement replaces
   * every row. The system message is never stored.
   */
  const commitHistory = (change: HistoryChange) =>
    Effect.gen(function* () {
      const rows = yield* Effect.forEach(
        change.messages.filter((message) => message.role !== "system"),
        encodeMessage,
      )
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (change._tag === "Replaced")
            yield* sql`DELETE FROM chat_history WHERE session_id = ${sessionId}`
          const [next] = yield* sql<{ next: number }>`
            SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM chat_history
            WHERE session_id = ${sessionId}`
          for (const [index, message] of rows.entries())
            yield* sql`
              INSERT INTO chat_history (session_id, seq, message)
              VALUES (${sessionId}, ${next!.next + index}, ${message})`
        }),
      )
    })

  /**
   * The history to continue from. On a resume, an assistant message with
   * tool calls whose results never arrived is dropped, from the rows too.
   */
  const history = (resume: boolean) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ seq: number; message: string }>`
        SELECT seq, message FROM chat_history WHERE session_id = ${sessionId} ORDER BY seq`
      const messages = yield* Effect.forEach(rows, (row) =>
        Schema.decodeEffect(MessageJson)(row.message),
      )
      const last = messages.at(-1)
      if (
        !resume ||
        last?.role !== "assistant" ||
        !last.content.some((part) => part.type === "tool-call")
      )
        return messages
      yield* sql`
        DELETE FROM chat_history WHERE session_id = ${sessionId} AND seq = ${rows.at(-1)!.seq}`
      return messages.slice(0, -1)
    })

  /** The messages with their gate outcomes and the turns, read in one transaction. */
  const transcript = sql.withTransaction(
    Effect.all({
      messages: sql<MessageRow>`
        SELECT message, gate, wants_turn FROM chat_messages
        WHERE session_id = ${sessionId} AND gate IS NOT NULL ORDER BY seq`.pipe(
        Effect.flatMap(Effect.forEach(decodeRow)),
      ),
      turns,
    }),
  )

  return {
    exists,
    ensureTables,
    drop,
    loadSession,
    saveSession,
    addMessage,
    setGate,
    ungated,
    recent,
    undelivered,
    markDelivered,
    clearWanted,
    hasWanted,
    saveTurn,
    turns,
    loadTurn,
    updateTurn,
    commitHistory,
    history,
    transcript,
  }
}

export type SessionStorage = ReturnType<typeof makeSessionStorage>
