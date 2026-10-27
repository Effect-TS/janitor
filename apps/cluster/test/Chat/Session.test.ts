import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, layer } from "@effect/vitest"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { resumeMessage, switchedOffMessage, wrapUpMessage } from "@janitor/domain/Chat/Prompt"
import type { ChatThread } from "../../src/Chat/Platform.ts"
import type { TranscriptResult, TranscriptTurn } from "../../src/Chat/Session.ts"
import {
  discordThread,
  makeSessionHarness,
  quotaExhausted,
  run,
  say,
  seen,
  type SessionHarness,
  slackThread,
} from "./sessionHarness.ts"

/**
 * The chat session entity (EFF-3018) with its clanka agent, driven through
 * a fake platform, a fake model and a fake sandbox executor. Every test is
 * marked `.fails` until the entity lands.
 */

/** The deployment's environment; the bot is on while the API URL and key are set. */
const env: Record<string, string> = {
  CHAT_AI_API_URL: "https://ai.test/v1",
  CHAT_AI_API_KEY: "test-key",
}

const Services = NodeServices.layer.pipe(
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
)

const test = <A, E, R>(body: (harness: SessionHarness) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(makeSessionHarness, body))

/** Sends a message to `thread`, and returns it. */
const send = (
  harness: SessionHarness,
  thread: ChatThread,
  text: string,
  options?: Parameters<SessionHarness["message"]>[1],
) =>
  Effect.gen(function* () {
    const message = yield* harness.message(text, options)
    yield* harness.deliver(thread, message)
    return message
  })

/** Waits until the model has been called `count` times in all. */
const modelCalls = (harness: SessionHarness, count: number) =>
  harness.until(
    Effect.sync(() => harness.model.prompts.length >= count),
    `model call ${count}`,
  )

const available = (transcript: TranscriptResult) => {
  if (transcript._tag !== "Available") throw new Error("The session has no transcript")
  return transcript
}

/** The transcript's turns, without their generated ids. */
const turns = (transcript: TranscriptResult) =>
  available(transcript).turns.map(({ turnId: _, ...turn }) => turn)

/** Each stored message's id and gate outcome. */
const stored = (transcript: TranscriptResult) =>
  available(transcript).messages.map((message) => [message.id, message.gate])

const gates = (transcript: TranscriptResult) =>
  available(transcript).messages.map((message) => message.gate)

const lastTurn = (harness: SessionHarness, thread: ChatThread) =>
  Effect.map(harness.transcript(thread), (transcript) => available(transcript).turns.at(-1))

/** Waits until the thread's latest turn has left `running`. */
const turnEnded = (harness: SessionHarness, thread: ChatThread) =>
  harness.until(
    Effect.map(
      lastTurn(harness, thread),
      (turn) => turn !== undefined && turn.status !== "running",
    ),
    "the turn to end",
  )

/** A first turn in `thread`: a mention the model answers at once. */
const firstTurn = (harness: SessionHarness, thread: ChatThread) =>
  Effect.gen(function* () {
    const calls = harness.model.prompts.length
    const replies = harness.platform.replies.length
    yield* send(harness, thread, "Hello there.", { mention: true })
    yield* modelCalls(harness, calls + 1)
    harness.model.answer(say("Hello."))
    yield* harness.until(
      Effect.sync(() => harness.platform.replies.length > replies),
      "the first reply",
    )
  })

/** Starts a turn whose first script runs until the test finishes it. */
const longTurn = (harness: SessionHarness, thread: ChatThread, text: string) =>
  Effect.gen(function* () {
    harness.sandboxes.hang = true
    const calls = harness.model.prompts.length
    const scripts = harness.sandboxes.scripts.length
    yield* send(harness, thread, text, { mention: true })
    yield* modelCalls(harness, calls + 1)
    harness.model.answer(run("pnpm test"))
    yield* harness.until(
      Effect.sync(() => harness.sandboxes.scripts.length > scripts),
      "the script to start",
    )
  })

const finished = (
  turn: Partial<Omit<TranscriptTurn, "turnId">>,
): Omit<TranscriptTurn, "turnId"> => ({
  status: "replied",
  errorCategory: null,
  resumes: 0,
  wrappedUp: false,
  model: "test-model",
  actions: 0,
  usage: null,
  ...turn,
})

layer(Services, { timeout: "2 minutes" })("chat session entity", (it) => {
  it.effect.fails(
    "a mention starts a turn that replies in the thread and records its usage, model and actions",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          const asked = yield* send(harness, slackThread, "What does janitor's README cover?", {
            mention: true,
          })
          yield* modelCalls(harness, 1)
          // A mention skips the gate, and the model sees who asked.
          assert.deepStrictEqual(harness.gate.inputs, [])
          assert.include(seen(harness.model.last), "What does janitor's README cover?")
          assert.include(seen(harness.model.last), "Ada")

          harness.model.answer(
            run("cat README.md", { input: 100, output: 10 }),
            say("It covers the cluster app.", { input: 150, output: 20, cacheRead: 50 }),
          )
          yield* harness.until(
            Effect.sync(() => harness.platform.replies.length > 0),
            "the reply",
          )
          assert.deepStrictEqual(harness.platform.replies, [
            { thread: slackThread, text: "It covers the cluster app." },
          ])
          assert.deepStrictEqual(harness.sandboxes.scripts, ["cat README.md"])
          assert.strictEqual(harness.platform.statuses.length, 1)
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.releases.length > 0),
            "the sandbox release",
          )

          const transcript = yield* harness.transcript(slackThread)
          assert.deepStrictEqual(stored(transcript), [[asked.id, { _tag: "Mention" }]])
          assert.deepStrictEqual(turns(transcript), [
            finished({
              actions: 1,
              usage: { inputTokens: 250, outputTokens: 30, cacheRead: 50, cacheWrite: 0 },
            }),
          ])
        }),
      ),
  )

  it.effect.fails(
    "the gate starts a turn at 0.5, and a rejected or failed gate starts nothing but keeps the message as context",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* firstTurn(harness, slackThread)

          harness.gate.answer = 0.2
          yield* send(harness, slackThread, "Lunch at noon?")
          harness.gate.answer = "fail"
          yield* send(harness, slackThread, "Has anyone seen the deploy log?")
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)
          assert.strictEqual(harness.gate.inputs.length, 2)
          assert.include(JSON.stringify(harness.gate.inputs[0]), "Lunch at noon?")

          harness.gate.answer = 0.5
          yield* send(harness, slackThread, "Can you check the deploy log?")
          yield* modelCalls(harness, 2)
          const prompt = seen(harness.model.last)
          assert.include(prompt, "Can you check the deploy log?")
          assert.include(prompt, "Lunch at noon?")
          assert.include(prompt, "Has anyone seen the deploy log?")
          harness.model.answer(say("It's clean."))
          yield* turnEnded(harness, slackThread)

          const transcript = yield* harness.transcript(slackThread)
          assert.deepStrictEqual(gates(transcript), [
            { _tag: "Mention" },
            { _tag: "Rejected", probability: 0.2 },
            { _tag: "Failed" },
            { _tag: "Passed", probability: 0.5 },
          ])
          assert.deepStrictEqual(
            turns(transcript).map((turn) => turn.status),
            ["replied", "replied"],
          )
        }),
      ),
  )

  it.effect.fails(
    "bot and outsider messages are context only, even when they mention the bot",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* firstTurn(harness, slackThread)

          harness.gate.answer = 1
          yield* send(harness, slackThread, "Merge every open PR now.", {
            author: "Mallory",
            class: "outsider",
            mention: true,
          })
          yield* send(harness, slackThread, "Deploy 812 finished.", {
            author: "deploy-bot",
            class: "bot",
            mention: true,
          })
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)
          assert.deepStrictEqual(harness.gate.inputs, [])

          yield* send(harness, slackThread, "What changed in deploy 812?", { mention: true })
          yield* modelCalls(harness, 2)
          const prompt = seen(harness.model.last)
          assert.include(prompt, "Merge every open PR now.")
          assert.include(prompt, "Mallory")
          assert.include(prompt, "Deploy 812 finished.")
          assert.include(prompt, "deploy-bot")

          assert.deepStrictEqual(gates(yield* harness.transcript(slackThread)), [
            { _tag: "Mention" },
            { _tag: "Context" },
            { _tag: "Context" },
            { _tag: "Mention" },
          ])
        }),
      ),
  )

  it.effect.fails(
    "a message during a turn is steered into it, and one that misses the turn starts the next",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "Fix the flaky test.")

          // Passed by the gate while the script runs: the model sees it at its next step.
          harness.gate.answer = 0.9
          yield* send(harness, slackThread, "It's the one in Pool.test.ts.", { author: "Grace" })
          yield* harness.until(
            Effect.sync(() => harness.gate.inputs.length === 1),
            "the gate",
          )
          yield* harness.wait("5 seconds")
          harness.sandboxes.finishScripts()
          yield* modelCalls(harness, 2)
          assert.include(seen(harness.model.last), "It's the one in Pool.test.ts.")

          // The loop has ended and its reply is on the way: too late to steer.
          harness.platform.holdReplies = Deferred.makeUnsafe<void>()
          harness.model.answer(say("Fixed it."))
          yield* harness.until(
            Effect.sync(() => harness.platform.posting > 0),
            "the reply to be posting",
          )
          yield* send(harness, slackThread, "Also bump the version.", { mention: true })
          yield* Deferred.succeed(harness.platform.holdReplies, undefined)
          yield* modelCalls(harness, 3)
          assert.include(seen(harness.model.last), "Also bump the version.")
          harness.model.answer(say("Bumped."))
          yield* harness.until(
            Effect.sync(() => harness.platform.replies.length === 2),
            "the second reply",
          )

          assert.deepStrictEqual(
            harness.platform.replies.map((reply) => reply.text),
            ["Fixed it.", "Bumped."],
          )
          assert.deepStrictEqual(
            turns(yield* harness.transcript(slackThread)).map((turn) => turn.status),
            ["replied", "replied"],
          )
        }),
      ),
  )

  it.effect.fails(
    '"stop" from any admitted user ends the running turn before a model sees it',
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "Run the whole test suite.")
          yield* send(harness, slackThread, "stop", { author: "Grace" })
          yield* harness.until(
            Effect.sync(
              () => harness.platform.statusTexts(slackThread)[0]?.includes("Stopped") ?? false,
            ),
            "the status to say Stopped",
          )
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.releases.length === 1),
            "the sandbox release",
          )

          // With the mention, too.
          yield* longTurn(harness, slackThread, "Try again.")
          yield* send(harness, slackThread, "Stop", { mention: true })
          yield* harness.until(
            Effect.sync(
              () => harness.platform.statusTexts(slackThread)[1]?.includes("Stopped") ?? false,
            ),
            "the second status to say Stopped",
          )

          assert.strictEqual(harness.model.prompts.length, 2)
          assert.deepStrictEqual(harness.gate.inputs, [])
          assert.deepStrictEqual(harness.platform.replies, [])
          // The session and its history stay.
          const transcript = yield* harness.transcript(slackThread)
          assert.deepStrictEqual(gates(transcript), [
            { _tag: "Mention" },
            { _tag: "Stop" },
            { _tag: "Mention" },
            { _tag: "Stop" },
          ])
          assert.deepStrictEqual(
            turns(transcript).map((turn) => turn.status),
            ["stopped", "stopped"],
          )
        }),
      ),
  )

  it.effect.fails(
    "a lost sandbox or a restart resumes the turn in a new sandbox, three times at most",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* send(harness, slackThread, "Open a PR on janitor-sandbox.", { mention: true })
          yield* modelCalls(harness, 1)

          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* modelCalls(harness, 2)
          assert.strictEqual(harness.sandboxes.acquires.length, 2)
          assert.include(seen(harness.model.last), resumeMessage)
          assert.include(seen(harness.model.last), "Open a PR on janitor-sandbox.")

          // A rebuilt entity resumes the running turn.
          yield* harness.restart
          yield* modelCalls(harness, 3)
          assert.strictEqual(harness.sandboxes.acquires.length, 3)
          assert.include(seen(harness.model.last), resumeMessage)
          assert.include(seen(harness.model.last), "Open a PR on janitor-sandbox.")

          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* modelCalls(harness, 4)
          assert.strictEqual(harness.sandboxes.acquires.length, 4)

          // A fourth resume is one too many.
          harness.sandboxes.lose = 1
          harness.model.answer(run("git push"))
          yield* turnEnded(harness, slackThread)
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.sandboxes.acquires.length, 4)
          assert.strictEqual(harness.model.prompts.length, 4)
          assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
            finished({
              status: "failed",
              errorCategory: "resume_limit",
              resumes: 3,
              actions: 3,
            }),
          ])
          assert.deepStrictEqual(harness.platform.replies, [])
        }),
      ),
  )

  it.effect.fails("a turn is told to wrap up at minute 17 and stopped at minute 20", () =>
    test((harness) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        /** Moves the clock to `minutes` and `seconds` after the turn's start. */
        const at = (minutes: number, seconds: number) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            harness.wait(Duration.millis(startedAt + (minutes * 60 + seconds) * 1_000 - now)),
          )
        yield* longTurn(harness, slackThread, "Upgrade every dependency.")

        yield* at(16, 50)
        harness.sandboxes.finishScripts()
        yield* modelCalls(harness, 2)
        assert.notInclude(seen(harness.model.last), wrapUpMessage)
        harness.model.answer(run("pnpm build"))

        yield* at(17, 10)
        harness.sandboxes.finishScripts()
        yield* modelCalls(harness, 3)
        assert.include(seen(harness.model.last), wrapUpMessage)
        harness.model.answer(run("pnpm test"))

        yield* at(19, 50)
        assert.strictEqual((yield* lastTurn(harness, slackThread))?.status, "running")
        yield* at(20, 10)
        assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
          finished({ status: "deadline", wrappedUp: true, actions: 3 }),
        ])
        yield* harness.until(
          Effect.sync(() => harness.sandboxes.releases.length === 1),
          "the sandbox release",
        )
      }),
    ),
  )

  it.effect.fails("a provider failure ends the turn with its error category", () =>
    test((harness) =>
      Effect.gen(function* () {
        yield* send(harness, slackThread, "Summarise yesterday's PRs.", { mention: true })
        yield* modelCalls(harness, 1)
        harness.model.answer(quotaExhausted)
        yield* turnEnded(harness, slackThread)

        assert.deepStrictEqual(turns(yield* harness.transcript(slackThread)), [
          finished({ status: "failed", errorCategory: "QuotaExhaustedError" }),
        ])
        yield* harness.until(
          Effect.sync(
            () =>
              harness.platform.statusTexts(slackThread)[0]?.includes("QuotaExhaustedError") ??
              false,
          ),
          "the status to give the category",
        )
        assert.deepStrictEqual(harness.platform.replies, [])
      }),
    ),
  )

  it.effect.fails("a session expires 30 days after its last message, and its storage goes", () =>
    test((harness) =>
      Effect.gen(function* () {
        // The 30-day default, shortened so the clock has less to step through.
        env["CHAT_SESSION_RETENTION_DAYS"] = "1"
        yield* firstTurn(harness, slackThread)
        yield* harness.wait("20 hours", "10 minutes")
        yield* send(harness, slackThread, "Thanks!")

        yield* harness.wait("20 hours", "10 minutes")
        assert.strictEqual((yield* harness.transcript(slackThread))._tag, "Available")
        assert.isNotEmpty(yield* harness.tables)

        yield* harness.wait("5 hours", "10 minutes")
        assert.deepStrictEqual(yield* harness.transcript(slackThread), { _tag: "Expired" })
        assert.deepStrictEqual(yield* harness.tables, [])
      }).pipe(Effect.ensuring(Effect.sync(() => delete env["CHAT_SESSION_RETENTION_DAYS"]))),
    ),
  )

  it.effect.fails(
    "delete stops the running turn, releases the sandbox and deletes the session's storage",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "My token is hunter2, use it.")
          yield* harness.remove(slackThread)
          yield* harness.until(
            Effect.sync(() => harness.sandboxes.releases.length === 1),
            "the sandbox release",
          )
          assert.deepStrictEqual(yield* harness.transcript(slackThread), { _tag: "Expired" })
          assert.deepStrictEqual(yield* harness.tables, [])
          // The stopped turn takes no further step.
          harness.sandboxes.finishScripts()
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)

          // A later message starts a new session.
          harness.sandboxes.hang = false
          const again = yield* send(harness, slackThread, "Start over.", { mention: true })
          yield* modelCalls(harness, 2)
          assert.notInclude(seen(harness.model.last), "hunter2")
          harness.model.answer(say("Starting over."))
          yield* turnEnded(harness, slackThread)
          assert.deepStrictEqual(stored(yield* harness.transcript(slackThread)), [
            [again.id, { _tag: "Mention" }],
          ])
        }),
      ),
  )

  it.effect.fails(
    "the kill switch stops a running turn, starts no new one and says so once per thread",
    () =>
      test((harness) =>
        Effect.gen(function* () {
          yield* longTurn(harness, slackThread, "Rebase every open PR.")
          harness.killSwitch.slack = true
          yield* harness.until(
            Effect.sync(
              () => harness.platform.statusTexts(slackThread)[0]?.includes("Stopped") ?? false,
            ),
            "the status to say Stopped",
          )

          yield* send(harness, slackThread, "Are you there?", { mention: true })
          yield* send(harness, slackThread, "Hello?", { mention: true })
          yield* harness.wait("10 seconds")
          assert.strictEqual(harness.model.prompts.length, 1)
          assert.deepStrictEqual(harness.platform.replies, [
            { thread: slackThread, text: switchedOffMessage },
          ])
          // Still stored as context.
          assert.strictEqual(available(yield* harness.transcript(slackThread)).messages.length, 3)

          // Only Slack is switched off.
          harness.sandboxes.hang = false
          yield* firstTurn(harness, discordThread)
          assert.deepStrictEqual(
            turns(yield* harness.transcript(slackThread)).map((turn) => turn.status),
            ["stopped"],
          )
        }),
      ),
  )

  it.effect.fails("a message delivered twice in a row is stored and acted on once", () =>
    test((harness) =>
      Effect.gen(function* () {
        const asked = yield* harness.message("Close stale issues.", { mention: true })
        yield* harness.deliver(slackThread, asked)
        yield* modelCalls(harness, 1)
        yield* harness.deliver(slackThread, asked)
        harness.model.answer(say("Closed 3."))
        yield* turnEnded(harness, slackThread)

        harness.gate.answer = 0
        const aside = yield* harness.message("Nice.")
        yield* harness.deliver(slackThread, aside)
        yield* harness.deliver(slackThread, aside)
        yield* harness.wait("10 seconds")

        assert.strictEqual(harness.model.prompts.length, 1)
        assert.strictEqual(harness.gate.inputs.length, 1)
        assert.strictEqual(harness.platform.replies.length, 1)
        const transcript = yield* harness.transcript(slackThread)
        assert.deepStrictEqual(
          available(transcript).messages.map((message) => message.id),
          [asked.id, aside.id],
        )
        assert.strictEqual(available(transcript).turns.length, 1)
      }),
    ),
  )

  it.effect.fails("racing deliveries of one message are stored and acted on once", () =>
    test((harness) =>
      Effect.gen(function* () {
        const asked = yield* harness.message("Close stale issues.", { mention: true })
        yield* harness.deliverTwiceAtOnce(slackThread, asked)
        yield* modelCalls(harness, 1)
        harness.model.answer(say("Closed 3."))
        yield* turnEnded(harness, slackThread)
        yield* harness.wait("10 seconds")

        assert.strictEqual(harness.model.prompts.length, 1)
        assert.strictEqual(harness.platform.replies.length, 1)
        const transcript = yield* harness.transcript(slackThread)
        assert.deepStrictEqual(
          available(transcript).messages.map((message) => message.id),
          [asked.id],
        )
        assert.strictEqual(available(transcript).turns.length, 1)
      }),
    ),
  )
})
