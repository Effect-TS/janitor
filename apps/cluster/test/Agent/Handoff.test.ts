import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentHandoff, deliverSession } from "../../src/Agent/Handoff.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./support.ts"

const runner = new FakeRunner()
/** The workflow's in-memory durable sleeps must elapse on the real clock, not the test clock. */
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue())

layer(agentLayers(fakeRunnerLayer(runner)), { timeout: "3 minutes" })(
  "Agent runner handoff",
  (it) => {
    it.effect(
      "accepts inputs in one order, creates the native session and admits them in sequence",
      () =>
        live(
          Effect.gen(function* () {
            const sessions = yield* AgentSessions
            const sql = yield* SqlClient.SqlClient
            const started = yield* sessions.start({ sessionId: "order", title: "Ordered" })
            assert.strictEqual(started.runner_state, "creating")
            const first = yield* sessions.accept({
              sessionId: "order",
              contributionKey: "slack:1",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "first",
            })
            const second = yield* sessions.accept({
              sessionId: "order",
              contributionKey: "github:2",
              source: "github",
              author: { teammateId: "tm_b" },
              text: "second",
            })
            const duplicate = yield* sessions.accept({
              sessionId: "order",
              contributionKey: "slack:1",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "first again",
            })
            assert.strictEqual(first.sequence, 1)
            assert.strictEqual(second.sequence, 2)
            assert.strictEqual(duplicate.input_id, first.input_id)
            assert.match(first.runner_message_id, /^msg_[0-9a-f]{32}$/)
            // Identical text sent twice is two inputs.
            const repeated = yield* sessions.accept({
              sessionId: "order",
              contributionKey: "slack:3",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "first",
            })
            assert.strictEqual(repeated.sequence, 3)

            const outbox = yield* sql<{ execution_key: string }>`
        SELECT execution_key FROM workflow_outbox WHERE workflow_tag = 'Janitor/AgentRunnerHandoffV1' ORDER BY created_at
      `
            assert.deepStrictEqual(
              outbox.map((row) => row.execution_key),
              ["order:create", "order:1", "order:2", "order:3"],
            )
            const dispatcher = yield* WorkflowDispatcher
            const summary = yield* dispatcher.dispatchDue({ limit: 10 })
            assert.strictEqual(summary.accepted, 4)
            // Workflow submission is not admission: settle through the workflow itself.
            const outcome = yield* AgentHandoff.execute({ sessionId: "order", sequence: 3 })
            assert.strictEqual(outcome, "settled")

            const view = yield* sessions.view("order")
            assert.strictEqual(view.session.runner_state, "ready")
            assert.strictEqual(view.session.native_session_id, "ses_order")
            assert.deepStrictEqual(
              view.inputs.map((input) => [input.sequence, input.handoff_state]),
              [
                [1, "admitted"],
                [2, "admitted"],
                [3, "admitted"],
              ],
            )
            const admitted = runner.calls.filter((call) => call.method === "admitInput")
            assert.deepStrictEqual(
              admitted.map((call) => (call.detail as { text: string }).text),
              ["first", "second", "first"],
            )
            assert.deepStrictEqual(
              admitted.map(
                (call) => (call.detail as { attribution: { source: string } }).attribution.source,
              ),
              ["slack", "github", "slack"],
            )
          }),
        ),
      60_000,
    )

    it.effect("retries an uncertain admission with the same identity before any later input", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        const sql = yield* SqlClient.SqlClient
        yield* sessions.start({ sessionId: "lost", title: "Lost reply" })
        const first = yield* sessions.accept({
          sessionId: "lost",
          contributionKey: "c1",
          source: "slack",
          author: {},
          text: "one",
        })
        yield* sessions.accept({
          sessionId: "lost",
          contributionKey: "c2",
          source: "slack",
          author: {},
          text: "two",
        })
        runner.failures.push({
          method: "admitInput",
          error: new RunnerClientError({ code: "transport", message: "reply lost" }),
        })
        const attempt = yield* deliverSession("lost").pipe(Effect.flip)
        assert.strictEqual(attempt.message, "reply lost")
        const afterLoss = yield* sql<{
          sequence: number
          handoff_state: string
          handoff_attempts: number
        }>`
        SELECT sequence, handoff_state, handoff_attempts FROM agent_input WHERE session_id = 'lost' ORDER BY sequence
      `
        assert.deepStrictEqual(
          afterLoss.map((row) => [Number(row.sequence), row.handoff_state, row.handoff_attempts]),
          [
            [1, "uncertain", 1],
            [2, "pending", 0],
          ],
        )
        const outcome = yield* deliverSession("lost")
        assert.strictEqual(outcome, "settled")
        const admitted = runner.calls
          .filter((call) => call.method === "admitInput" && call.sessionId === "lost")
          .map((call) => (call.detail as { inputId: string }).inputId)
        assert.deepStrictEqual(admitted.slice(0, 2), [
          first.runner_message_id,
          first.runner_message_id,
        ])
        assert.strictEqual(admitted.length, 3)
        const view = yield* sessions.view("lost")
        const receipt = view.inputs[0]!.receipt as { duplicate: boolean }
        assert.isTrue(receipt.duplicate)
        assert.strictEqual(runner.inputs.get("lost")?.length, 2)
      }),
    )

    it.effect("holds delivery while the runner is blocked and records terminal rejections", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        yield* sessions.start({ sessionId: "held", title: "Held" })
        yield* sessions.accept({
          sessionId: "held",
          contributionKey: "c1",
          source: "slack",
          author: {},
          text: "one",
        })
        yield* sessions.accept({
          sessionId: "held",
          contributionKey: "c2",
          source: "slack",
          author: {},
          text: "two",
        })
        runner.failures.push({
          method: "createSession",
          error: new RunnerClientError({
            code: "blocked",
            message: "held",
            reason: "maintenance hold epoch 3",
          }),
        })
        assert.strictEqual(yield* deliverSession("held"), "blocked")
        let view = yield* sessions.view("held")
        assert.strictEqual(view.session.runner_state, "blocked")
        assert.strictEqual(view.session.runner_error, "maintenance hold epoch 3")
        assert.deepStrictEqual(
          view.inputs.map((input) => input.handoff_state),
          ["pending", "pending"],
        )
        runner.failures.push({
          method: "admitInput",
          error: new RunnerClientError({ code: "invalid_request", message: "malformed" }),
        })
        assert.strictEqual(yield* deliverSession("held"), "settled")
        view = yield* sessions.view("held")
        assert.strictEqual(view.session.runner_state, "ready")
        assert.deepStrictEqual(
          view.inputs.map((input) => [input.handoff_state, input.handoff_error]),
          [
            ["rejected", "malformed"],
            ["admitted", null],
          ],
        )
      }),
    )

    it.effect("fences a stale generation as disconnected and refuses further acceptance", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        yield* sessions.start({ sessionId: "stale", title: "Stale" })
        runner.failures.push({
          method: "createSession",
          error: new RunnerClientError({ code: "stale_generation", message: "disconnected at 2" }),
        })
        assert.strictEqual(yield* deliverSession("stale"), "blocked")
        const view = yield* sessions.view("stale")
        assert.strictEqual(view.session.runner_state, "disconnected")
        const refused = yield* sessions
          .accept({
            sessionId: "stale",
            contributionKey: "c1",
            source: "slack",
            author: {},
            text: "late",
          })
          .pipe(Effect.flip)
        assert.strictEqual(refused._tag, "@janitor/cluster/Agent/AgentSessionDisconnected")
      }),
    )

    it.effect("only one delivery loop runs per session at a time", () =>
      Effect.gen(function* () {
        const sessions = yield* AgentSessions
        const sql = yield* SqlClient.SqlClient
        yield* sessions.start({ sessionId: "lease", title: "Lease" })
        yield* sql`UPDATE agent_session SET handoff_lease_token = 'other', handoff_lease_until = CLOCK_TIMESTAMP() + INTERVAL '1 minute' WHERE session_id = 'lease'`
        assert.strictEqual(yield* deliverSession("lease"), "busy")
        yield* sql`UPDATE agent_session SET handoff_lease_until = CLOCK_TIMESTAMP() - INTERVAL '1 second' WHERE session_id = 'lease'`
        assert.strictEqual(yield* deliverSession("lease"), "settled")
        const rows = yield* sql<{ handoff_lease_token: string | null }>`
        SELECT handoff_lease_token FROM agent_session WHERE session_id = 'lease'
      `
        assert.isNull(rows[0]?.handoff_lease_token)
      }),
    )
  },
)
