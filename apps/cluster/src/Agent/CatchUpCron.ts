// Durable scheduling for runner event catch-up and handoff recovery.
//
// The minute cron wakes this singleton; inside one wake it services due
// obligations at the thirty-second active cadence. Notifications may wake it
// early but are never the only discovery mechanism. The same wake runs the
// five-minute recovery sweep that re-requests delivery for inputs whose
// handoff execution was lost after the outbox accepted it.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Singleton from "effect/unstable/cluster/Singleton"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { WorkflowDispatcher } from "../WorkflowDispatcher.ts"
import { WorkflowOutbox } from "../WorkflowOutbox.ts"
import { AgentEventProjection } from "./EventProjection.ts"
import { handoffSweepRequest } from "./Handoff.ts"
import type { AgentSessionId } from "./RunnerProtocol.ts"

export const AgentCatchUpCronName = "agent-catch-up"

/** Inputs unsettled for longer than this without a live handoff are re-requested. */
const STALE_HANDOFF_SECONDS = 120
const SWEEP_EPOCH_SECONDS = 300
const WAKE_BUDGET_MS = 50_000

/** Re-enqueues delivery for sessions whose handoff stalled. Returns the sessions requested. */
export const sweepHandoffs = Effect.fn("Agent.sweepHandoffs")(function* () {
  const sql = yield* SqlClient.SqlClient
  const outbox = yield* WorkflowOutbox
  const stale = yield* sql<{ session_id: AgentSessionId; epoch: number }>`
    SELECT s.session_id, FLOOR(EXTRACT(EPOCH FROM CLOCK_TIMESTAMP()) / ${SWEEP_EPOCH_SECONDS})::int AS epoch
    FROM agent_session s
    WHERE s.runner_state IN ('creating', 'ready', 'blocked')
      AND (s.handoff_lease_until IS NULL OR s.handoff_lease_until <= CLOCK_TIMESTAMP())
      AND (
        (s.native_session_id IS NULL AND s.created_at <= CLOCK_TIMESTAMP() - make_interval(secs => ${STALE_HANDOFF_SECONDS}))
        OR EXISTS (
          SELECT 1 FROM agent_input i WHERE i.session_id = s.session_id
            AND i.handoff_state IN ('pending', 'uncertain')
            AND i.accepted_at <= CLOCK_TIMESTAMP() - make_interval(secs => ${STALE_HANDOFF_SECONDS})
        )
      )
  `
  for (const row of stale)
    yield* outbox.enqueue(handoffSweepRequest(row.session_id, Number(row.epoch)))
  return stale.map((row) => row.session_id)
})

export const AgentCatchUpCronLayer = Singleton.make(
  AgentCatchUpCronName,
  Effect.gen(function* () {
    const projection = yield* AgentEventProjection
    const dispatcher = yield* WorkflowDispatcher
    const started = yield* Clock.currentTimeMillis
    const swept = yield* sweepHandoffs().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Agent handoff sweep failed", cause).pipe(Effect.as([])),
      ),
    )
    if (swept.length > 0) {
      yield* Effect.logInfo("Re-requested stalled agent handoffs", { sessions: swept.length })
      yield* dispatcher.dispatchDue({ limit: 50 }).pipe(Effect.ignore)
    }
    for (;;) {
      const summaries = yield* projection.processDue(50)
      if (summaries.length > 0)
        yield* Effect.logInfo("Caught up agent sessions", {
          sessions: summaries.length,
          applied: summaries.reduce((sum, summary) => sum + summary.applied, 0),
        })
      const next = yield* projection.nextDueIn
      const remaining = WAKE_BUDGET_MS - ((yield* Clock.currentTimeMillis) - started)
      if (next === null || next > remaining) break
      yield* Effect.sleep(next)
    }
  }).pipe(
    Effect.catchCause(
      Effect.fnUntraced(function* (cause) {
        yield* Effect.logError("Agent catch-up failed", cause)
      }),
    ),
  ),
)
