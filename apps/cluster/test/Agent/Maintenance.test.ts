import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentHandoff, deliverSession } from "../../src/Agent/Handoff.ts"
import { AgentMaintenance, MaintenanceRefused } from "../../src/Agent/Maintenance.ts"
import { SessionObservation } from "../../src/Agent/Observation.ts"
import { RunnerClientError } from "../../src/Agent/RunnerClient.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { agentLayers, fakeRunnerLayer, FakeRunner } from "./support.ts"

const runner = new FakeRunner()
/** The workflow's in-memory durable sleeps must elapse on the real clock, not the test clock. */
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue())

const Services = SessionObservation.layer.pipe(
  Layer.provideMerge(agentLayers(fakeRunnerLayer(runner))),
)

const holdCalls = (sessionId: string, hold: boolean) =>
  runner.calls.filter(
    (call) =>
      call.method === "maintenance" &&
      call.sessionId === sessionId &&
      (call.detail as { hold: boolean }).hold === hold,
  )

layer(Services, { timeout: "3 minutes" })("Agent maintenance barrier", (it) => {
  it.effect(
    "holds every runner behind a barrier that new sessions and inputs cannot escape, while intake stays durable",
    () =>
      live(
        Effect.gen(function* () {
          const sessions = yield* AgentSessions
          const maintenance = yield* AgentMaintenance
          const observation = yield* SessionObservation
          const dispatcher = yield* WorkflowDispatcher
          const sql = yield* SqlClient.SqlClient
          for (const id of ["m-one", "m-two"]) {
            yield* sessions.start({ sessionId: id, title: `Session ${id}` })
            runner.sessions.set(id, { generation: 1, nativeSessionId: `ses_${id}` })
            yield* sql`UPDATE agent_session SET native_session_id = ${`ses_${id}`}, runner_state = 'ready' WHERE session_id = ${id}`
          }
          const held = yield* maintenance.hold({
            reason: "Runner upgrade to r2",
            expectedRelease: "r2",
          })
          assert.strictEqual(held.state, "held")
          assert.strictEqual(held.reason, "Runner upgrade to r2")
          assert.deepStrictEqual(
            held.sessions.map((hold) => [hold.sessionId, hold.state]),
            [
              ["m-one", "quiescent"],
              ["m-two", "quiescent"],
            ],
          )
          assert.strictEqual(holdCalls("m-one", true).length, 1)
          assert.strictEqual(runner.holds.get("m-one")?.epoch, held.epoch)

          // Intake continues: the input is accepted in order but never dispatched.
          const accepted = yield* sessions.accept({
            sessionId: "m-one",
            contributionKey: "slack:1",
            source: "slack",
            author: { teammateId: "tm_a" },
            text: "during the hold",
          })
          assert.strictEqual(accepted.handoff_state, "pending")
          yield* dispatcher.dispatchDue({ limit: 10 })
          const outcome = yield* AgentHandoff.execute({ sessionId: "m-one", sequence: 1 })
          assert.strictEqual(outcome, "blocked")
          assert.strictEqual(runner.calls.filter((call) => call.method === "admitInput").length, 0)
          const view = yield* sessions.view("m-one")
          assert.strictEqual(view.inputs[0]?.handoff_state, "pending")
          // Nothing was marked on the session row; the barrier itself is the reason.
          assert.strictEqual(view.session.runner_state, "ready")

          // A session started after the barrier is withheld and picked up by the next advance.
          yield* sessions.start({ sessionId: "m-late", title: "Late session" })
          yield* dispatcher.dispatchDue({ limit: 10 })
          assert.strictEqual(
            yield* AgentHandoff.execute({ sessionId: "m-late", sequence: null }),
            "blocked",
          )
          assert.strictEqual(
            runner.calls.filter((call) => call.method === "createSession").length,
            0,
          )
          const advanced = yield* maintenance.advance
          assert.strictEqual(advanced?.sessions.length, 3)
          assert.strictEqual(
            advanced?.sessions.find((hold) => hold.sessionId === "m-late")?.state,
            "quiescent",
          )

          // Observation names the maintenance ahead of anything the runner reported.
          const page = yield* observation.list({ cursor: null, limit: 10 })
          const summary = page.sessions.find((session) => session.sessionId === "m-one")
          assert.strictEqual(summary?.execution, "blocked")
          assert.strictEqual(summary?.reason, "Maintenance in progress: Runner upgrade to r2")

          // A second hold adopts the active barrier instead of starting another.
          const again = yield* maintenance.hold({ reason: "ignored" })
          assert.strictEqual(again.epoch, held.epoch)
          assert.strictEqual(again.reason, "Runner upgrade to r2")
        }),
      ),
    60_000,
  )

  it.effect("counts neither an unreachable runner nor a stale acknowledgement as held", () =>
    Effect.gen(function* () {
      const sessions = yield* AgentSessions
      const maintenance = yield* AgentMaintenance
      const sql = yield* SqlClient.SqlClient
      yield* sessions.start({ sessionId: "m-unreachable", title: "Unreachable" })
      yield* sessions.start({ sessionId: "m-stale", title: "Stale" })
      for (const id of ["m-unreachable", "m-stale"]) {
        runner.sessions.set(id, { generation: 1, nativeSessionId: `ses_${id}` })
        yield* sql`UPDATE agent_session SET native_session_id = ${`ses_${id}`}, runner_state = 'ready' WHERE session_id = ${id}`
      }
      runner.failures.push({
        method: "maintenance",
        sessionId: "m-unreachable",
        error: new RunnerClientError({ code: "transport", message: "runner unreachable" }),
      })
      runner.staleAcknowledgement.set("m-stale", 999)
      const active = (yield* maintenance.advance)!
      assert.strictEqual(active.state, "holding")
      const unreachable = active.sessions.find((hold) => hold.sessionId === "m-unreachable")
      const stale = active.sessions.find((hold) => hold.sessionId === "m-stale")
      assert.strictEqual(unreachable?.state, "requested")
      assert.match(unreachable?.lastError ?? "", /unreachable/)
      assert.strictEqual(stale?.state, "requested")
      assert.match(stale?.lastError ?? "", /epoch=999, not epoch/)
      // Nothing can be released while a session has not acknowledged: the upgrade waits.
      runner.health = { ...runner.health, release: "r2" }
      const early = yield* maintenance.release({ epoch: active.epoch }).pipe(Effect.flip)
      assert.instanceOf(early, MaintenanceRefused)
      // The release's own advance reached the runner that was unreachable before;
      // the stale one still answers for another epoch, so nothing is released.
      assert.match(
        early.message,
        /m-stale is not acknowledged \(runner reports held=true epoch=999/,
      )
      assert.notMatch(early.message, /m-unreachable/)
      assert.strictEqual(holdCalls("m-unreachable", false).length, 0)
      const waiting = (yield* maintenance.status())!
      assert.strictEqual(waiting.state, "holding")
      assert.strictEqual(
        waiting.sessions.find((hold) => hold.sessionId === "m-unreachable")?.state,
        "quiescent",
      )
      // Retrying reaches the runner; the stale one still never answers for this epoch.
      runner.staleAcknowledgement.delete("m-stale")
      const retried = (yield* maintenance.advance)!
      assert.strictEqual(retried.state, "held")
      assert.strictEqual(
        retried.sessions.find((hold) => hold.sessionId === "m-unreachable")?.state,
        "quiescent",
      )
      assert.strictEqual(
        retried.sessions.find((hold) => hold.sessionId === "m-stale")?.state,
        "quiescent",
      )
    }),
  )

  it.effect(
    "verifies the deployed runner before releasing, keeps refused sessions held and re-drives the rest in order",
    () =>
      live(
        Effect.gen(function* () {
          const sessions = yield* AgentSessions
          const maintenance = yield* AgentMaintenance
          const dispatcher = yield* WorkflowDispatcher
          const sql = yield* SqlClient.SqlClient
          const epoch = (yield* maintenance.status())!.epoch
          const second = yield* sessions.accept({
            sessionId: "m-one",
            contributionKey: "slack:2",
            source: "slack",
            author: { teammateId: "tm_b" },
            text: "also during the hold",
          })
          assert.strictEqual(second.sequence, 2)

          // The rollout has not produced the expected release yet.
          runner.health = { ...runner.health, release: "r1" }
          const wrongRelease = yield* maintenance.release({ epoch }).pipe(Effect.flip)
          assert.instanceOf(wrongRelease, MaintenanceRefused)
          assert.match(wrongRelease.message, /reports release r1; the rollout expected r2/)
          // A runner whose manifest disagrees with its bundle, or a foreign family, is refused too.
          runner.health = { ...runner.health, release: "r2", problems: ["manifest drift"] }
          assert.match(
            (yield* maintenance.release({ epoch }).pipe(Effect.flip)).message,
            /manifest drift/,
          )
          runner.health = {
            ...runner.health,
            problems: [],
            manifest: { ...runner.health.manifest, family: "janitor-runner-2" },
          }
          assert.match(
            (yield* maintenance.release({ epoch }).pipe(Effect.flip)).message,
            /janitor-runner-2/,
          )
          assert.strictEqual(holdCalls("m-one", false).length, 0)
          assert.strictEqual((yield* maintenance.status())?.state, "held")

          // The deployed runner qualifies; one session's own checks fail and it stays held.
          runner.health = {
            ...runner.health,
            manifest: { ...runner.health.manifest, family: "janitor-runner-1" },
          }
          runner.holds.get("m-two")!.releaseChecks = [
            { name: "state", ok: false, detail: "checkpoint manifest disagrees with its pointer" },
          ]
          // A session disconnected during the hold takes its hold record with it.
          yield* sql`DELETE FROM agent_session WHERE session_id = 'm-stale'`
          const released = yield* maintenance.release({ epoch })
          assert.strictEqual(released.state, "released")
          assert.strictEqual(released.verifiedRelease, "r2")
          assert.deepStrictEqual(
            released.sessions.map((hold) => [hold.sessionId, hold.state]),
            [
              ["m-late", "released"],
              ["m-one", "released"],
              ["m-two", "refused"],
              ["m-unreachable", "released"],
            ],
          )
          const refused = released.sessions.find((hold) => hold.sessionId === "m-two")
          assert.match(refused?.lastError ?? "", /state: checkpoint manifest/)
          assert.isTrue(runner.holds.has("m-two"))
          assert.isFalse(runner.holds.has("m-one"))

          // Withheld inputs resume in their durable order through the sweep.
          const sweeps = yield* sql<{ execution_key: string }>`
            SELECT execution_key FROM workflow_outbox WHERE execution_key LIKE ${"m-one:maintenance:%"}
          `
          assert.strictEqual(sweeps.length, 1)
          yield* dispatcher.dispatchDue({ limit: 20 })
          yield* AgentHandoff.execute({ sessionId: "m-one", sequence: 2 })
          const view = yield* sessions.view("m-one")
          assert.deepStrictEqual(
            view.inputs.map((input) => [input.sequence, input.handoff_state]),
            [
              [1, "admitted"],
              [2, "admitted"],
            ],
          )
          assert.deepStrictEqual(
            runner.calls
              .filter((call) => call.method === "admitInput" && call.sessionId === "m-one")
              .map((call) => (call.detail as { text: string }).text),
            ["during the hold", "also during the hold"],
          )

          // The refused session's runner still refuses: the dashboard shows its hold.
          yield* sessions.accept({
            sessionId: "m-two",
            contributionKey: "slack:9",
            source: "slack",
            author: { teammateId: "tm_a" },
            text: "still held",
          })
          assert.strictEqual(yield* deliverSession("m-two"), "blocked")
          const two = yield* sessions.view("m-two")
          assert.strictEqual(two.session.runner_state, "blocked")
          assert.strictEqual(two.session.runner_error, `maintenance hold epoch ${epoch}`)

          // After repair, repeating the release reaches only what is still held.
          runner.holds.get("m-two")!.releaseChecks = []
          const repaired = yield* maintenance.release({ epoch })
          assert.strictEqual(
            repaired.sessions.find((hold) => hold.sessionId === "m-two")?.state,
            "released",
          )
          assert.isFalse(runner.holds.has("m-two"))
          assert.strictEqual(holdCalls("m-one", false).length, 1)
          assert.isNull(yield* maintenance.status())
          assert.isNull(yield* maintenance.advance)
        }),
      ),
    60_000,
  )
})
