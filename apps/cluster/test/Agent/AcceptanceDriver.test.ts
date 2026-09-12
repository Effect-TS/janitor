// Service-level acceptance driver: Janitor's session acceptance, ordered
// handoff and event projection against the real runner bundle running in
// Miniflare, with controlled model responses. No repository or platform is
// touched. Requires the runner workspace to be installed (`runner/README.md`).
import { assert, describe, it, layer } from "@effect/vitest"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { AgentEventProjection } from "../../src/Agent/EventProjection.ts"
import { AgentHandoff } from "../../src/Agent/Handoff.ts"
import { RunnerClient } from "../../src/Agent/RunnerClient.ts"
import { RUNNER_PROTOCOL_HEADER, RUNNER_PROTOCOL_VERSION } from "../../src/Agent/RunnerProtocol.ts"
import { AgentSessions } from "../../src/Agent/Sessions.ts"
import { WorkflowDispatcher } from "../../src/WorkflowDispatcher.ts"
import { agentLayers } from "./support.ts"

const runnerRoot = path.resolve(import.meta.dirname, "../../../../runner")
const runnerInstalled = fs.existsSync(path.join(runnerRoot, "node_modules", "miniflare"))

interface RunnerProcess {
  readonly url: string
  readonly token: string
  readonly persist: string
  readonly child: ChildProcess
}

const startRunner = (persist: string, port = 0): Promise<RunnerProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["scripts/serve.mjs", "--test", "--persist", persist, "--port", String(port)],
      {
        cwd: runnerRoot,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, RUNNER_SERVICE_TOKEN: "driver-token" },
      },
    )
    const lines = readline.createInterface({ input: child.stdout! })
    lines.once("line", (line) => {
      try {
        const parsed = JSON.parse(line) as { url: string; token: string; persist: string }
        resolve({ ...parsed, child })
      } catch (cause) {
        reject(cause)
      }
    })
    child.once("exit", (code) => reject(new Error(`runner exited with ${code}`)))
  })

const stopRunner = (runner: RunnerProcess) =>
  new Promise<void>((resolve) => {
    runner.child.once("exit", () => resolve())
    runner.child.kill("SIGTERM")
  })

let runner: RunnerProcess
const persist = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-driver-"))

/** Reaches the test-only routes of the runner bundle: scripted model and fault injection. */
const testRoute = async (sessionId: string, route: string, body: unknown) => {
  const response = await fetch(`${runner.url}/__test/sessions/${sessionId}/${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runner.token}`,
      [RUNNER_PROTOCOL_HEADER]: String(RUNNER_PROTOCOL_VERSION),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`)
}

const runnerLayer = Layer.unwrap(
  Effect.sync(() =>
    RunnerClient.layer({ baseUrl: runner.url, token: Redacted.make(runner.token) }).pipe(
      Layer.provide(FetchHttpClient.layer),
    ),
  ),
)

const poll = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  label: string,
  attempts = 150,
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const value = yield* read
      if (predicate(value)) return value
      yield* Effect.sleep("200 millis")
    }
    return yield* Effect.fail(new Error(`Timed out waiting for ${label}`))
  })

/** Polling and the workflow's durable sleeps need real time, not the test clock. */
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue())

const describeDriver = runnerInstalled ? describe : describe.skip
if (!runnerInstalled)
  console.warn("Skipping runner acceptance driver: runner/node_modules is not installed")

describeDriver("Agent conversation acceptance driver", () => {
  it("prepares the runner bundle", () => {
    execFileSync("node", ["scripts/build.mjs", "--test"], { cwd: runnerRoot, stdio: "inherit" })
    assert.isTrue(fs.existsSync(path.join(runnerRoot, "dist-test", "worker.mjs")))
  }, 120_000)

  layer(
    Layer.unwrap(
      Effect.promise(async () => {
        runner = await startRunner(persist)
        return agentLayers(runnerLayer)
      }),
    ),
    { timeout: "5 minutes" },
  )("with a live runner", (it) => {
    it.effect(
      "runs a durable conversation end to end",
      () =>
        live(
          Effect.gen(function* () {
            const sessions = yield* AgentSessions
            const projection = yield* AgentEventProjection
            const dispatcher = yield* WorkflowDispatcher
            const sql = yield* SqlClient.SqlClient
            const sessionId = "driver-conversation"
            yield* Effect.promise(() => testRoute(sessionId, "faults", { intervalMs: 500 }))
            yield* Effect.promise(() =>
              testRoute(sessionId, "model", {
                mode: "text",
                delayMs: 1500,
                answers: ["first reply", "second reply", "third reply", "fourth reply"],
                inputTokens: 10,
              }),
            )

            // 1. Start a session and queue two inputs before the runner has finished the first turn.
            yield* sessions.start({ sessionId, title: "Driver conversation" })
            const first = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:1",
              source: "slack",
              author: { teammateId: "tm_a", displayName: "Ada" },
              text: "Start with the first task",
            })
            const second = yield* sessions.accept({
              sessionId,
              contributionKey: "github:2",
              source: "github",
              author: { teammateId: "tm_b", displayName: "Bob" },
              text: "Then handle the second",
            })
            // Duplicate platform delivery maps to the same input, not a new one.
            const repeated = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:1",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "Start with the first task",
            })
            assert.strictEqual(repeated.input_id, first.input_id)
            yield* dispatcher.dispatchDue({ limit: 10 })
            yield* AgentHandoff.execute({ sessionId, sequence: second.sequence })
            let view = yield* sessions.view(sessionId)
            assert.strictEqual(view.session.runner_state, "ready")
            assert.deepStrictEqual(
              view.inputs.map((input) => input.handoff_state),
              ["admitted", "admitted"],
            )
            assert.strictEqual((view.inputs[0]!.receipt as { duplicate: boolean }).duplicate, false)

            // 2. Work continues without another prompt; the consumer catches up on its obligation.
            yield* poll(
              projection.catchUp(sessionId).pipe(Effect.andThen(sessions.view(sessionId))),
              (current) =>
                current.responses.length === 2 && current.projection?.execution === "idle",
              "two completed turns",
            )
            view = yield* sessions.view(sessionId)
            assert.deepStrictEqual(
              view.responses.map((response) => response.text),
              ["first reply", "second reply"],
            )
            assert.strictEqual(view.projection?.usage_input, 20)
            assert.isNotNull(view.projection?.usage_seq)
            const obligation = yield* sql<{
              cadence: string
            }>`SELECT cadence FROM agent_catchup WHERE session_id = ${sessionId}`
            assert.strictEqual(obligation[0]?.cadence, "active")
            const idled = yield* projection.catchUp(sessionId)
            assert.strictEqual(idled.cadence, "idle")

            // 3. A lost admission response is reconciled by identity, never duplicated.
            yield* Effect.promise(() => testRoute(sessionId, "faults", { lostReplyOnce: true }))
            const third = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:3",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "Now the third",
            })
            yield* dispatcher.dispatchDue({ limit: 10 })
            yield* AgentHandoff.execute({ sessionId, sequence: third.sequence })
            view = yield* sessions.view(sessionId)
            const thirdRow = view.inputs.find((input) => input.sequence === third.sequence)!
            assert.strictEqual(thirdRow.handoff_state, "admitted")
            assert.strictEqual(thirdRow.handoff_attempts, 2)
            assert.strictEqual((thirdRow.receipt as { duplicate: boolean }).duplicate, true)
            yield* poll(
              projection.catchUp(sessionId).pipe(Effect.andThen(sessions.view(sessionId))),
              (current) => current.responses.length === 3,
              "third turn",
            )
            const runnerClient = yield* RunnerClient
            const enqueued = yield* runnerClient.readEvents(sessionId, 0, 200)
            assert.strictEqual(
              enqueued.events.filter((event) => event.type === "session.inbox.enqueued").length,
              3,
            )
            // Duplicate runner ids after promotion keep the first payload and admit nothing new.
            const promoted = yield* runnerClient.admitInput(sessionId, {
              generation: view.session.generation,
              inputId: thirdRow.runner_message_id,
              text: "changed after promotion",
              attribution: { source: "driver" },
            })
            assert.isTrue(promoted.duplicate)
            assert.isFalse(promoted.payloadMatches)

            // 4. Restart the runner mid-turn: the turn completes with no new message.
            const fourth = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:4",
              source: "slack",
              author: { teammateId: "tm_b" },
              text: "Survive a restart",
            })
            yield* dispatcher.dispatchDue({ limit: 10 })
            yield* AgentHandoff.execute({ sessionId, sequence: fourth.sequence })
            // Duplicate runner ids before promotion (the turn is still running) are also reconciled.
            const fourthRow = (yield* sessions.view(sessionId)).inputs.find(
              (input) => input.sequence === fourth.sequence,
            )!
            const early = yield* runnerClient.admitInput(sessionId, {
              generation: view.session.generation,
              inputId: fourthRow.runner_message_id,
              text: "changed before promotion",
              attribution: { source: "driver" },
            })
            assert.isTrue(early.duplicate)
            assert.strictEqual(
              (yield* runnerClient.readEvents(sessionId, 0, 200)).events.filter(
                (event) => event.type === "session.inbox.enqueued",
              ).length,
              4,
            )
            yield* Effect.promise(async () => {
              // The same address: the client built for this layer keeps its base URL.
              const port = Number(new URL(runner.url).port)
              await stopRunner(runner)
              runner = await startRunner(persist, port)
            })
            yield* poll(
              projection.catchUp(sessionId).pipe(Effect.andThen(sessions.view(sessionId))),
              (current) =>
                current.responses.length === 4 && current.projection?.execution === "idle",
              "turn completed after restart",
              300,
            )
            view = yield* sessions.view(sessionId)
            assert.strictEqual(view.responses[3]?.text, "fourth reply")
            assert.strictEqual(view.projection?.usage_input, 40)
          }),
        ).pipe(Effect.provide(runnerLayer)),
      240000,
    )

    it.effect(
      "lets an ordinary question end the turn and an ordinary answer continue it",
      () =>
        live(
          Effect.gen(function* () {
            const sessions = yield* AgentSessions
            const projection = yield* AgentEventProjection
            const dispatcher = yield* WorkflowDispatcher
            const sessionId = "driver-question"
            yield* Effect.promise(() => testRoute(sessionId, "faults", { intervalMs: 500 }))
            yield* Effect.promise(() =>
              testRoute(sessionId, "model", {
                mode: "question",
                answers: ["ignored", "Understood, going with A."],
              }),
            )
            yield* sessions.start({ sessionId, title: "Driver question" })
            const ask = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:1",
              source: "slack",
              author: { teammateId: "tm_a" },
              text: "Do something ambiguous",
            })
            yield* dispatcher.dispatchDue({ limit: 10 })
            yield* AgentHandoff.execute({ sessionId, sequence: ask.sequence })
            yield* poll(
              projection.catchUp(sessionId).pipe(Effect.andThen(sessions.view(sessionId))),
              (current) =>
                current.projection?.execution === "idle" && current.responses.length === 1,
              "question asked",
            )
            let view = yield* sessions.view(sessionId)
            assert.strictEqual(view.responses[0]?.text, "Which approach do you prefer, A or B?")
            const answer = yield* sessions.accept({
              sessionId,
              contributionKey: "slack:2",
              source: "slack",
              author: { teammateId: "tm_b" },
              text: "Choose A",
            })
            yield* dispatcher.dispatchDue({ limit: 10 })
            yield* AgentHandoff.execute({ sessionId, sequence: answer.sequence })
            yield* poll(
              projection.catchUp(sessionId).pipe(Effect.andThen(sessions.view(sessionId))),
              (current) =>
                current.projection?.execution === "idle" && current.responses.length === 2,
              "answer processed",
            )
            view = yield* sessions.view(sessionId)
            assert.strictEqual(view.responses[1]?.text, "Understood, going with A.")
          }),
        ).pipe(Effect.provide(runnerLayer)),
      120000,
    )

    it.effect(
      "replays interrupted event reads without double counting",
      () =>
        live(
          Effect.gen(function* () {
            const sessions = yield* AgentSessions
            const projection = yield* AgentEventProjection
            const runnerClient = yield* RunnerClient
            const sql = yield* SqlClient.SqlClient
            const sessionId = "driver-conversation"
            const before = yield* sessions.view(sessionId)
            const page = yield* runnerClient.readEvents(sessionId, 0, 200)
            // Reset the cursor and crash after applying: both roll back together.
            yield* sql`UPDATE agent_event_cursor SET cursor = 0 WHERE session_id = ${sessionId}`
            const failed = yield* sql
              .withTransaction(
                projection
                  .applyPage(sessionId, page)
                  .pipe(Effect.andThen(Effect.fail(new Error("interrupted")))),
              )
              .pipe(Effect.flip)
            assert.strictEqual(String(failed), "Error: interrupted")
            const cursor = yield* sql<{
              cursor: number
            }>`SELECT cursor FROM agent_event_cursor WHERE session_id = ${sessionId}`
            assert.strictEqual(Number(cursor[0]?.cursor), 0)
            // A full replay from zero yields the same responses and usage.
            const replay = yield* projection.catchUp(sessionId)
            assert.isNull(replay.error)
            const after = yield* sessions.view(sessionId)
            assert.deepStrictEqual(after.responses, before.responses)
            assert.strictEqual(after.projection?.usage_input, before.projection?.usage_input)
            yield* Effect.promise(() => stopRunner(runner))
            fs.rmSync(persist, { recursive: true, force: true })
          }),
        ).pipe(Effect.provide(runnerLayer)),
      60000,
    )
  })
})
