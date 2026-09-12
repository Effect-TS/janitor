// Agent session identity and input acceptance.
//
// Acceptance is the durable boundary: an input is saved with its frozen
// content, attribution, per-session sequence and stable runner message id in
// the same transaction as its handoff intent. Everything after that is the
// handoff workflow's job; nothing here talks to the runner.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import { WorkflowOutbox, type WorkflowOutboxError } from "../WorkflowOutbox.ts"
import { handoffRequest } from "./Handoff.ts"
import {
  AgentSessionId,
  InputSource,
  RunnerMessageId,
  type InputAttribution,
} from "./RunnerProtocol.ts"

export class AgentSessionError extends Schema.TaggedError<AgentSessionError>()(
  "@janitor/cluster/Agent/AgentSessionError",
  { operation: Schema.String, message: Schema.String },
) {}

export class AgentSessionNotFound extends Schema.TaggedError<AgentSessionNotFound>()(
  "@janitor/cluster/Agent/AgentSessionNotFound",
  { sessionId: AgentSessionId },
) {}

export class AgentSessionDisconnected extends Schema.TaggedError<AgentSessionDisconnected>()(
  "@janitor/cluster/Agent/AgentSessionDisconnected",
  { sessionId: AgentSessionId },
) {}

export const RunnerState = Schema.Literals(["creating", "ready", "blocked", "disconnected"])
export const HandoffState = Schema.Literals(["pending", "uncertain", "admitted", "rejected"])
export type HandoffState = typeof HandoffState.Type

export const AgentSessionRow = Schema.Struct({
  session_id: AgentSessionId,
  generation: Schema.Int,
  title: Schema.String,
  native_session_id: Schema.NullOr(Schema.String),
  model_configuration_id: Schema.NullOr(Schema.String),
  runner_state: RunnerState,
  runner_error: Schema.NullOr(Schema.String),
})
export type AgentSessionRow = typeof AgentSessionRow.Type

export const AgentInputRow = Schema.Struct({
  input_id: Schema.String,
  session_id: AgentSessionId,
  sequence: Schema.Int,
  contribution_key: Schema.String,
  source: InputSource,
  author: Schema.Unknown,
  text: Schema.String,
  runner_message_id: RunnerMessageId,
  handoff_state: HandoffState,
  handoff_attempts: Schema.Int,
  handoff_error: Schema.NullOr(Schema.String),
  receipt: Schema.Unknown,
})
export type AgentInputRow = typeof AgentInputRow.Type

export const ProjectionRow = Schema.Struct({
  execution: Schema.Literals(["working", "idle", "blocked", "failed"]),
  reason: Schema.NullOr(Schema.String),
  last_event_seq: Schema.Int,
  usage_seq: Schema.NullOr(Schema.Int),
  usage_input: Schema.NullOr(Schema.Int),
  usage_output: Schema.NullOr(Schema.Int),
  usage_reasoning: Schema.NullOr(Schema.Int),
  usage_cache_read: Schema.NullOr(Schema.Int),
  usage_cache_write: Schema.NullOr(Schema.Int),
})
export type ProjectionRow = typeof ProjectionRow.Type

export const ResponseRow = Schema.Struct({
  seq: Schema.Int,
  assistant_message_id: Schema.String,
  ordinal: Schema.Int,
  text: Schema.String,
})
export type ResponseRow = typeof ResponseRow.Type

export interface AcceptInput {
  readonly sessionId: AgentSessionId
  /** Source-level identity of the contribution: a platform duplicate maps to the same input. */
  readonly contributionKey: string
  readonly source: InputAttribution["source"]
  readonly author: {
    readonly teammateId?: string | undefined
    readonly displayName?: string | undefined
  }
  readonly text: string
}

export interface SessionView {
  readonly session: AgentSessionRow
  readonly inputs: ReadonlyArray<AgentInputRow>
  readonly projection: ProjectionRow | null
  readonly responses: ReadonlyArray<ResponseRow>
}

export class AgentSessions extends Context.Service<
  AgentSessions,
  {
    /** Creates the session record and requests native creation through the handoff. Idempotent. */
    readonly start: (input: {
      readonly sessionId: AgentSessionId
      readonly title: string
    }) => Effect.Effect<AgentSessionRow, AgentSessionError | WorkflowOutboxError>
    /**
     * Accepts an authorized input: assigns its sequence, freezes its content and
     * enqueues the ordered handoff. A repeated contribution key returns the
     * existing input without a new sequence.
     */
    readonly accept: (
      input: AcceptInput,
    ) => Effect.Effect<
      AgentInputRow,
      AgentSessionError | AgentSessionNotFound | AgentSessionDisconnected | WorkflowOutboxError
    >
    readonly view: (
      sessionId: AgentSessionId,
    ) => Effect.Effect<SessionView, AgentSessionError | AgentSessionNotFound>
  }
>()("@janitor/cluster/Agent/AgentSessions") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const outbox = yield* WorkflowOutbox
      const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(AgentSessionRow))
      const decodeInputs = Schema.decodeUnknownEffect(Schema.Array(AgentInputRow))
      const decodeProjections = Schema.decodeUnknownEffect(Schema.Array(ProjectionRow))
      const decodeResponses = Schema.decodeUnknownEffect(Schema.Array(ResponseRow))

      const wrap =
        (operation: string) =>
        <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
          Effect.mapError(
            effect,
            (error) => new AgentSessionError({ operation, message: describeError(error) }),
          )
      /** Transaction failures become session errors; domain failures pass through. */
      const transactional =
        (operation: string) =>
        <A, E extends { readonly _tag: string; readonly message: string }, R>(
          effect: Effect.Effect<A, E, R>,
        ) =>
          Effect.mapError(effect, (error) =>
            error._tag === "SqlError"
              ? new AgentSessionError({ operation, message: describeError(error) })
              : (error as Exclude<E, { readonly _tag: "SqlError" }>),
          )

      // BIGINT columns arrive as strings from PostgreSQL; the values fit int4 in practice.
      const sessionColumns = sql`session_id, generation::int AS generation, title, native_session_id, model_configuration_id, runner_state, runner_error`
      const inputColumns = sql`input_id, session_id, sequence::int AS sequence, contribution_key, source, author, text, runner_message_id, handoff_state, handoff_attempts, handoff_error, receipt`

      const start = Effect.fn("AgentSessions.start")(function* (input: {
        readonly sessionId: AgentSessionId
        readonly title: string
      }) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql`
              INSERT INTO agent_session (session_id, title) VALUES (${input.sessionId}, ${input.title})
              ON CONFLICT (session_id) DO NOTHING
              RETURNING ${sessionColumns}
            `.pipe(Effect.flatMap(decodeSessions), wrap("start"))
              if (rows.length === 1) {
                yield* sql`INSERT INTO agent_catchup (session_id) VALUES (${input.sessionId}) ON CONFLICT DO NOTHING`.pipe(
                  wrap("start"),
                )
                yield* sql`INSERT INTO agent_session_projection (session_id) VALUES (${input.sessionId}) ON CONFLICT DO NOTHING`.pipe(
                  wrap("start"),
                )
                yield* outbox.enqueue(handoffRequest(input.sessionId, null))
                return rows[0]!
              }
              const existing =
                yield* sql`SELECT ${sessionColumns} FROM agent_session WHERE session_id = ${input.sessionId}`.pipe(
                  Effect.flatMap(decodeSessions),
                  wrap("start"),
                )
              return existing[0]!
            }),
          )
          .pipe(transactional("start"))
      })

      const accept = Effect.fn("AgentSessions.accept")(function* (input: AcceptInput) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              // The session row lock serializes sequence assignment with fencing changes.
              const sessions = yield* sql`
              SELECT ${sessionColumns} FROM agent_session WHERE session_id = ${input.sessionId} FOR NO KEY UPDATE
            `.pipe(Effect.flatMap(decodeSessions), wrap("accept"))
              const session = sessions[0]
              if (session === undefined)
                return yield* new AgentSessionNotFound({ sessionId: input.sessionId })
              if (session.runner_state === "disconnected")
                return yield* new AgentSessionDisconnected({ sessionId: input.sessionId })
              const duplicates = yield* sql`
              SELECT ${inputColumns} FROM agent_input
              WHERE session_id = ${input.sessionId} AND contribution_key = ${input.contributionKey}
            `.pipe(Effect.flatMap(decodeInputs), wrap("accept"))
              if (duplicates[0] !== undefined) return duplicates[0]
              const [allocated] = yield* sql<{ sequence: number }>`
              UPDATE agent_session SET next_sequence = next_sequence + 1
              WHERE session_id = ${input.sessionId}
              RETURNING next_sequence - 1 AS sequence
            `.pipe(wrap("accept"))
              const sequence = Number(allocated!.sequence)
              // Platform randomness: identities must be unique across isolates.
              // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
              const inputId = crypto.randomUUID()
              const runnerMessageId = `msg_${inputId.replaceAll("-", "")}`
              const rows = yield* sql`
              INSERT INTO agent_input ${sql.insert({
                input_id: inputId,
                session_id: input.sessionId,
                sequence,
                contribution_key: input.contributionKey,
                source: input.source,
                author: JSON.stringify(input.author),
                text: input.text,
                runner_message_id: runnerMessageId,
              })}
              RETURNING ${inputColumns}
            `.pipe(Effect.flatMap(decodeInputs), wrap("accept"))
              yield* outbox.enqueue(handoffRequest(input.sessionId, sequence))
              // Reads accelerate on new work; the obligation already exists.
              yield* sql`
              UPDATE agent_catchup SET due_at = LEAST(due_at, CLOCK_TIMESTAMP()), cadence = 'active'
              WHERE session_id = ${input.sessionId}
            `.pipe(wrap("accept"))
              return rows[0]!
            }),
          )
          .pipe(transactional("accept"))
      })

      const view = Effect.fn("AgentSessions.view")(function* (sessionId: AgentSessionId) {
        const sessions =
          yield* sql`SELECT ${sessionColumns} FROM agent_session WHERE session_id = ${sessionId}`.pipe(
            Effect.flatMap(decodeSessions),
            wrap("view"),
          )
        const session = sessions[0]
        if (session === undefined) return yield* new AgentSessionNotFound({ sessionId })
        const inputs = yield* sql`
          SELECT ${inputColumns} FROM agent_input WHERE session_id = ${sessionId} ORDER BY sequence
        `.pipe(Effect.flatMap(decodeInputs), wrap("view"))
        const projections = yield* sql`
          SELECT execution, reason, last_event_seq::int AS last_event_seq, usage_seq::int AS usage_seq,
            usage_input::int AS usage_input, usage_output::int AS usage_output, usage_reasoning::int AS usage_reasoning,
            usage_cache_read::int AS usage_cache_read, usage_cache_write::int AS usage_cache_write
          FROM agent_session_projection WHERE session_id = ${sessionId}
        `.pipe(Effect.flatMap(decodeProjections), wrap("view"))
        const responses = yield* sql`
          SELECT seq::int AS seq, assistant_message_id, ordinal, text FROM agent_response WHERE session_id = ${sessionId} ORDER BY seq
        `.pipe(Effect.flatMap(decodeResponses), wrap("view"))
        return { session, inputs, projection: projections[0] ?? null, responses }
      })

      return { start, accept, view }
    }),
  )
}
