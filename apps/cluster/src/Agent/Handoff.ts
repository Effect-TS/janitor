// The durable runner handoff.
//
// The workflow outbox marks a row accepted once the engine has the execution;
// that receipt says nothing about native admission. This workflow owns the
// gap: it holds a per-session delivery lease, ensures the native conversation
// exists, then delivers unsettled inputs strictly in acceptance order with
// their stable runner message ids. An input whose request was sent but whose
// receipt was lost stays `uncertain` and is retried with the same identity
// before any later input can overtake it.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Activity from "effect/unstable/workflow/Activity"
import * as DurableClock from "effect/unstable/workflow/DurableClock"
import * as Workflow from "effect/unstable/workflow/Workflow"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describeError } from "../SqlErrors.ts"
import type { WorkflowRegistration } from "../WorkflowDispatcher.ts"
import type { OutboxRequest } from "../WorkflowOutbox.ts"
import { AgentCatchUpWake } from "./EventProjection.ts"
import { RunnerClient, type RunnerClientError } from "./RunnerClient.ts"
import { AgentSessionId, type InputAttribution } from "./RunnerProtocol.ts"

export const AGENT_HANDOFF_TAG = "Janitor/AgentRunnerHandoffV1"

export const HandoffPayload = Schema.Struct({
  sessionId: AgentSessionId,
  /** The accepted input this execution answers for; null for session creation. */
  sequence: Schema.NullOr(Schema.Int),
})
export type HandoffPayload = typeof HandoffPayload.Type

export const handoffRequest = (
  sessionId: AgentSessionId,
  sequence: number | null,
): OutboxRequest => ({
  workflowTag: AGENT_HANDOFF_TAG,
  executionKey: `${sessionId}:${sequence ?? "create"}`,
  payload: { sessionId, sequence },
})

/** A recovery sweep re-requests delivery under a new execution key. */
export const handoffSweepRequest = (sessionId: AgentSessionId, epoch: number): OutboxRequest => ({
  workflowTag: AGENT_HANDOFF_TAG,
  executionKey: `${sessionId}:sweep:${epoch}`,
  payload: { sessionId, sequence: null },
})

export class HandoffError extends Schema.TaggedError<HandoffError>()(
  "@janitor/cluster/Agent/HandoffError",
  {
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const HandoffOutcome = Schema.Literals(["settled", "busy", "blocked", "retry"])
export type HandoffOutcome = typeof HandoffOutcome.Type

const LEASE = Duration.seconds(90)
const MAX_TRANSPORT_RETRIES = 4
const MAX_WAITS = 30

const UnsettledRow = Schema.Struct({
  sequence: Schema.Int,
  runner_message_id: Schema.String,
  text: Schema.String,
  source: Schema.Literals(["slack", "github", "driver"]),
  author: Schema.Unknown,
  contribution_key: Schema.String,
  handoff_state: Schema.Literals(["pending", "uncertain"]),
  handoff_attempts: Schema.Int,
})

const SessionRow = Schema.Struct({
  repository_id: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  title: Schema.String,
  native_session_id: Schema.NullOr(Schema.String),
  runner_state: Schema.Literals(["creating", "ready", "blocked", "disconnected"]),
})

/**
 * Delivers everything unsettled for a session while holding its lease. Safe to
 * run concurrently and repeatedly: the lease serializes delivery loops, the
 * runner reconciles repeated identities, and later inputs never overtake
 * earlier unsettled ones.
 */
export const deliverSession = Effect.fn("AgentHandoff.deliverSession")(function* (
  sessionId: AgentSessionId,
) {
  const sql = yield* SqlClient.SqlClient
  const runner = yield* RunnerClient
  const wake = yield* AgentCatchUpWake
  const dbError = (error: { readonly message: string }) =>
    new HandoffError({ message: describeError(error), retryable: true })
  const query = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
    Effect.mapError(effect, dbError)
  const decodeSession = Schema.decodeUnknownEffect(Schema.Array(SessionRow))
  const decodeUnsettled = Schema.decodeUnknownEffect(Schema.Array(UnsettledRow))
  // oxlint-disable-next-line effecttsgo/crypto-random-uuid-in-effect
  const lease = crypto.randomUUID()
  const seconds = Duration.toSeconds(LEASE)

  const acquired = yield* query(sql`
    UPDATE agent_session SET handoff_lease_token = ${lease},
      handoff_lease_until = CLOCK_TIMESTAMP() + make_interval(secs => ${seconds})
    WHERE session_id = ${sessionId}
      AND (handoff_lease_until IS NULL OR handoff_lease_until <= CLOCK_TIMESTAMP())
    RETURNING session_id
  `)
  if (acquired.length === 0) return "busy"

  const release = query(sql`
    UPDATE agent_session SET handoff_lease_token = NULL, handoff_lease_until = NULL
    WHERE session_id = ${sessionId} AND handoff_lease_token = ${lease}
  `).pipe(Effect.ignore)

  const markSession = (state: "ready" | "blocked" | "disconnected", error: string | null) =>
    query(
      sql`UPDATE agent_session SET runner_state = ${state}, runner_error = ${error}::text WHERE session_id = ${sessionId}`,
    )

  const wakeReads = query(sql`
    UPDATE agent_catchup SET due_at = CLOCK_TIMESTAMP(), cadence = 'active' WHERE session_id = ${sessionId}
  `).pipe(Effect.andThen(wake), Effect.ignore)

  return yield* Effect.gen(function* () {
    const sessions = yield* query(sql`
      SELECT generation::int AS generation, title, native_session_id, runner_state, repository_id FROM agent_session WHERE session_id = ${sessionId}
    `).pipe(Effect.flatMap(decodeSession), Effect.mapError(dbError))
    const session = sessions[0]
    if (session === undefined || session.runner_state === "disconnected") return "settled" as const

    // Native creation is idempotent on the deterministic session identity.
    if (session.native_session_id === null) {
      const created = yield* runner
        .createSession(sessionId, {
          generation: session.generation,
          title: session.title,
          ...(session.repository_id === null ? {} : { repositoryId: session.repository_id }),
        })
        .pipe(Effect.result)
      if (created._tag === "Failure") {
        const outcome = yield* classify(created.failure, markSession)
        if (outcome !== "retry") return outcome
        return yield* new HandoffError({ message: created.failure.message, retryable: true })
      }
      yield* query(sql`
        UPDATE agent_session SET native_session_id = ${created.success.nativeSessionId},
          model_configuration_id = ${created.success.modelConfigurationId}, runner_state = 'ready', runner_error = NULL
        WHERE session_id = ${sessionId}
      `)
      yield* wakeReads
    }

    for (;;) {
      const unsettled = yield* query(sql`
        SELECT sequence::int AS sequence, runner_message_id, text, source, author, contribution_key, handoff_state, handoff_attempts
        FROM agent_input WHERE session_id = ${sessionId} AND handoff_state IN ('pending', 'uncertain')
        ORDER BY sequence LIMIT 1
      `).pipe(Effect.flatMap(decodeUnsettled), Effect.mapError(dbError))
      const next = unsettled[0]
      if (next === undefined) return "settled" as const
      const held = yield* query(
        sql`SELECT 1 FROM github_feedback_output WHERE session_id=${sessionId} AND state IN ('uncertain','problem') LIMIT 1`,
      )
      if (held.length > 0) {
        yield* markSession("blocked", "GitHub feedback reply needs delivery reconciliation")
        return "blocked" as const
      }
      // Record the attempt before sending: a crash mid-request leaves `uncertain`, never `pending`.
      yield* query(sql`
        UPDATE agent_input SET handoff_state = 'uncertain', handoff_attempts = handoff_attempts + 1
        WHERE session_id = ${sessionId} AND sequence = ${next.sequence}
      `)
      const author = (next.author ?? {}) as { teammateId?: string; displayName?: string }
      const attribution: InputAttribution = {
        source: next.source,
        ...(author.teammateId === undefined ? {} : { teammateId: author.teammateId }),
        ...(author.displayName === undefined ? {} : { displayName: author.displayName }),
        contributionKey: next.contribution_key,
      }
      const admitted = yield* runner
        .admitInput(sessionId, {
          generation: session.generation,
          inputId: next.runner_message_id,
          text: next.text,
          attribution,
        })
        .pipe(Effect.result)
      if (admitted._tag === "Success") {
        yield* query(sql`
          UPDATE agent_input SET handoff_state = 'admitted', receipt = ${JSON.stringify(admitted.success)}::jsonb,
            admitted_at = CLOCK_TIMESTAMP(), handoff_error = NULL
          WHERE session_id = ${sessionId} AND sequence = ${next.sequence}
        `)
        yield* markSession("ready", null)
        yield* wakeReads
        continue
      }
      const failure = admitted.failure
      if (failure.code === "invalid_request") {
        // A terminal refusal of this input alone is recorded, reported and skipped.
        yield* query(sql`
          UPDATE agent_input SET handoff_state = 'rejected', handoff_error = ${failure.message}
          WHERE session_id = ${sessionId} AND sequence = ${next.sequence}
        `)
        continue
      }
      yield* query(sql`
        UPDATE agent_input SET handoff_error = ${failure.message}::text
        WHERE session_id = ${sessionId} AND sequence = ${next.sequence}
      `)
      const outcome = yield* classify(failure, markSession)
      if (outcome !== "retry") return outcome
      return yield* new HandoffError({ message: failure.message, retryable: true })
    }
  }).pipe(Effect.ensuring(release))
})

/** Maps runner refusals onto session state. Only transport failures are retried. */
const classify = (
  failure: RunnerClientError,
  markSession: (
    state: "ready" | "blocked" | "disconnected",
    error: string | null,
  ) => Effect.Effect<unknown, HandoffError>,
): Effect.Effect<HandoffOutcome, HandoffError> =>
  Effect.gen(function* () {
    switch (failure.code) {
      case "transport":
        return "retry" as const
      case "blocked":
        yield* markSession("blocked", failure.reason ?? failure.message)
        return "blocked" as const
      case "stale_generation":
        yield* markSession("disconnected", failure.message)
        return "blocked" as const
      case "missing_session":
        // The runner lost or never had the conversation; hold and let the sweep retry creation.
        yield* markSession("blocked", failure.message)
        return "blocked" as const
      case "incompatible_protocol":
      case "unauthorized":
      case "invalid_request":
        yield* markSession("blocked", failure.message)
        return "blocked" as const
    }
  })

export const AgentHandoff = Workflow.make(AGENT_HANDOFF_TAG, {
  payload: HandoffPayload,
  success: HandoffOutcome,
  error: HandoffError,
  idempotencyKey: ({ sessionId, sequence }) => `${sessionId}:${sequence ?? "create"}`,
})

const settled = (sessionId: AgentSessionId, sequence: number | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (sequence === null) {
      const rows = yield* sql<{ done: boolean }>`
        SELECT (native_session_id IS NOT NULL OR runner_state IN ('blocked', 'disconnected')) AS done
        FROM agent_session WHERE session_id = ${sessionId}
      `
      return rows[0]?.done ?? true
    }
    const rows = yield* sql<{ handoff_state: string }>`
      SELECT handoff_state FROM agent_input WHERE session_id = ${sessionId} AND sequence = ${sequence}
    `
    const state = rows[0]?.handoff_state
    return state === undefined || state === "admitted" || state === "rejected"
  }).pipe(
    Effect.mapError(
      (error) => new HandoffError({ message: describeError(error), retryable: true }),
    ),
  )

export const AgentHandoffLayer = AgentHandoff.toLayer(
  Effect.fnUntraced(function* ({ sessionId, sequence }) {
    let transportRetries = 0
    for (let attempt = 0; attempt < MAX_WAITS; attempt++) {
      const result = yield* Activity.make({
        name: `AgentHandoff/deliver-${attempt}`,
        success: HandoffOutcome,
        error: HandoffError,
        execute: deliverSession(sessionId).pipe(
          Effect.flatMap((outcome) =>
            outcome === "busy"
              ? Effect.succeed(outcome)
              : settled(sessionId, sequence).pipe(
                  Effect.map((done) => (done ? outcome : ("busy" as const))),
                ),
          ),
        ),
      }).pipe(Effect.result)
      if (result._tag === "Success") {
        if (result.success !== "busy") return result.success
        yield* DurableClock.sleep({
          name: `AgentHandoff/busy-${attempt}`,
          duration: Duration.seconds(1),
        })
        continue
      }
      if (!result.failure.retryable || transportRetries >= MAX_TRANSPORT_RETRIES)
        return yield* result.failure
      yield* Effect.logWarning("Runner handoff will retry", {
        sessionId,
        message: result.failure.message,
      })
      yield* DurableClock.sleep({
        name: `AgentHandoff/retry-${attempt}`,
        duration: Duration.seconds(2 * 2 ** transportRetries++),
      })
    }
    // The recovery sweep re-requests delivery later; the inputs remain durable and ordered.
    return "retry" as const
  }),
)

const decodePayload = Schema.decodeUnknownEffect(HandoffPayload)

export const AgentHandoffRegistration: WorkflowRegistration = {
  tag: AGENT_HANDOFF_TAG,
  submit: (payload) =>
    decodePayload(payload).pipe(
      Effect.flatMap((decoded) => AgentHandoff.execute(decoded, { discard: true })),
      Effect.asVoid,
    ),
}
