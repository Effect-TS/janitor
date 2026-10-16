import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as Prompt from "effect/ai/Prompt"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { resumeMessage, wrapUpMessage } from "@janitor/domain/PullRequestReview/Prompt"
import { checkRunOutput } from "@janitor/domain/PullRequestReview/Render"
import { RunId } from "@janitor/domain/PullRequestReview/Run"
import type { LoopRecord } from "../../src/PullRequestReview/Agent.ts"
import { PullRequestReviewStore } from "../../src/PullRequestReview/Store.ts"
import { MigratedPostgresLayer } from "../support/Postgres.ts"
import { HEAD, makeRunHarness, type RunHarness } from "./runHarness.ts"
import { repositoryId, seedRepositories } from "./support.ts"

/** The deployment's environment; the gate is on while the API key is set. */
const env: Record<string, string> = { PR_REVIEW_OPENROUTER_API_KEY: "test-key" }

const Services = Layer.mergeAll(PullRequestReviewStore.layer, NodeServices.layer).pipe(
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  Layer.provideMerge(MigratedPostgresLayer),
)

const newRunId = () => RunId.make(crypto.randomUUID())

const text = (text: string) => Prompt.makePart("text", { text })
const system = Prompt.makeMessage("system", { content: "You review pull requests." })
const user = (content: string) => Prompt.makeMessage("user", { content: [text(content)] })
const assistant = (content: string) => Prompt.makeMessage("assistant", { content: [text(content)] })

/** A message over the 2 MB row cap: a 3 MB screenshot the agent read. */
const screenshot = Prompt.makeMessage("user", {
  content: [
    text("The rendered page:"),
    Prompt.makePart("file", { mediaType: "image/png", data: "A".repeat(3 * 1024 * 1024) }),
  ],
})

const encode = Schema.encodeSync(Schema.Array(Prompt.Message))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Prompt.Message)))

const finding = (path: string, line: number): LoopRecord => ({
  _tag: "FindingReported",
  finding: { path, startLine: line, endLine: line, severity: "blocking", comment: "Off by one." },
})
const addressed: LoopRecord = {
  _tag: "ThreadUpdated",
  threadId: "PRRT_1",
  judgement: { judgement: "addressed" },
}

/** Minutes and seconds into a run. */
const time = (minutes: number, seconds = 0) => Duration.seconds(minutes * 60 + seconds)

/** Moves the clock to `at` after `startedAt`, a time taken just before the run's first `Start`. */
const at = (harness: RunHarness, startedAt: number, at: Duration.Input) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    harness.wait(
      Duration.millis(
        Math.max(0, Duration.toMillis(Duration.fromInputUnsafe(at)) - (now - startedAt)),
      ),
    ),
  )

/** Restarts the runner and waits for the rebuilt entity's next acquire. */
const resume = (harness: RunHarness) =>
  Effect.gen(function* () {
    const sessions = harness.agent.sessions.length
    yield* harness.restart
    yield* harness.until(
      Effect.sync(() => harness.agent.sessions.length > sessions),
      "the run to resume",
    )
    return harness.agent.last
  })

const run = <A, E, R>(test: (harness: RunHarness) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* seedRepositories(repositoryId)
    return yield* test(yield* makeRunHarness)
  }).pipe(Effect.scoped)

layer(Services, { timeout: "2 minutes" })("PR review run entity", (it) => {
  it.effect("reviews the head, then publishes the loop's outcome and lets the entity go", () =>
    run((harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)

        // Running: the start row, the check run on the head, and a sandbox pinned to it.
        assert.strictEqual((yield* harness.row(runId))?.status, "running")
        assert.deepStrictEqual(
          harness.github.checkRuns.map((check) => [check.headSha, check.status]),
          [[HEAD, "in_progress"]],
        )
        assert.deepInclude(harness.workspaces.acquires[0], {
          runId,
          repositoryId,
          owner: "effect",
          repo: "one",
          prNumber: 7,
          headSha: HEAD,
        })
        assert.isTrue(yield* harness.keptAlive(runId))
        // A first acquire starts the review afresh.
        assert.deepStrictEqual(harness.agent.last.history, [])
        assert.deepStrictEqual(harness.agent.last.sent, [])

        yield* harness.agent.last.step({
          history: { _tag: "Appended", messages: [user("Review this."), assistant("Done.")] },
          records: [finding("src/a.ts", 3)],
        })
        yield* harness.agent.last.complete("One blocking finding.")
        yield* harness.until(
          Effect.sync(() => harness.published.length > 0),
          "Publish",
        )

        assert.deepStrictEqual(harness.published, [
          {
            runId,
            outcome: {
              summary: "One blocking finding.",
              steered: false,
              interrupted: false,
              unfinished: null,
              records: [finding("src/a.ts", 3)],
            },
          },
        ])
        yield* harness.until(
          Effect.map(harness.keptAlive(runId), (kept) => !kept),
          "keep-alive to be released",
        )
        assert.deepStrictEqual(harness.workspaces.releases, [runId])
      }),
    ),
  )

  it.effect(
    "a pull request closed or turned draft since it was queued ends the run as skipped",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          harness.github.put({
            number: 7,
            title: "Change",
            state: "closed",
            labels: [],
            pullRequest: { headSha: HEAD },
          })
          const closed = newRunId()
          yield* harness.start(closed)

          harness.github.put({
            number: 7,
            title: "Change",
            state: "open",
            labels: [],
            pullRequest: { headSha: HEAD, draft: true },
          })
          const draft = newRunId()
          yield* harness.start(draft)

          assert.deepStrictEqual(
            harness.finished.map((message) => message.runId),
            [closed, draft],
          )
          // Like the other draft skips, nothing is recorded and nothing starts.
          assert.isUndefined(yield* harness.row(closed))
          assert.isUndefined(yield* harness.row(draft))
          assert.deepStrictEqual(harness.github.checkRuns, [])
          assert.deepStrictEqual(harness.workspaces.acquires, [])
        }),
      ),
  )

  it.effect(
    "cancel stops the loop before releasing the workspace, and the run stays cancelled",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          const runId = newRunId()
          yield* harness.start(runId)
          const tables = yield* harness.tables
          assert.isNotEmpty(tables)

          yield* harness.cancel(runId)

          // Destroying the container first would fail the loop and overwrite `cancelled`.
          assert.deepStrictEqual(harness.events, ["agent stopped", "workspace released"])
          assert.strictEqual((yield* harness.row(runId))?.status, "cancelled")
          assert.strictEqual(harness.finishedCount(runId), 1)
          assert.deepStrictEqual(harness.published, [])
          assert.isFalse(yield* harness.keptAlive(runId))
          // Cancelled before publishing, so its history goes straight away.
          assert.deepStrictEqual(yield* harness.tables, [])
        }),
      ),
  )

  it.effect("commits history and loop records per step, and a restart resumes from them", () =>
    run((harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)
        const first = harness.agent.last
        yield* first.step({
          history: {
            _tag: "Appended",
            messages: [system, user("Review this."), assistant("Reading a.ts.")],
          },
          records: [finding("src/a.ts", 3)],
        })
        // Compaction: the whole history is replaced.
        yield* first.step({
          history: { _tag: "Replaced", messages: [system, user("So far: one finding.")] },
          records: [addressed],
        })
        // A step cut short after the assistant's reply, as a mid-step snapshot leaves it.
        yield* first.step({
          history: { _tag: "Appended", messages: [screenshot, assistant("The page renders.")] },
          records: [finding("src/b.ts", 9)],
        })

        const resumed = yield* resume(harness)

        // No system message, nothing from before the replacement, and no trailing reply.
        assert.strictEqual(resumed.history.length, 2)
        assert.deepStrictEqual(
          encode(resumed.history.slice(0, 1)),
          encode([user("So far: one finding.")]),
        )
        // The screenshot is stored as a placeholder under the row cap.
        const placeholder = resumed.history[1]!
        const stored = encodeJson([placeholder])
        assert.strictEqual(placeholder.role, "user")
        assert.include(stored, "image omitted, re-read the file if needed")
        assert.isBelow(stored.length, 2 * 1024 * 1024)
        assert.deepStrictEqual(resumed.sent, [resumeMessage])

        yield* resumed.complete("Two findings.")
        yield* harness.until(
          Effect.sync(() => harness.published.length > 0),
          "Publish",
        )
        assert.deepStrictEqual(harness.published[0]!.outcome.records, [
          finding("src/a.ts", 3),
          addressed,
          finding("src/b.ts", 9),
        ])
      }),
    ),
  )

  it.effect(
    "the fifth acquire errors the run, which finishes once across restarts and expires after retention",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          // The 14-day default, shortened so the clock has less to step through.
          env["PR_REVIEW_RUN_RETENTION_DAYS"] = "1"
          const runId = newRunId()
          yield* harness.start(runId)
          // Three resumes are allowed.
          for (let resumes = 1; resumes <= 3; resumes++) yield* resume(harness)

          yield* harness.restart
          yield* harness.until(
            Effect.sync(() => harness.finishedCount(runId) > 0),
            "the run to error",
          )
          assert.strictEqual(harness.agent.sessions.length, 4)
          const row = yield* harness.row(runId)
          assert.strictEqual(row?.status, "failed")
          assert.strictEqual(row?.resumeCount, 3)
          assert.deepStrictEqual(
            harness.github.checkRuns.at(-1)?.output,
            checkRunOutput({ _tag: "Errored", error: "resume_limit" }),
          )
          assert.isFalse(yield* harness.keptAlive(runId))

          // Neither a restart nor a late Cancel sends it again.
          yield* harness.restart
          yield* harness.cancel(runId)
          assert.strictEqual(harness.finishedCount(runId), 1)
          assert.strictEqual(harness.agent.sessions.length, 4)

          yield* harness.wait("23 hours", "10 minutes")
          assert.isNotEmpty(yield* harness.tables)
          yield* harness.wait("2 hours", "10 minutes")
          assert.deepStrictEqual(yield* harness.tables, [])
        }).pipe(Effect.ensuring(Effect.sync(() => delete env["PR_REVIEW_RUN_RETENTION_DAYS"]))),
      ),
    // Stepping the clock through a day takes a few seconds.
    60_000,
  )

  it.effect(
    "steers at minute 7 and interrupts at minute 10, both counted from the first start",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          const runId = newRunId()
          const startedAt = yield* Clock.currentTimeMillis
          yield* harness.start(runId)

          yield* at(harness, startedAt, time(5))
          const early = yield* resume(harness)
          yield* at(harness, startedAt, time(6, 50))
          assert.deepStrictEqual(early.sent, [resumeMessage])
          yield* at(harness, startedAt, time(7, 10))
          assert.deepStrictEqual(early.sent, [resumeMessage, wrapUpMessage])

          // Resumed past minute 7: straight to wrap-up.
          yield* at(harness, startedAt, time(8))
          const late = yield* resume(harness)
          assert.deepStrictEqual(late.sent, [resumeMessage, wrapUpMessage])

          yield* at(harness, startedAt, time(9, 50))
          assert.isFalse(late.stopped)
          yield* at(harness, startedAt, time(10, 10))
          assert.isTrue(late.stopped)
          yield* harness.until(
            Effect.sync(() => harness.published.length > 0),
            "Publish",
          )
          assert.deepStrictEqual(harness.published[0]!.outcome, {
            summary: null,
            steered: true,
            interrupted: true,
            unfinished: "deadline",
            records: [],
          })
        }),
      ),
  )

  it.effect("retries an acquire that finds no container, until the deadline", () =>
    run((harness) =>
      Effect.gen(function* () {
        // Retrying for a container isn't resuming, so the run goes on.
        harness.workspaces.unavailable = 4
        const retried = newRunId()
        yield* harness.start(retried)
        assert.strictEqual(harness.workspaces.acquires.length, 5)
        assert.strictEqual(harness.agent.sessions.length, 1)
        assert.deepStrictEqual(harness.agent.last.sent, [])

        harness.workspaces.unavailable = Infinity
        const starved = newRunId()
        const startedAt = yield* Clock.currentTimeMillis
        yield* harness.send(starved)
        yield* harness.wait("11 minutes")
        const attempts = harness.workspaces.acquires.filter((input) => input.runId === starved)
        assert.isAbove(attempts.length, 1)
        assert.isTrue(
          attempts.every((input) => input.at - startedAt < Duration.toMillis("10 minutes")),
        )
        assert.strictEqual((yield* harness.row(starved))?.status, "failed")
        assert.strictEqual(harness.finishedCount(starved), 1)

        yield* harness.wait("5 minutes")
        assert.strictEqual(
          harness.workspaces.acquires.filter((input) => input.runId === starved).length,
          attempts.length,
        )
      }),
    ),
  )

  it.effect("a run starts even when its start row can't be written", () =>
    run((harness) =>
      Effect.gen(function* () {
        harness.postgres.failStartRow = true
        const runId = newRunId()
        yield* harness.start(runId)
        assert.isUndefined(yield* harness.row(runId))
        assert.strictEqual(harness.agent.sessions.length, 1)
        assert.deepStrictEqual(
          harness.github.checkRuns.map((check) => [check.headSha, check.status]),
          [[HEAD, "in_progress"]],
        )
      }),
    ),
  )

  it.effect(
    "a Cancel that arrives while Start reads the pull request keeps the run from starting",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          const read = yield* Deferred.make<void>()
          harness.github.intercept = (request) =>
            request.method === "GET" && request.url.endsWith("/pulls/7")
              ? Effect.as(Deferred.await(read), undefined)
              : Effect.succeed(undefined)
          const runId = newRunId()
          yield* harness.send(runId)
          yield* harness.waitFor(
            Effect.sync(() => harness.github.requests.length > 0),
            "Start to read the pull request",
          )

          yield* harness.cancelNow(runId)
          yield* Deferred.succeed(read, undefined)
          yield* harness.drain

          assert.deepStrictEqual(harness.workspaces.acquires, [])
          assert.deepStrictEqual(harness.agent.sessions, [])
          assert.strictEqual(harness.finishedCount(runId), 1)
        }),
      ),
  )

  it.effect("a Cancel that arrives while the agent starts leaves no loop running", () =>
    run((harness) =>
      Effect.gen(function* () {
        harness.agent.held = yield* Deferred.make<void>()
        const runId = newRunId()
        yield* harness.send(runId)
        yield* harness.waitFor(
          Effect.sync(() => harness.agent.starts > 0),
          "the agent to start",
        )

        yield* harness.cancelNow(runId)
        yield* Deferred.succeed(harness.agent.held, undefined)
        yield* harness.drain

        // Any loop that started was stopped, and before its workspace was released.
        assert.isTrue(harness.agent.sessions.every((session) => session.stopped))
        assert.deepStrictEqual(harness.workspaces.releases, [runId])
        assert.strictEqual(harness.events.at(-1), "workspace released")
        assert.strictEqual(harness.finishedCount(runId), 1)
        assert.isFalse(yield* harness.keptAlive(runId))
      }),
    ),
  )

  it.effect("a restart after the outcome is saved but before Publish is sent still publishes", () =>
    run((harness) =>
      Effect.gen(function* () {
        const runId = newRunId()
        yield* harness.start(runId)
        yield* harness.failNextSend("Publish")
        yield* harness.agent.last.complete("Done.")
        yield* harness.drain
        assert.deepStrictEqual(harness.published, [])

        yield* harness.restart
        yield* harness.until(
          Effect.sync(() => harness.published.length > 0),
          "Publish",
        )
        assert.strictEqual(harness.published[0]!.outcome.summary, "Done.")
        yield* harness.until(
          Effect.map(harness.keptAlive(runId), (kept) => !kept),
          "keep-alive to be released",
        )
      }),
    ),
  )

  it.effect("a final row that couldn't be written is retried before the run's data goes", () =>
    run((harness) =>
      Effect.gen(function* () {
        harness.postgres.failFinalRow = true
        const runId = newRunId()
        yield* harness.start(runId)
        yield* harness.cancel(runId)
        assert.strictEqual((yield* harness.row(runId))?.status, "running")
        assert.isNotEmpty(yield* harness.tables)

        // Postgres comes back, across a restart; the retry lands within the hour.
        yield* harness.restart
        harness.postgres.failFinalRow = false
        yield* harness.wait("1 hour", "1 minute")
        assert.strictEqual((yield* harness.row(runId))?.status, "cancelled")
        assert.deepStrictEqual(yield* harness.tables, [])
        assert.strictEqual(harness.finishedCount(runId), 1)
      }),
    ),
  )

  it.effect(
    "a Cancel that arrives during Start's GitHub writes leaves the check run concluded",
    () =>
      run((harness) =>
        Effect.gen(function* () {
          const created = yield* Deferred.make<void>()
          harness.github.intercept = (request) =>
            request.method === "POST" && request.url.endsWith("/check-runs")
              ? Effect.as(Deferred.await(created), undefined)
              : Effect.succeed(undefined)
          const runId = newRunId()
          yield* harness.send(runId)
          yield* harness.waitFor(
            Effect.sync(() => harness.github.requests.some((request) => request.method === "POST")),
            "Start to create the check run",
          )

          yield* harness.cancelNow(runId)
          yield* Deferred.succeed(created, undefined)
          yield* harness.drain

          // The check run Start created is concluded, not left in progress.
          assert.deepStrictEqual(
            harness.github.checkRuns.map((check) => [check.status, check.conclusion]),
            [["completed", "cancelled"]],
          )
          assert.deepStrictEqual(harness.agent.sessions, [])
          assert.strictEqual(harness.finishedCount(runId), 1)
          assert.deepStrictEqual(yield* harness.tables, [])
        }),
      ),
  )
})
