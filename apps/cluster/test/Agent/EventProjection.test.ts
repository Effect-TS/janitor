import { assert, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { sweepHandoffs } from "../../src/Agent/CatchUpCron.ts"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./support.ts"

const runner = new FakeRunner()

const usage = (input: number, seq: number) => ({
  input,
  output: 3,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  seq,
})

layer(agentLayers(fakeRunnerLayer(runner)), { timeout: "3 minutes" })(
  "Agent event projection",
  (it) => {
    it.effect(
      "applies events and advances the cursor atomically, so replay never double counts",
      () =>
        Effect.gen(function* () {
          const sessions = yield* AgentSessions
          const projection = yield* AgentEventProjection
          const sql = yield* SqlClient.SqlClient
          yield* sessions.start({ sessionId: "proj", title: "Projection" })
          runner.sessions.set("proj", { generation: 1, nativeSessionId: "ses_proj" })
          runner.push(
            "proj",
            { type: "session.inbox.enqueued", data: { inboxID: "msg_1" } },
            { type: "session.execution.started", data: {} },
            {
              type: "session.text.ended",
              data: { assistantMessageID: "msg_a", ordinal: 0, text: "hello" },
            },
            { type: "session.step.ended", data: {} },
            { type: "session.execution.succeeded", data: {} },
          )
          runner.usage.set("proj", usage(11, 5))

          const first = yield* projection.catchUp("proj")
          assert.strictEqual(first.applied, 5)
          assert.strictEqual(first.cursor, 5)
          assert.strictEqual(first.execution, "idle")
          // The idle transition keeps one more active read before slowing down.
          assert.strictEqual(first.cadence, "active")
          let view = yield* sessions.view("proj")
          assert.deepStrictEqual(
            view.responses.map((response) => [response.seq, response.text]),
            [[3, "hello"]],
          )
          assert.strictEqual(view.projection?.usage_input, 11)
          assert.strictEqual(view.projection?.usage_seq, 5)

          // Replay from an older cursor changes nothing.
          yield* sql`UPDATE agent_event_cursor SET cursor = 0 WHERE session_id = 'proj'`
          runner.usage.set("proj", usage(999, 4))
          const replay = yield* projection.catchUp("proj")
          assert.strictEqual(replay.cursor, 5)
          view = yield* sessions.view("proj")
          assert.strictEqual(view.responses.length, 1)
          assert.strictEqual(view.projection?.usage_input, 11)
          assert.strictEqual(replay.cadence, "active")
          const quiet = yield* projection.catchUp("proj")
          assert.strictEqual(quiet.applied, 0)
          assert.strictEqual(quiet.cadence, "idle")

          const obligation = yield* sql<{
            cadence: string
            due_in: number
            lease_token: string | null
          }>`
        SELECT cadence, EXTRACT(EPOCH FROM (due_at - CLOCK_TIMESTAMP()))::int AS due_in, lease_token
        FROM agent_catchup WHERE session_id = 'proj'
      `
          assert.strictEqual(obligation[0]?.cadence, "idle")
          assert.isTrue(Number(obligation[0]?.due_in) > 200)
          assert.isNull(obligation[0]?.lease_token)
        }),
    )

    it.effect("rolls back the projection together with the cursor when a read is interrupted", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        const projection = yield* AgentEventProjection
        const sql = yield* SqlClient.SqlClient
        yield* sessions.start({ sessionId: "interrupted", title: "Interrupted" })
        runner.sessions.set("interrupted", { generation: 1, nativeSessionId: "ses_i" })
        runner.push(
          "interrupted",
          { type: "session.execution.started", data: {} },
          {
            type: "session.text.ended",
            data: { assistantMessageID: "msg_b", ordinal: 0, text: "partial" },
          },
        )
        const page = yield* runner.client.readEvents("interrupted", 0)
        const failed = yield* sql
          .withTransaction(
            projection
              .applyPage("interrupted", page)
              .pipe(Effect.andThen(Effect.fail(new Error("crash before commit")))),
          )
          .pipe(Effect.flip)
        assert.strictEqual(String(failed), "Error: crash before commit")
        const cursor = yield* sql<{
          cursor: number
        }>`SELECT cursor FROM agent_event_cursor WHERE session_id = 'interrupted'`
        assert.deepStrictEqual(cursor, [])
        let view = yield* sessions.view("interrupted")
        assert.deepStrictEqual(view.responses, [])
        assert.strictEqual(view.projection?.execution, "idle")

        // A transport failure mid catch-up keeps the obligation and the cursor of committed pages.
        runner.failures.push({
          method: "readEvents",
          error: new RunnerClientError({ code: "transport", message: "read failed" }),
        })
        const failedRead = yield* projection.catchUp("interrupted")
        assert.strictEqual(failedRead.error, "read failed")
        assert.strictEqual(failedRead.cadence, "active")
        const resumed = yield* projection.catchUp("interrupted")
        assert.strictEqual(resumed.applied, 2)
        view = yield* sessions.view("interrupted")
        assert.strictEqual(view.projection?.execution, "working")
        assert.deepStrictEqual(
          view.responses.map((response) => response.text),
          ["partial"],
        )
      }),
    )

    it.effect("marks a blocked or fenced runner in the projection and keeps polling", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        const projection = yield* AgentEventProjection
        yield* sessions.start({ sessionId: "blocked", title: "Blocked" })
        runner.sessions.set("blocked", { generation: 1, nativeSessionId: "ses_b" })
        runner.failures.push({
          method: "readEvents",
          error: new RunnerClientError({
            code: "blocked",
            message: "held",
            reason: "maintenance hold epoch 2",
          }),
        })
        const summary = yield* projection.catchUp("blocked")
        assert.strictEqual(summary.error, "held")
        const view = yield* sessions.view("blocked")
        assert.strictEqual(view.projection?.execution, "blocked")
        assert.strictEqual(view.projection?.reason, "maintenance hold epoch 2")
      }),
    )

    it.effect("processes due obligations and re-requests stalled handoffs on the sweep", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        const projection = yield* AgentEventProjection
        const sql = yield* SqlClient.SqlClient
        yield* sessions.start({ sessionId: "due", title: "Due" })
        runner.sessions.set("due", { generation: 1, nativeSessionId: "ses_due" })
        runner.push("due", { type: "session.execution.started", data: {} })
        yield* sql`UPDATE agent_catchup SET due_at = CLOCK_TIMESTAMP() - INTERVAL '1 second'`
        const processed = yield* projection.processDue(10)
        assert.isTrue(
          processed.some((summary) => summary.sessionId === "due" && summary.applied === 1),
        )
        const next = yield* projection.nextDueIn
        assert.isNotNull(next)

        yield* sessions.accept({
          sessionId: "due",
          contributionKey: "c1",
          source: "slack",
          author: {},
          text: "x",
        })
        assert.deepStrictEqual(yield* sweepHandoffs(), [])
        yield* sql`UPDATE agent_input SET accepted_at = CLOCK_TIMESTAMP() - INTERVAL '10 minutes' WHERE session_id = 'due'`
        yield* sql`UPDATE agent_session SET native_session_id = 'ses_due', runner_state = 'ready' WHERE session_id = 'due'`
        const swept = yield* sweepHandoffs()
        assert.deepStrictEqual(swept, ["due"])
        const rows = yield* sql<{ execution_key: string }>`
        SELECT execution_key FROM workflow_outbox WHERE execution_key LIKE 'due:sweep:%'
      `
        assert.strictEqual(rows.length, 1)
      }),
    )
  },
)
